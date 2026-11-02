#!/usr/bin/env node
// dsh-peer-sync.mjs —— 经通道直连同步**文本**文件（件 text-sync-direct 的提炼）
//
// ── 为什么要有它（人话）───────────────────────────────────────────────────────
// 两台机器上的文档要互相同步时，最省事的做法是"全推过去"—— 那就等于**用本机覆盖对端**，
// 而对端自己也在产文档。所以它是**先比对、只传差量**，见 lib/sync-rules.mjs 的规则表：
// 本机更新的才传（覆盖前备份）、对端更新的绝不覆盖、判不了谁新的落冲突副本、**从不删除**。
//
// ── 三段式（为什么非得三段）───────────────────────────────────────────────────
//   A 本机出清单        ：遍历本地，产出 [{relPath,size,mtimeMs}]（先不算 sha，省 IO）
//   B 对端比对（只读）  ：把清单送到对端，对端 stat 一遍、算 sha，回差分
//   C 分批传 + 落位     ：只传"真要传"的，按 `--max-batch-bytes` 切批，对端按规则落位
// 一段干完所有事做不到"只增不删 + 不覆盖较新"，那两条正是这条工具的命。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node dsh-peer-sync.mjs plan                    # **干跑（默认）**：只算，不传、不写
//   node dsh-peer-sync.mjs plan --apply            # 真传 + 落位
//   node dsh-peer-sync.mjs plan --runner local --local-dir A --remote-dir B   # 夹具/演练
//   node dsh-peer-sync.mjs status                  # 只读：配置里的目录对
//
// 退出码：0 完成（含"无变化"）· 2 参数或配置错 · 3 让路（对端不可达 / 通道不通 —— 物理常态）· 1 真失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadConfig, resolveTilde } from './lib/config.mjs';
import { localRunner, sshRunner } from './lib/runner.mjs';
import { walkFiles, sha256File, stampOf, assertSafeRelPath, TEXT_EXTS, SKIP_DIRS } from './lib/files.mjs';
import { writePack, loadPack, chunkByBytes } from './lib/packfile.mjs';
import { classify, backupName, conflictName, hitsDualWrite, summarize, conflictAlreadyPresent, REASONS } from './lib/sync-rules.mjs';

const SELF = fileURLToPath(import.meta.url);
const INTERNAL = ['--internal-put', '--internal-get', '--internal-compare', '--internal-place', '--internal-tmpdir'];

const SPEC = {
  cmd: 'dsh-peer-sync',
  usage: 'node dsh-peer-sync.mjs <plan|status> [选项]',
  summary: '经通道直连同步文本文件：先比对、只传差量、从不删除（默认干跑）',
  commands: [
    { name: 'plan', desc: '算一轮同步计划（默认干跑；--apply 才真传）' },
    { name: 'status', desc: '只读：配置里的目录对与当前 runner' },
  ],
  flags: [
    { name: '--config', arg: 'PATH', desc: '配置文件路径（缺省 ~/.dsh-peer/peer-config.json）' },
    { name: '--apply', desc: '真传 + 落位（不加就是干跑）' },
    { name: '--pair', arg: 'NAME', desc: '只跑配置里的某一对目录（缺省全跑）' },
    { name: '--local-dir', arg: 'DIR', desc: '覆盖本地目录（演练/夹具用）' },
    { name: '--remote-dir', arg: 'DIR', desc: '覆盖对端目录（演练/夹具用）' },
    { name: '--remote-repo', arg: 'DIR', desc: '对端本仓所在路径（缺省取配置 sync.remoteRepoPath）' },
    { name: '--runner', arg: 'local|ssh', desc: '执行器：local=本机两个目录（演练），ssh=真跨机（缺省）' },
    { name: '--max-batch-bytes', arg: 'N', desc: '单批上限（字节，缺省 8 MB）' },
    { name: '--dual-write', arg: 'RE', desc: '双写黑名单正则（可重复；命中则永不覆盖）' },
    { name: '--tag', arg: 'NAME', desc: '冲突副本里的本方标识（缺省 self.name）' },
    { name: '--json', desc: '输出 JSON' },
  ],
  writes: '`plan --apply` 在对端目录里**新增/更新**文本文件，覆盖前写 `<名>.bak-<stamp>` 备份，冲突写 `<名>.conflict-<tag>-<stamp>`；**从不删除**。',
  dryRun: '默认就是干跑：A/B 真跑（只读），C 只出计划 —— 零传输、零写入。',
  exits: '0 完成（含无变化）· 2 参数或配置错 · 3 让路（对端不可达）· 1 真失败',
  examples: [
    'node dsh-peer-sync.mjs plan',
    'node dsh-peer-sync.mjs plan --apply --pair docs',
    'node dsh-peer-sync.mjs plan --runner local --local-dir ./a --remote-dir ./b',
  ],
  notes: [
    '🔴 **从不删除**目标文件；也不会反向覆盖"对端较新"的那一份。',
    '只同步文本扩展名（见 lib/files.mjs 的 TEXT_EXTS）；大二进制请用别的工具。',
  ],
};

