#!/usr/bin/env node
// dsh-peer-agent.mjs —— 信箱的**执行端**（件 mailbox-agent 的提炼 · 跑在"对面"那台机器上）
//
// ── 它与 dsh-mailbox 的分工 ───────────────────────────────────────────────────
//   控制端（你的笔记本）  ：只"投"和"等"
//   执行端（常开的那台）  ：只"取"和"回执"
// 两者共用一把密钥和同一个 spool 目录，**没有心跳、没有长连接**：对面离线再久也不会丢信封。
//
// ── 🔴 与生产实现最要紧的一处差别：默认**不执行**命令 ───────────────────────────
// 生产的 agent 收到就执行（因为两端都是我自己的机器、信封是加密的）。开源版不能这么默认：
// 任何人都能把 spool 目录指向别处、往里面丢东西。所以本件：
//   · 没有 `--allow-exec` ⇒ exec 类信封一律**拒执行**，并如实回一条 `refused` 回执；
//   · 要执行必须由**机器的主人**显式加 `--allow-exec`（写在自己的调度命令里，不是藏在配置里）。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node dsh-peer-agent.mjs --once                    # 跑一轮（不执行命令，只回复执）
//   node dsh-peer-agent.mjs --once --allow-exec       # 跑一轮，允许执行 exec 类指令
//   node dsh-peer-agent.mjs --once --dry-run          # 只看有什么，不执行、也不回执
//   node dsh-peer-agent.mjs --status                  # 只读：配置 / 密钥 / spool 积压 / 最近日志
//   node dsh-peer-agent.mjs --self-test               # 自检：密钥能不能读、spool 能不能写
//   node dsh-peer-agent.mjs --loop 120 --allow-exec   # 每 120 秒一轮（**这是你自己选的常驻**，
//                                                     #   本仓不装服务、不注册计划任务）
//
// 退出码：0 正常（含"没有新信封"）· 1 有回执写失败或执行失败 · 2 参数或配置错误
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadConfig, resolveSpool, resolveKey, stateDir } from './lib/config.mjs';
import {
  INBOX,
  OUTBOX,
  DONE,
  REJECTED,
  DEFAULT_OUT_LIMIT,
  MAX_TIMEOUT_MS,
  loadKey,
  keyFingerprint,
  seal,
  unseal,
  ensureSpool,
  listEnvelopes,
  readEnvelope,
  moveEnvelope,
  writeEnvelope,
  cutStream,
  spoolStats,
} from './lib/envelope.mjs';

const SELFNAME = 'dsh-peer-agent';

const SPEC = {
  cmd: 'dsh-peer-agent',
  usage: 'node dsh-peer-agent.mjs [--once] [--allow-exec] [--dry-run] [--loop N] [--status] [--self-test]',
  summary: '信箱执行端：取信封 → （可选）执行 → 写回执。默认**不执行**命令',
  flags: [
    { name: '--once', desc: '跑一轮就退（缺省行为）' },
    { name: '--allow-exec', desc: '允许执行 exec 类信封（默认拒执行，只回一条 refused 回执）' },
    { name: '--dry-run', desc: '只列出待处理信封，不执行、不写回执、不搬文件' },
    { name: '--loop', arg: 'SEC', desc: '循环模式（秒），自己选的常驻；本仓不装服务' },
    { name: '--status', desc: '只读：配置 / 密钥 / spool 积压 / 最近日志' },
    { name: '--self-test', desc: '自检：密钥可读、spool 可写、shell 可定位' },
    { name: '--config', arg: 'PATH', desc: '配置文件路径（缺省 ~/.dsh-peer/peer-config.json）' },
    { name: '--spool', arg: 'DIR', desc: 'spool 目录（覆盖配置）' },
    { name: '--key', arg: 'FILE', desc: '密钥文件（覆盖配置）' },
    { name: '--shell', arg: 'PATH', desc: '执行用的 shell（Windows 缺省 cmd.exe，其它 /bin/sh）' },
    { name: '--json', desc: '输出 JSON' },
  ],
  writes: '把处理完的信封从 inbox 移到 done（解不开的移 rejected）；往 outbox 写回执；写 state/agent-*.jsonl 日志。',
  exits: '0 正常（含没有新信封）· 1 有回执写失败或执行失败 · 2 参数或配置错误',
  examples: [
    'node dsh-peer-agent.mjs --once --dry-run',
    'node dsh-peer-agent.mjs --once --allow-exec',
    'node dsh-peer-agent.mjs --status',
  ],
  notes: [
    '🔴 默认不执行命令。要执行请把 `--allow-exec` 写进你自己的调度命令里 —— 那是"人确认过"的形态。',
    '本件不装服务、不注册计划任务、不建立持久连接。要不要周期跑，是你系统层面的事。',
  ],
};

