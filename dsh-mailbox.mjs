#!/usr/bin/env node
// dsh-mailbox.mjs —— 跨机投递消息 / 下发命令 + 收回执（件 mailbox-cli 的提炼 · 控制端）
//
// ── 它解决什么 ────────────────────────────────────────────────────────────────
// 两台机器之间**不需要同时在线**也能协作：一方把信封丢进 spool 目录，另一方的 agent
// 醒来取走、执行、把回执写回去。介质只负责"把目录搬过去"（共享盘 / 私有仓 / 本仓的
// dsh-peer-sync），本件不关心用哪种。
//
// ── 信封是加密的（为什么值得多这一步）──────────────────────────────────────────
// 中转介质往往是"我们控制不住的那一段"（云盘 / 别人能读的仓）。加密 + GCM 认证 ⇒
// ① 介质里没有明文；② 没有密钥的人**改一个字节就解不开**，伪造不出可执行指令。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node dsh-mailbox.mjs keygen [--force]              # 生成/复用 32 字节密钥
//   node dsh-mailbox.mjs status                        # 只读：密钥指纹 / spool 积压
//   node dsh-mailbox.mjs send --text "一句话"           # 投一条**纯消息**（对端不执行任何东西）
//   node dsh-mailbox.mjs send --cmd "命令" [--wait]     # 投一条**要执行**的指令（对端需 --allow-exec）
//   node dsh-mailbox.mjs wait <id> [--wait-sec N]      # 等某一条的回执
//   node dsh-mailbox.mjs results [--take]              # 列回执（--take 移进 done/）
//   node dsh-mailbox.mjs inbox                         # 列还没被取走的请求
//
// 退出码：0 成功 · 1 回执 ok=false / 超时 · 2 参数或配置错 · 4 等不到回执
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadConfig, resolveSpool, resolveKey, assertConfig } from './lib/config.mjs';
import {
  INBOX,
  OUTBOX,
  DONE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  generateKey,
  loadKey,
  keyFingerprint,
  seal,
  unseal,
  newId,
  spoolStats,
  ensureSpool,
  writeEnvelope,
  listEnvelopes,
  readEnvelope,
  moveEnvelope,
  cutStream,
  envelopePath,
} from './lib/envelope.mjs';

const SPEC = {
  cmd: 'dsh-mailbox',
  usage: 'node dsh-mailbox.mjs <keygen|status|send|wait|results|inbox> [选项]',
  summary: '跨机投递消息 / 下发命令 + 收回执（信封加密；spool 目录怎么到对面由你选）',
  commands: [
    { name: 'keygen', desc: '生成 32 字节对称密钥（两端必须用同一把）' },
    { name: 'status', desc: '只读：密钥指纹 / spool 各目录积压' },
    { name: 'send', desc: '投一条信封：--text（纯消息）或 --cmd（要执行）' },
    { name: 'wait', desc: '等某条 id 的回执' },
    { name: 'results', desc: '列回执（--take 取走并移进 done/）' },
    { name: 'inbox', desc: '列还没被取走的请求' },
  ],
  flags: [
    { name: '--config', arg: 'PATH', desc: '配置文件路径（缺省 ~/.dsh-peer/peer-config.json）' },
    { name: '--spool', arg: 'DIR', desc: 'spool 目录（覆盖配置里的 mailbox.spoolDir）' },
    { name: '--key', arg: 'FILE', desc: '密钥文件（覆盖配置里的 mailbox.keyPath）' },
    { name: '--text', arg: 'TEXT', desc: 'send：投一条纯消息' },
    { name: '--cmd', arg: 'CMD', desc: 'send：投一条要执行的指令（对端 agent 需 --allow-exec）' },
    { name: '--cwd', arg: 'DIR', desc: 'send --cmd：对端执行时的工作目录' },
    { name: '--timeout', arg: 'SEC', desc: 'send --cmd：对端执行超时（秒，上限 600）' },
    { name: '--wait', desc: 'send：投完就等回执' },
    { name: '--wait-sec', arg: 'N', desc: '等回执的最长秒数（缺省 120）' },
    { name: '--take', desc: 'results：把列出的回执移进 done/' },
    { name: '--force', desc: 'keygen：覆盖已有密钥（**旧密钥作废，对端必须同步换**）' },
    { name: '--json', desc: '输出 JSON' },
  ],
  writes: 'keygen 写密钥文件（0600）；send 写 spool/inbox；results --take 把信封移到 spool/done。',
  exits: '0 成功 · 1 回执 ok=false / 执行失败 · 2 参数或配置错误 · 4 等不到回执',
  examples: [
    'node dsh-mailbox.mjs keygen',
    'node dsh-mailbox.mjs send --text "在吗" --wait',
    'node dsh-mailbox.mjs send --cmd "node --version" --wait',
  ],
  notes: [
    '两端必须用**同一把密钥**；keygen --force 会让旧信封全部解不开。',
    '本件只负责"投"和"等"；**执行**的是对端的 dsh-peer-agent.mjs，它默认拒执行（要 --allow-exec）。',
  ],
};