// ── 内部子命令（对端跑的那一端）────────────────────────────────────────────────

function internalPut(dest) {
  const chunks = [];
  const stdin = process.stdin;
  stdin.on('data', (c) => chunks.push(c));
  stdin.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
      fs.writeFileSync(path.resolve(dest), buf);
      process.stderr.write(`put ok ${buf.length} bytes -> ${dest}\n`);
      process.exitCode = 0;
    } catch (e) {
      process.stderr.write(`put failed: ${e?.message ?? e}\n`);
      process.exitCode = 1;
    }
  });
  stdin.resume();
}

function internalGet(src) {
  try {
    const buf = fs.readFileSync(path.resolve(src));
    process.stdout.write(buf); // 二进制直出，不加任何修饰
    process.exitCode = 0;
  } catch (e) {
    process.stderr.write(`get failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
}

/** 对端：拿本机清单比一遍，回差分（只读，绝不写） */
function internalCompare(manifestPath, root, dualWritePatterns) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'));
  } catch (e) {
    process.stderr.write(`compare: 清单读不了：${e?.message ?? e}\n`);
    process.exitCode = 1;
    return;
  }
  const files = {};
  const conflictShas = {};
  for (const it of manifest.files ?? []) {
    const rel = assertSafeRelPath(it.relPath);
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // 对端没有
    }
    if (!st.isFile()) continue;
    let sha = null;
    // 只在"size 相同"时才值得算 sha（size 不同必然不是同一份）
    if (Number(st.size) === Number(it.size) && st.size <= 4 * 1024 * 1024) {
      try {
        sha = sha256File(abs);
      } catch {
        sha = null;
      }
    }
    // 顺带把同目录里已有冲突副本的 sha 收上来 —— 发件端据此判"这份冲突我落过了"
    let shas = [];
    try {
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      shas = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.conflict-`))
        .map((f) => {
          try {
            const p = path.join(dir, f);
            return fs.statSync(p).size <= 4 * 1024 * 1024 ? sha256File(p) : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      shas = [];
    }
    conflictShas[rel] = shas;
    files[rel] = { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: sha, dualWrite: hitsDualWrite(rel, dualWritePatterns) };
  }
  const out = { root, files, conflictShas, manifestCount: (manifest.files ?? []).length };
  process.stdout.write(JSON.stringify(out));
  process.exitCode = 0;
}

/** 对端：按规则落位（唯一会写文件的地方） */
function internalPlace(packPath, root, { tag, dryRun, dualWritePatterns = [] }) {
  let pack;
  try {
    pack = loadPack(fs.readFileSync(path.resolve(packPath)));
  } catch (e) {
    process.stderr.write(`place: 批次包坏了：${e?.message ?? e}\n`);
    process.exitCode = 1;
    return;
  }
  const stamp = stampOf();
  const rows = [];
  let wrote = 0;
  let skippedSame = 0;
  for (const it of pack.items) {
    const rel = assertSafeRelPath(it.relPath);
    const abs = path.join(root, rel);
    let remote = { exists: false };
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        let sha = null;
        if (Number(st.size) === Number(it.size) && st.size <= 4 * 1024 * 1024) {
          try {
            sha = sha256File(abs);
          } catch {
            sha = null;
          }
        }
        remote = { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: sha };
      }
    } catch {
      remote = { exists: false };
    }

    // ── 判决：优先用包里带来的 reason（发件端算好的那一份），缺失才在本地重算 ──
    // 不重算的理由：端到端 mtime 语境不同，重算会得出与发件端不同的结论（"这边判 skip、那边判 update"）。
    let c;
    if (it.reason && REASONS.includes(it.reason)) {
      c = {
        reason: it.reason,
        willWrite: !it.reason.startsWith('skip'),
        needsBackup: it.reason === 'update',
        conflictCopy: it.reason === 'conflict' || it.reason === 'dual-write-conflict',
        why: '随包判决（发件端算的，接收端不重算）',
      };
    } else {
      c = classify({ local: { size: it.size, mtimeMs: it.mtimeMs }, remote, localSha: it.sha256, dualWrite: hitsDualWrite(rel, dualWritePatterns) });
    }

    // ── 幂等短路：对端已有**完全相同内容** ⇒ 不写、不备份、不落冲突副本 ──
    // （否则重复 --apply 会在对端堆出 `.bak-*` / `.conflict-*` 垃圾）
    if (remote.exists && typeof remote.sha256 === 'string' && remote.sha256 === it.sha256) {
      skippedSame += 1;
      rows.push({ relPath: rel, reason: 'skip-same', wrote: false, backup: null, target: rel, why: '对端内容已与传入一致 ⇒ 幂等短路' });
      continue;
    }

    // ── 冲突副本第二道去重（发件端漏判时的兜底；也会挡并发两轮同时跑）──
    if (c.conflictCopy) {
      let dup = false;
      try {
        const dir = path.dirname(abs);
        const base = path.basename(abs);
        dup = fs
          .readdirSync(dir)
          .filter((f) => f.startsWith(`${base}.conflict-`))
          .some((f) => {
            try {
              const p = path.join(dir, f);
              return fs.statSync(p).size <= 4 * 1024 * 1024 && sha256File(p) === it.sha256;
            } catch {
              return false;
            }
          });
      } catch {
        dup = false;
      }
      if (dup) {
        skippedSame += 1;
        rows.push({ relPath: rel, reason: 'skip-conflict-exists', wrote: false, backup: null, target: rel, why: '对端已有同内容冲突副本 ⇒ 幂等短路' });
        continue;
      }
    }

    let target = abs;
    if (c.conflictCopy) target = path.join(root, conflictName(rel, tag, stamp));
    let backup = null;
    if (c.needsBackup && remote.exists && !dryRun) {
      backup = path.join(root, backupName(rel, stamp));
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(abs, backup); // 先备份再覆盖（备份不成功就别写）
    }
    if (c.willWrite && !dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, it.buffer);
      // 保留源 mtime，好让双方下一轮判"谁更新"时不失真
      if (it.mtimeMs) {
        try {
          const t = new Date(it.mtimeMs);
          fs.utimesSync(target, t, t);
        } catch {
          /* 改不动 mtime 不算失败 */
        }
      }
      wrote += 1;
    }
    rows.push({ relPath: rel, reason: c.reason, wrote: c.willWrite && !dryRun, backup: backup ? path.relative(root, backup).replace(/\\/g, '/') : null, target: c.conflictCopy ? path.relative(root, target).replace(/\\/g, '/') : rel });
  }
  process.stdout.write(JSON.stringify({ root, dryRun, received: pack.items.length, wrote, skippedSame, rows }));
  process.exitCode = 0;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function collectDualWrite(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dual-write' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) out.push(argv[i + 1]);
  }
  return out;
}