function ctx(flags) {
  const { cfg, existed, path: cfgPath } = loadConfig(flags);
  const spool = flags.spool ? path.resolve(flags.spool) : resolveSpool(cfg);
  const keyPath = flags.key ? path.resolve(flags.key) : resolveKey(cfg);
  return { cfg, existed, cfgPath, spool, keyPath };
}

function logLine(flags, obj) {
  try {
    const dir = stateDir(flags);
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const s = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    fs.appendFileSync(path.join(dir, `agent-${s}.jsonl`), JSON.stringify({ ts: d.toISOString(), ...obj }) + '\n', 'utf8');
  } catch {
    /* 日志失败不阻断 */
  }
}

function shellOf(flags) {
  if (typeof flags.shell === 'string') return { exe: flags.shell, argsFor: (cmd) => ['-c', cmd] };
  if (process.platform === 'win32') return { exe: process.env.COMSPEC || 'cmd.exe', argsFor: (cmd) => ['/d', '/s', '/c', cmd] };
  return { exe: '/bin/sh', argsFor: (cmd) => ['-c', cmd] };
}

function runCommand(cmd, { cwd, timeoutMs, shell }) {
  const args = shell.argsFor(cmd);
  const r = spawnSync(shell.exe, args, {
    encoding: 'utf8',
    timeout: Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), MAX_TIMEOUT_MS),
    cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return {
    exitCode: r.status ?? null,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '') + (r.error ? `\n[spawn error] ${r.error.message}` : ''),
    timedOut: r.error?.code === 'ETIMEDOUT' || (r.status === null && !!r.error),
  };
}

/** 处理一条信封。返回 `{ id, kind, ok, refused?, movedTo }` */
function processOne(flags, c, env) {
  const { cfg, spool } = c;
  const inboxDir = path.join(spool, INBOX);
  const outboxDir = path.join(spool, OUTBOX);
  const startedAt = new Date().toISOString();
  const selfName = cfg?.self?.name ?? null;

  let body;
  try {
    body = unseal(readEnvelope(inboxDir, env.id), env.key);
  } catch (e) {
    // 解不开 ⇒ 拒收（GCM 认证失败就是"不是我们发的、或被改过"）
    const mv = moveEnvelope(inboxDir, path.join(spool, REJECTED), env.id);
    logLine(flags, { action: 'rejected', id: env.id, why: String(e?.message ?? e) });
    return { id: env.id, ok: false, rejected: true, why: String(e?.message ?? e), movedTo: mv.to };
  }

  // 收件人不匹配 ⇒ 不碰（同一个 spool 可能服务多台机器）
  if (body.to && selfName && body.to !== selfName) {
    logLine(flags, { action: 'skip-other', id: env.id, to: body.to, self: selfName });
    return { id: env.id, ok: null, skipped: true, why: `收件人是 ${body.to}，本机是 ${selfName}` };
  }

  if (flags['dry-run'] === true) {
    return { id: env.id, ok: null, preview: true, kind: body.kind, payload: body.kind === 'exec' ? body.cmd : body.text };
  }

  let receipt;
  if (body.kind === 'exec') {
    if (flags['allow-exec'] !== true) {
      receipt = {
        v: 1,
        id: env.id,
        kind: 'exec',
        ok: false,
        refused: '本端没开 --allow-exec：拒执行任何命令（这是默认，也是本仓的设计）',
        exitCode: null,
        from: selfName,
        host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
        startedAt,
        endedAt: new Date().toISOString(),
      };
    } else {
      const shell = shellOf(flags);
      const r = runCommand(body.cmd, { cwd: body.cwd, timeoutMs: body.timeoutMs, shell });
      const so = cutStream(r.stdout, DEFAULT_OUT_LIMIT);
      const se = cutStream(r.stderr, DEFAULT_OUT_LIMIT);
      receipt = {
        v: 1,
        id: env.id,
        kind: 'exec',
        ok: r.exitCode === 0,
        exitCode: r.exitCode,
        timedOut: r.timedOut || false,
        from: selfName,
        host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
        startedAt,
        endedAt: new Date().toISOString(),
        stdoutTail: so.text,
        stderrTail: se.text,
        stdoutTruncated: so.truncated,
        stderrTruncated: se.truncated,
        stdoutBytes: so.bytes,
        stderrBytes: se.bytes,
      };
    }
  } else {
    receipt = {
      v: 1,
      id: env.id,
      kind: 'text',
      ok: true,
      from: selfName,
      host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
      startedAt,
      endedAt: new Date().toISOString(),
      reply: '已接收（text 类信封不会执行任何东西）',
    };
  }

  writeEnvelope(outboxDir, env.id, seal(receipt, env.key));
  const mv = moveEnvelope(inboxDir, path.join(spool, DONE), env.id);
  logLine(flags, { action: 'handled', id: env.id, kind: body.kind, ok: receipt.ok, refused: !!receipt.refused, exitCode: receipt.exitCode ?? null });
  return { id: env.id, ok: receipt.ok, refused: !!receipt.refused, kind: body.kind, exitCode: receipt.exitCode ?? null, movedTo: mv.to };
}