function ctx(flags) {
  const { cfg, existed, path: cfgPath } = loadConfig(flags);
  const spool = flags.spool ? path.resolve(flags.spool) : resolveSpool(cfg);
  const keyPath = flags.key ? path.resolve(flags.key) : resolveKey(cfg);
  return { cfg, cfgPath, existed, spool, keyPath };
}

function cmdKeygen(flags) {
  const { cfg, keyPath } = ctx(flags);
  const r = generateKey(keyPath, flags.force === true);
  if (flags.json) {
    console.log(JSON.stringify({ ...r, self: cfg?.self?.name ?? null }, null, 2));
    return 0;
  }
  console.log(r.created ? `✅ 已生成密钥：${r.keyPath}` : `ℹ 密钥已存在，复用：${r.keyPath}`);
  console.log(`   指纹 ${r.fingerprint}（把**同一份密钥文件**安全地放到对端的 mailbox.keyPath）`);
  console.log('   ⚠️ 两端密钥必须一致；用 --force 重建会让旧信封全部解不开。');
  return 0;
}

function cmdStatus(flags) {
  const { cfg, cfgPath, existed, spool, keyPath } = ctx(flags);
  let fp = null;
  let keyErr = null;
  try {
    fp = keyFingerprint(loadKey(keyPath));
  } catch (e) {
    keyErr = String(e?.message ?? e);
  }
  const stats = spoolStats(spool);
  const out = { configPath: cfgPath, configExisted: existed, self: cfg?.self?.name ?? null, peer: cfg?.peer?.name ?? null, spool, keyPath, keyFingerprint: fp, keyError: keyErr, stats };
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return keyErr ? 2 : 0;
  }
  console.log('── 信箱状态（只读）──');
  console.log(`配置              : ${cfgPath}${existed ? '' : '（不存在，用缺省值）'}`);
  console.log(`本机 / 对端名     : ${out.self} → ${out.peer}`);
  console.log(`spool 目录        : ${spool}`);
  console.log(`密钥              : ${keyErr ? `❌ ${keyErr}` : `✅ 指纹 ${fp}`}`);
  console.log(`积压              : inbox ${stats.inbox} · outbox ${stats.outbox} · done ${stats.done} · rejected ${stats.rejected}`);
  return keyErr ? 2 : 0;
}