function pairsOf(cfg, flags) {
  const configured = Array.isArray(cfg?.sync?.pairs) && cfg.sync.pairs.length
    ? cfg.sync.pairs
    : [{ name: 'default', localDir: '~/dsh-peer-docs', remoteDir: '~/dsh-peer-docs' }];
  let pairs = configured;
  if (flags.pair) pairs = configured.filter((p) => p.name === flags.pair);
  if (flags['local-dir'] || flags['remote-dir']) {
    pairs = [{ name: flags.pair || 'override', localDir: flags['local-dir'], remoteDir: flags['remote-dir'] }];
  }
  return pairs.map((p) => ({
    name: p.name,
    localDir: p.localDir ? path.resolve(resolveTilde(p.localDir)) : null,
    remoteDir: p.remoteDir ? String(p.remoteDir) : null,
  }));
}

function makeRunner(cfg, flags) {
  const mode = flags.runner || 'ssh';
  if (mode === 'local') return { runner: localRunner(), mode, remoteTmp: os.tmpdir() };
  if (mode !== 'ssh') throw new Error(`--runner 只接受 local 或 ssh（收到 ${mode}）`);
  const runner = sshRunner(cfg, { flags, remoteScript: path.posix.join(String(flags['remote-repo'] || cfg?.sync?.remoteRepoPath || '.').replace(/\\/g, '/'), 'dsh-peer-sync.mjs') });
  return { runner, mode, remoteTmp: null };
}