function runRound(flags) {
  const c = ctx(flags);
  ensureSpool(c.spool);
  let key;
  try {
    key = loadKey(c.keyPath);
  } catch (e) {
    console.error(`⛔ ${e?.message ?? e}`);
    console.error('   把控制端那把 mailbox.key 安全地放到本机的 mailbox.keyPath（两端必须同一把）。');
    return { code: 2, result: { error: String(e?.message ?? e) } };
  }
  const inboxDir = path.join(c.spool, INBOX);
  const ids = listEnvelopes(inboxDir);
  const handled = [];
  let bad = 0;
  for (const id of ids) {
    try {
      const r = processOne(flags, c, { id, key });
      if (r.ok === false) bad += 1;
      handled.push(r);
    } catch (e) {
      bad += 1;
      handled.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  const result = {
    spool: c.spool,
    scanned: ids.length,
    handled,
    stats: spoolStats(c.spool),
    allowExec: flags['allow-exec'] === true,
    dryRun: flags['dry-run'] === true,
    self: c.cfg?.self?.name ?? null,
  };
  return { code: bad > 0 ? 1 : 0, result };
}

function cmdStatus(flags) {
  const c = ctx(flags);
  let fp = null;
  let keyErr = null;
  try {
    fp = keyFingerprint(loadKey(c.keyPath));
  } catch (e) {
    keyErr = String(e?.message ?? e);
  }
  const stats = spoolStats(c.spool);
  const out = { self: c.cfg?.self?.name ?? null, configPath: c.cfgPath, configExisted: c.existed, spool: c.spool, keyPath: c.keyPath, keyFingerprint: fp, keyError: keyErr, stats, stateDir: stateDir(flags) };
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return keyErr ? 2 : 0;
  }
  console.log('── 信箱执行端状态（只读）──');
  console.log(`本机名            : ${out.self ?? '(未配 self.name)'}`);
  console.log(`配置              : ${c.cfgPath}${c.existed ? '' : '（不存在，用缺省值）'}`);
  console.log(`spool             : ${c.spool}`);
  console.log(`密钥              : ${keyErr ? `❌ ${keyErr}` : `✅ 指纹 ${fp}`}`);
  console.log(`积压              : inbox ${stats.inbox} · outbox ${stats.outbox} · done ${stats.done} · rejected ${stats.rejected}`);
  console.log(`日志目录          : ${out.stateDir}`);
  return keyErr ? 2 : 0;
}

function cmdSelfTest(flags) {
  const c = ctx(flags);
  const checks = [];
  let key = null;
  try {
    key = loadKey(c.keyPath);
    checks.push({ name: '密钥可读', ok: true, detail: `指纹 ${keyFingerprint(key)}` });
  } catch (e) {
    checks.push({ name: '密钥可读', ok: false, detail: String(e?.message ?? e) });
  }
  try {
    ensureSpool(c.spool);
    const probe = path.join(c.spool, REJECTED, `.selftest-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    checks.push({ name: 'spool 可写', ok: true, detail: c.spool });
  } catch (e) {
    checks.push({ name: 'spool 可写', ok: false, detail: String(e?.message ?? e) });
  }
  const shell = shellOf(flags);
  checks.push({ name: 'shell 可定位', ok: fs.existsSync(shell.exe) || shell.exe === 'cmd.exe', detail: shell.exe });
  checks.push({ name: '当前是否允许执行', ok: true, detail: flags['allow-exec'] === true ? '是（本次带 --allow-exec）' : '否（默认；exec 信封只会收到 refused 回执）', warnOnly: true });
  const ok = checks.every((x) => x.ok || x.warnOnly);
  if (flags.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }
  console.log('── 自检（不碰远端、不发信封）──');
  for (const x of checks) console.log(`${x.ok ? '✅' : x.warnOnly ? '⚠️' : '❌'} ${x.name}：${x.detail}`);
  console.log(ok ? '\n判定：✅ 通过' : '\n判定：❌ 有失败项');
  return ok ? 0 : 1;
}

async function main() {
  const argv = cliGuard(SPEC);
  const { flags } = parseArgs(argv, SPEC);
  if (flags.status === true) return cmdStatus(flags);
  if (flags['self-test'] === true) return cmdSelfTest(flags);

  const loopSec = Number(flags.loop);
  if (Number.isFinite(loopSec) && loopSec > 0) {
    console.log(`ℹ 循环模式：每 ${loopSec} 秒一轮（Ctrl+C 退出；本仓不装服务）。`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { code, result } = runRound(flags);
      if (flags.json) console.log(JSON.stringify(result));
      else console.log(`[${new Date().toISOString()}] 扫到 ${result.scanned} 条，处理 ${result.handled.length} 条，rc=${code}`);
      await new Promise((r) => setTimeout(r, loopSec * 1000));
    }
  }

  const { code, result } = runRound(flags);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return code;
  }
  console.log(`── 信箱执行端（一轮）──`);
  console.log(`本机名            : ${result.self ?? '(未配)'} · spool ${result.spool}`);
  console.log(`本轮扫到          : ${result.scanned} 条${result.dryRun ? '（干跑：不执行、不回执、不搬文件）' : ''}`);
  for (const h of result.handled) {
    if (h.preview) {
      console.log(`  👀 ${h.id}  ${h.kind}：${String(h.payload).replace(/\s+/g, ' ').slice(0, 120)}`);
    } else if (h.skipped) {
      console.log(`  ⏭ ${h.id}  跳过：${h.why}`);
    } else if (h.rejected) {
      console.log(`  ⛔ ${h.id}  拒收：${h.why}`);
    } else {
      console.log(`  ${h.ok ? '✅' : '❌'} ${h.id}  ${h.kind ?? ''}${h.refused ? '（拒执行，已回执）' : ''}${h.exitCode !== null && h.exitCode !== undefined ? ` exit=${h.exitCode}` : ''}`);
    }
  }
  if (!result.handled.length) console.log('（没有新信封）');
  console.log(`处理后积压        : inbox ${result.stats.inbox} · outbox ${result.stats.outbox} · done ${result.stats.done}`);
  if (!result.allowExec && result.handled.some((h) => h.refused)) {
    console.log('⚠️ 本轮有 exec 信封被拒执行 —— 要真执行请在调度命令里加 --allow-exec。');
  }
  return code;
}

function isMainEntry() {
  try {
    const a = fs.realpathSync(fileURLToPath(import.meta.url));
    const b = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return !!b && a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error('❌ ' + String(e?.message ?? e));
    process.exitCode = 2;
  }
}