async function waitForReceipt(spool, id, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  const outPath = envelopePath(path.join(spool, OUTBOX), id);
  do {
    if (fs.existsSync(outPath)) return true;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return fs.existsSync(outPath);
}

async function cmdSend(flags) {
  const { cfg, spool, keyPath } = ctx(flags);
  const chk = assertConfig(cfg);
  if (!chk.ok) {
    console.error(`⛔ 配置不合法：\n  - ${chk.problems.join('\n  - ')}`);
    return 2;
  }
  const isText = typeof flags.text === 'string';
  const isCmd = typeof flags.cmd === 'string';
  if (isText === isCmd) {
    console.error('错误：send 要给 **且只给** 一个 —— `--text "消息"` 或 `--cmd "命令"`');
    return 2;
  }
  let key;
  try {
    key = loadKey(keyPath);
  } catch (e) {
    console.error(`⛔ ${e?.message ?? e}`);
    console.error('   先跑 `node dsh-mailbox.mjs keygen`，并把同一份密钥放到对端。');
    return 2;
  }
  ensureSpool(spool);
  const timeoutSec = Number(flags.timeout);
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(Math.trunc(timeoutSec * 1000), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const id = newId(isCmd ? 'c' : 't');
  const body = {
    v: 1,
    id,
    kind: isCmd ? 'exec' : 'text',
    from: cfg?.self?.name ?? null,
    to: cfg?.peer?.name ?? null,
    createdAt: new Date().toISOString(),
    cwd: isCmd && typeof flags.cwd === 'string' ? flags.cwd : null,
    timeoutMs,
    cmd: isCmd ? flags.cmd : null,
    text: isText ? flags.text : null,
  };
  if (Buffer.byteLength(String(body.cmd ?? body.text), 'utf8') > 512 * 1024) {
    console.error('错误：单条内联负载超 512 KB —— 大文件请走 dsh-peer-sync，别塞进信封。');
    return 2;
  }
  const file = writeEnvelope(path.join(spool, INBOX), id, seal(body, key));
  const sent = { id, kind: body.kind, file, spool };

  if (flags.wait !== true) {
    if (flags.json) console.log(JSON.stringify({ sent, waited: false }, null, 2));
    else {
      console.log(`📮 已投递（不等回执）：${id}`);
      console.log(`   ${body.kind === 'exec' ? `命令：${body.cmd}` : `消息：${body.text}`}`);
      console.log(`   落点：${file}`);
      console.log(`   等回执：node dsh-mailbox.mjs wait ${id} --wait-sec 180`);
    }
    return 0;
  }

  const waitSec = Number(flags['wait-sec']) > 0 ? Number(flags['wait-sec']) : 120;
  const got = await waitForReceipt(spool, id, waitSec);
  if (!got) {
    if (flags.json) console.log(JSON.stringify({ sent, waited: true, receipt: null, timeoutSec: waitSec }, null, 2));
    else {
      console.error(`⏰ ${waitSec} 秒内没等到回执（id=${id}）。`);
      console.error('   对端可能在离线 / agent 没在跑 / spool 目录还没同步过去。');
      console.error(`   之后可以用：node dsh-mailbox.mjs wait ${id} --wait-sec 180`);
    }
    return 4;
  }
  const receiptText = readEnvelope(path.join(spool, OUTBOX), id);
  let receipt;
  try {
    receipt = unseal(receiptText, key);
  } catch (e) {
    console.error(`⛔ 回执解不开（${e?.message ?? e}）—— 两端密钥是不是不一致？`);
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify({ sent, waited: true, receipt }, null, 2));
    return receipt.ok === false ? 1 : 0;
  }
  console.log(`📬 收到回执：${id}`);
  console.log(`   对端执行处：${receipt.host ?? '(未记录)'} · ${receipt.startedAt ?? ''} → ${receipt.endedAt ?? ''}`);
  if (receipt.kind === 'exec') {
    console.log(`   结果：${receipt.ok ? '✅ ok' : '❌ 失败'}（exit=${receipt.exitCode ?? 'n/a'}）`);
    if (receipt.refused) console.log(`   拒绝原因：${receipt.refused}`);
    if (receipt.stdoutTail) console.log(`── stdout${receipt.stdoutTruncated ? '（截断）' : ''} ──\n${receipt.stdoutTail.replace(/\s+$/, '')}`);
    if (receipt.stderrTail) console.log(`── stderr${receipt.stderrTruncated ? '（截断）' : ''} ──\n${receipt.stderrTail.replace(/\s+$/, '')}`);
  } else {
    console.log(`   回执正文：${receipt.reply ?? '(空)'}`);
  }
  return receipt.ok === false ? 1 : 0;
}

async function cmdWait(flags, id) {
  const { spool, keyPath } = ctx(flags);
  if (!id) {
    console.error('错误：wait 要带信封 id');
    return 2;
  }
  const waitSec = Number(flags['wait-sec']) > 0 ? Number(flags['wait-sec']) : 120;
  const got = await waitForReceipt(spool, id, waitSec);
  if (!got) {
    console.error(`⏰ ${waitSec} 秒内没等到回执（id=${id}）`);
    return 4;
  }
  const receipt = unseal(readEnvelope(path.join(spool, OUTBOX), id), loadKey(keyPath));
  if (flags.json) console.log(JSON.stringify({ id, receipt }, null, 2));
  else console.log(JSON.stringify(receipt, null, 2));
  return receipt.ok === false ? 1 : 0;
}

function cmdResults(flags) {
  const { spool, keyPath } = ctx(flags);
  let key;
  try {
    key = loadKey(keyPath);
  } catch (e) {
    console.error(`⛔ ${e?.message ?? e}`);
    return 2;
  }
  const ids = listEnvelopes(path.join(spool, OUTBOX));
  const rows = [];
  for (const id of ids) {
    let r;
    try {
      r = unseal(readEnvelope(path.join(spool, OUTBOX), id), key);
    } catch (e) {
      rows.push({ id, ok: null, error: String(e?.message ?? e) });
      continue;
    }
    rows.push({ id, ok: r.ok, kind: r.kind, exitCode: r.exitCode ?? null, host: r.host ?? null, endedAt: r.endedAt ?? null });
    if (flags.take === true) moveEnvelope(path.join(spool, OUTBOX), path.join(spool, DONE), id);
  }
  if (flags.json) {
    console.log(JSON.stringify({ spool, took: flags.take === true, rows }, null, 2));
    return 0;
  }
  console.log(`── 回执（${rows.length} 条）${flags.take === true ? ' · 已移进 done/' : ''} ──`);
  if (!rows.length) console.log('（空）');
  for (const r of rows) {
    console.log(`${r.ok === true ? '✅' : r.ok === false ? '❌' : '⚠️'} ${r.id}  ${r.kind ?? ''} ${r.exitCode !== null ? `exit=${r.exitCode}` : ''} ${r.host ?? ''} ${r.error ? `解不开：${r.error}` : ''}`);
  }
  return 0;
}

function cmdInbox(flags) {
  const { spool } = ctx(flags);
  const ids = listEnvelopes(path.join(spool, INBOX));
  if (flags.json) {
    console.log(JSON.stringify({ spool, ids }, null, 2));
    return 0;
  }
  console.log(`── 待取请求（${ids.length} 条）──`);
  if (!ids.length) console.log('（空）');
  for (const id of ids) console.log(`  ${id}`);
  return 0;
}

async function main() {
  const argv = cliGuard(SPEC);
  const { flags, positional } = parseArgs(argv, SPEC);
  const cmd = positional[0];
  switch (cmd) {
    case 'keygen': return cmdKeygen(flags);
    case 'status': return cmdStatus(flags);
    case 'send': return await cmdSend(flags);
    case 'wait': return await cmdWait(flags, positional[1]);
    case 'results': return cmdResults(flags);
    case 'inbox': return cmdInbox(flags);
    default: {
      console.error(`错误：不认识的子命令 ${cmd ?? '(空)'}\n（运行 \`node dsh-mailbox.mjs --help\` 看用法）`);
      return 2;
    }
  }
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