async function runPair(cfg, flags, runner, pair, dualWrite, { apply, maxBatchBytes, tag }) {
  if (!pair.localDir || !pair.remoteDir) throw new Error(`目录对 ${pair.name} 缺 localDir / remoteDir`);
  if (!fs.existsSync(pair.localDir)) return { pair, skipped: true, why: `本地目录不存在：${pair.localDir}` };

  // 对端临时目录（local 模式直接 os.tmpdir；ssh 模式问对端要）
  const tmpDir = runner.remoteTmp || (() => {
    const r = runner.node(SELF, ['--internal-tmpdir']);
    if (r.code !== 0) return { ok: false, why: r.stderr || r.stdout };
    try {
      return JSON.parse(r.stdout).tmpdir;
    } catch {
      return null;
    }
  })();
  if (!tmpDir) return { pair, skipped: true, why: '拿不到对端临时目录（对端 node 不通？）', yield: true };

  // A 本机清单
  const files = walkFiles(pair.localDir, { textExts: TEXT_EXTS, skipDirs: SKIP_DIRS });
  const manifest = { v: 1, root: pair.localDir, createdAt: new Date().toISOString(), files };

  // B 对端比对
  const stampStr = Date.now().toString(36);
  const remoteManifest = path.join(String(tmpDir), `peer-manifest-${stampStr}.json`);
  const putM = runner.put(Buffer.from(JSON.stringify(manifest), 'utf8'), remoteManifest);
  if (putM.code !== 0) return { pair, skipped: true, why: `清单送不到对端：${putM.stderr.trim()}`, yield: true };
  const cmp = runner.node(SELF, ['--internal-compare', remoteManifest, '--root', pair.remoteDir, ...(dualWrite.length ? ['--dual-write', dualWrite.join('|')] : [])]);
  if (cmp.code !== 0) return { pair, skipped: true, why: `对端比对失败：${cmp.stderr.trim() || cmp.stdout.trim()}`, yield: true };
  let remoteInfo;
  try {
    remoteInfo = JSON.parse(cmp.stdout);
  } catch (e) {
    return { pair, skipped: true, why: `对端比对输出不是 JSON：${e.message}`, yield: true };
  }

  // 判决（规则只跑这一份）
  const rows = [];
  for (const f of files) {
    const remote = remoteInfo.files?.[f.relPath] ?? { exists: false };
    const dual = remoteInfo.files?.[f.relPath]?.dualWrite === true || hitsDualWrite(f.relPath, dualWrite);
    let localSha = null;
    // 需要 sha 的场合：① size 相同（判内容是否相同）② 可能要落冲突副本（判"落过没"）
    if (remote.exists && f.size <= 4 * 1024 * 1024) {
      try {
        localSha = sha256File(path.join(pair.localDir, f.relPath));
      } catch {
        localSha = null;
      }
    }
    const c = classify({ local: f, remote, localSha, dualWrite: dual });
    let reason = c.reason;
    let willWrite = c.willWrite;
    let conflictCopy = c.conflictCopy;
    let needsBackup = c.needsBackup;
    let why = c.why;
    // 冲突类：对端已经有**同内容**的冲突副本 ⇒ 不再传（否则每轮 --apply 都多堆一个）
    if ((reason === 'conflict' || reason === 'dual-write-conflict') && conflictAlreadyPresent(localSha, remoteInfo.conflictShas?.[f.relPath])) {
      reason = 'skip-conflict-exists';
      willWrite = false;
      conflictCopy = false;
      needsBackup = false;
      why = '对端已有同内容的冲突副本 ⇒ 本轮不再落（幂等）';
    }
    rows.push({ relPath: f.relPath, size: f.size, mtimeMs: f.mtimeMs, reason, willWrite, why, conflictCopy, needsBackup });
  }
  const sum = summarize(rows.map((r) => ({ classification: { reason: r.reason, willWrite: r.willWrite } })));
  const toSend = rows.filter((r) => r.willWrite);
  const sendBytes = toSend.reduce((a, r) => a + r.size, 0);

  const result = { pair, scanned: files.length, rows, summary: sum, sendBytes, batches: [], applied: false };

  if (!apply || !toSend.length) return result;

  // C 分批传 + 落位
  const items = [];
  for (const r of toSend) {
    try {
      items.push({ relPath: r.relPath, mtimeMs: r.mtimeMs, reason: r.reason, buffer: fs.readFileSync(path.join(pair.localDir, r.relPath)) });
    } catch (e) {
      result.batches.push({ error: `读不到本地文件 ${r.relPath}：${e.message}` });
    }
  }
  const { batches, oversized } = chunkByBytes(items, maxBatchBytes);
  if (oversized.length) result.oversized = oversized;
  let idx = 0;
  for (const batch of batches) {
    idx += 1;
    const packBuf = writePack(batch, { batchId: `${pair.name}-${stampStr}-${idx}` });
    const remotePack = path.join(String(tmpDir), `peer-pack-${stampStr}-${idx}.pack`);
    const put = runner.put(packBuf, remotePack);
    if (put.code !== 0) {
      result.batches.push({ index: idx, error: `批次送不到对端：${put.stderr.trim()}` });
      continue;
    }
    const place = runner.node(SELF, ['--internal-place', remotePack, '--root', pair.remoteDir, '--tag', tag]);
    if (place.code !== 0) {
      result.batches.push({ index: idx, error: `对端落位失败：${place.stderr.trim() || place.stdout.trim()}` });
      continue;
    }
    let placed;
    try {
      placed = JSON.parse(place.stdout);
    } catch {
      result.batches.push({ index: idx, error: '对端落位输出不是 JSON' });
      continue;
    }
    result.batches.push({ index: idx, files: batch.length, wrote: placed.wrote, rows: placed.rows });
  }
  result.applied = true;
  return result;
}

async function cmdPlan(flags, argv) {
  const { cfg, path: cfgPath } = loadConfig(flags);
  // 双写黑名单 = 配置 ∪ 命令行（配置里那份才是"长期口径"，命令行只是临时补）
  const dualWrite = [...new Set([...(Array.isArray(cfg?.sync?.dualWrite) ? cfg.sync.dualWrite : []), ...collectDualWrite(argv)])];
  const maxBatchBytes = Number(flags['max-batch-bytes']) > 0 ? Number(flags['max-batch-bytes']) : 8 * 1024 * 1024;
  const tag = flags.tag || cfg?.self?.name || 'this-side';
  const { runner, mode } = makeRunner(cfg, flags);
  const pairs = pairsOf(cfg, flags);

  const out = { configPath: cfgPath, runner: mode, apply: flags.apply === true, dualWrite, maxBatchBytes, pairs: [] };
  let yieldHappened = false;
  let failed = false;
  for (const pair of pairs) {
    try {
      const r = await runPair(cfg, flags, runner, pair, dualWrite, { apply: flags.apply === true, maxBatchBytes, tag });
      out.pairs.push(r);
      if (r.yield) yieldHappened = true;
      if (r.batches?.some((b) => b.error)) failed = true;
    } catch (e) {
      failed = true;
      out.pairs.push({ pair, error: String(e?.message ?? e) });
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return failed ? 1 : yieldHappened ? 3 : 0;
  }
  console.log(`── 文本同步${out.apply ? '（真跑：会写对端目录）' : '（干跑：只算，不传不写）'} ──`);
  console.log(`配置 ${cfgPath} · runner=${mode}${dualWrite.length ? ` · 双写黑名单 ${dualWrite.join(' | ')}` : ''}`);
  for (const r of out.pairs) {
    if (r.error) {
      console.log(`\n❌ ${r.pair?.name ?? '?'}：${r.error}`);
      continue;
    }
    if (r.skipped) {
      console.log(`\n⏭ ${r.pair.name}：${r.why}${r.yield ? '（让路）' : ''}`);
      continue;
    }
    const b = r.summary.byReason;
    console.log(`\n■ ${r.pair.name}  ${r.pair.localDir} → ${r.pair.remoteDir}`);
    console.log(`  扫到 ${r.scanned} 份 / 需传 ${r.summary.toSend} 份（≈ ${(r.sendBytes / 1024).toFixed(1)} KB）`);
    console.log(`  新增 ${b.new ?? 0} · 更新 ${b.update ?? 0} · 冲突副本 ${(b.conflict ?? 0) + (b['dual-write-conflict'] ?? 0)} · 跳过(相同) ${b['skip-same'] ?? 0} · 跳过(对端更新) ${b['skip-remote-newer'] ?? 0}`);
    console.log(`  会删除的文件数：${r.summary.wouldDelete}（本工具恒为 0）`);
    const interesting = r.rows.filter((x) => x.reason !== 'skip-same').slice(0, 20);
    for (const x of interesting) console.log(`    ${x.reason.padEnd(18)} ${x.relPath}`);
    if (r.rows.filter((x) => x.reason !== 'skip-same').length > 20) console.log('    …（只列前 20 条）');
    for (const bt of r.batches ?? []) {
      if (bt.error) console.log(`  ❌ 第 ${bt.index} 批：${bt.error}`);
      else console.log(`  ✅ 第 ${bt.index} 批：传 ${bt.files} 份，落位 ${bt.wrote} 份`);
    }
    if (r.oversized) console.log(`  ⚠️ 单份超过批次上限（各单独一批）：${r.oversized.join(', ')}`);
  }
  if (!out.apply) console.log('\n（加 --apply 才会真传；干跑零写入）');
  return failed ? 1 : yieldHappened ? 3 : 0;
}

function cmdStatus(flags) {
  const { cfg, path: cfgPath, existed } = loadConfig(flags);
  const pairs = pairsOf(cfg, flags);
  const out = { configPath: cfgPath, configExisted: existed, runnerDefault: 'ssh', remoteRepoPath: cfg?.sync?.remoteRepoPath ?? null, pairs };
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log('── 同步状态（只读）──');
  console.log(`配置              : ${cfgPath}${existed ? '' : '（不存在，用缺省值）'}`);
  console.log(`对端仓路径        : ${out.remoteRepoPath ?? '(未配)'}`);
  for (const p of pairs) console.log(`目录对 ${p.name.padEnd(10)}: ${p.localDir ?? '?'} → ${p.remoteDir ?? '?'}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  // 内部子命令优先（对端用；不打印用法、不执行任何其他动作）
  if (argv[0] === '--internal-tmpdir') {
    process.stdout.write(JSON.stringify({ tmpdir: os.tmpdir() }));
    return 0;
  }
  if (argv[0] === '--internal-put') {
    internalPut(argv[1]);
    return null; // 异步等 stdin
  }
  if (argv[0] === '--internal-get') {
    internalGet(argv[1]);
    return 0;
  }
  if (argv[0] === '--internal-compare') {
    internalCompare(argv[1], argv[argv.indexOf('--root') + 1], collectDualWrite(argv));
    return 0;
  }
  if (argv[0] === '--internal-place') {
    const dry = argv.includes('--dry-run');
    const ti = argv.indexOf('--tag');
    internalPlace(argv[1], argv[argv.indexOf('--root') + 1], { tag: ti > 0 ? argv[ti + 1] : 'peer', dryRun: dry, dualWritePatterns: collectDualWrite(argv) });
    return 0;
  }

  const clean = cliGuard(SPEC);
  const { flags, positional } = parseArgs(clean, SPEC);
  const cmd = positional[0];
  switch (cmd) {
    case 'plan': return await cmdPlan(flags, argv);
    case 'status': return cmdStatus(flags);
    default: {
      console.error(`错误：不认识的子命令 ${cmd ?? '(空)'}\n（运行 \`node dsh-peer-sync.mjs --help\` 看用法）`);
      return 2;
    }
  }
}

function isMainEntry() {
  try {
    const a = fs.realpathSync(SELF);
    const b = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return !!b && a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  try {
    const rc = await main();
    if (rc !== null) process.exitCode = rc;
  } catch (e) {
    console.error('❌ ' + String(e?.message ?? e));
    process.exitCode = 2;
  }
}
