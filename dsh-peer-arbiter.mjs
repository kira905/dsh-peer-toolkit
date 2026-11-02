#!/usr/bin/env node
// dsh-peer-arbiter.mjs —— 选路：这次走内网还是走隧道（件 net-arbiter 的提炼）
//
// ── 它只做两件事 ──────────────────────────────────────────────────────────────
//   ① **观察**：内网直连通不通、隧道本地端口在不在听（都只读，1 秒级）；
//   ② **判决**：把观测交给 lib/decide.mjs 那个纯函数，得出一条动作 —— 并按动作调隧道。
//
// ── 为什么判决单独一个文件 ────────────────────────────────────────────────────
// 见 lib/decide.mjs 头部：混进副作用就没法做夹具。本文件是"薄壳"：
// 观测 → 判决 → 执行，**判据一行都不复制**（夹具验的是同一份 decideRoute）。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node dsh-peer-arbiter.mjs decide                 # 干跑（默认）：只算不动
//   node dsh-peer-arbiter.mjs decide --apply         # 真动（该起就起、该关就关）
//   node dsh-peer-arbiter.mjs status                 # 只读：档位 / 观测 / 最近一次判决
//
// 退出码：0 正常（含"什么都不做"）· 2 参数或配置错 · 4 执行隧道动作失败
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadConfig, assertConfig, routeStatePath } from './lib/config.mjs';
import { tcpProbe } from './lib/net.mjs';
import { decideRoute, decideStatePatch, routeEndpoint } from './lib/decide.mjs';
import { negotiate } from './lib/profile.mjs';

const SELF = fileURLToPath(import.meta.url);
const TUNNEL_CLI = path.join(path.dirname(SELF), 'dsh-peer-tunnel.mjs');

const SPEC = {
  cmd: 'dsh-peer-arbiter',
  usage: 'node dsh-peer-arbiter.mjs <decide|status> [选项]',
  summary: '选路判决：内网直连通就走内网，不通就起隧道（判决是纯函数，见 lib/decide.mjs）',
  commands: [
    { name: 'decide', desc: '算一次：观测 → 判决 → 打印动作（默认干跑，--apply 才真动隧道）' },
    { name: 'status', desc: '只读：档位 / 上次判决 / 当前观测' },
  ],
  flags: [
    { name: '--config', arg: 'PATH', desc: '配置文件路径（缺省 ~/.dsh-peer/peer-config.json）' },
    { name: '--apply', desc: '真执行判决给出的隧道动作（不加只打印）' },
    { name: '--confirm-rounds', arg: 'N', desc: '收缩迟滞轮数（连续几轮不需要隧道才关，缺省 2）' },
    { name: '--json', desc: '输出 JSON' },
  ],
  writes: '`decide --apply` 可能起/停 ssh 隧道进程；每次判决写 state/route-state.json（迟滞计数）。',
  exits: '0 正常（含什么都不做）· 2 参数或配置错误 · 4 隧道动作失败',
  examples: ['node dsh-peer-arbiter.mjs decide', 'node dsh-peer-arbiter.mjs decide --apply --json'],
  notes: ['一次性进程：本仓不装计划任务、不起守护。要周期跑，用你系统自己的调度（README §6）。'],
};

function readState(flags) {
  const p = routeStatePath(flags);
  if (!fs.existsSync(p)) return { path: p, state: {} };
  try {
    return { path: p, state: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return { path: p, state: {}, corrupt: true };
  }
}

function writeState(flags, patch) {
  const p = routeStatePath(flags);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(patch, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/** 观测：两个探活都是"只连一下就断"，不发业务字节 */
async function observe(cfg) {
  const lanHost = cfg?.peer?.lanHost;
  const lanPort = Number(cfg?.peer?.lanPort);
  const localPort = Number(cfg?.tunnel?.localPort);
  let lanReachable = null;
  if (lanHost && Number.isFinite(lanPort)) {
    lanReachable = await tcpProbe(lanHost, lanPort, 1500);
  }
  const tunnelListening = await tcpProbe('127.0.0.1', localPort, 800);
  return { lanReachable, tunnelListening, lanHost: lanHost ?? null, lanPort: Number.isFinite(lanPort) ? lanPort : null, localPort };
}

function callTunnel(verb) {
  const r = spawnSync(process.execPath, [TUNNEL_CLI, verb, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

async function cmdDecide(flags) {
  const { cfg, path: cfgPath } = loadConfig(flags);
  const chk = assertConfig(cfg);
  if (!chk.ok) {
    console.error(`⛔ 配置不合法（${cfgPath}）：\n  - ${chk.problems.join('\n  - ')}`);
    return 2;
  }
  const neg = negotiate(cfg?.self?.transportProfile, cfg?.peer?.transportProfile);
  const obs = await observe(cfg);
  const prev = readState(flags).state;
  const rounds = flags['confirm-rounds'] !== undefined ? Number(flags['confirm-rounds']) : undefined;

  const decision = decideRoute({
    effective: neg.effective,
    lanReachable: obs.lanReachable,
    tunnelListening: obs.tunnelListening,
    prev,
    confirmRounds: rounds,
  });

  const endpoint = routeEndpoint(decision.route, cfg);
  const patch = { ...decideStatePatch(decision), configPath: cfgPath, observed: decision.observed, endpoint, profile: neg };
  const statePath = writeState(flags, patch);

  const out = {
    dryRun: flags.apply !== true,
    configPath: cfgPath,
    profile: { self: neg.self, peer: neg.peer, effective: neg.effective, allowOverlay: neg.allowOverlay, why: neg.why },
    observed: obs,
    decision,
    endpoint,
    statePath,
    executed: [],
  };

  if (flags.apply === true) {
    if (decision.action === 'ensure-up') {
      const r = callTunnel('up');
      out.executed.push({ action: 'up', code: r.code, stderr: r.stderr.trim() });
      if (r.code !== 0) {
        if (flags.json) console.log(JSON.stringify(out, null, 2));
        else console.error(`⛔ 起隧道失败（rc=${r.code}）：${r.stderr.trim() || '看 dsh-peer-tunnel up 的输出'}`);
        return 4;
      }
    } else if (decision.action === 'down') {
      const r = callTunnel('down');
      out.executed.push({ action: 'down', code: r.code, stderr: r.stderr.trim() });
      if (r.code !== 0) {
        if (flags.json) console.log(JSON.stringify(out, null, 2));
        else console.error(`⛔ 停隧道失败（rc=${r.code}）：${r.stderr.trim()}`);
        return 4;
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log(`── 选路判决${out.dryRun ? '（干跑：只算不动）' : ''} ──`);
  console.log(`两端档位          : 本机 ${neg.self} · 对端 ${neg.peer} ⇒ ${neg.effective}${neg.allowOverlay ? '（可选 overlay）' : ''}`);
  console.log(`观测 内网直连     : ${obs.lanHost ? `${obs.lanHost}:${obs.lanPort} ⇒ ${obs.lanReachable}` : '（peer.lanHost 没配 ⇒ 判为不可用，直接走隧道）'}`);
  console.log(`观测 隧道本地端口 : 127.0.0.1:${obs.localPort} ⇒ ${obs.tunnelListening}`);
  console.log(`判决 走哪条路     : ${decision.route}${endpoint ? `（${endpoint.host}:${endpoint.port}）` : ''}`);
  console.log(`判决 动作         : ${decision.action}${decision.steps.length ? ` → ${decision.steps.join(' → ')}` : ''}`);
  console.log(`依据              : ${decision.why}`);
  console.log(`迟滞计数          : 需要 ${decision.tunnelWantStreak} 轮 / 不需要 ${decision.tunnelIdleStreak} 轮（收缩阈值 ${decision.confirmRounds}）`);
  console.log(`状态已写          : ${statePath}`);
  if (out.executed.length) console.log(`已执行            : ${out.executed.map((e) => `${e.action}(rc=${e.code})`).join(', ')}`);
  else if (out.dryRun && decision.action !== 'none') console.log('（加 --apply 才会真去动隧道）');
  return 0;
}

async function cmdStatus(flags) {
  const { cfg, path: cfgPath, existed } = loadConfig(flags);
  const neg = negotiate(cfg?.self?.transportProfile, cfg?.peer?.transportProfile);
  const obs = await observe(cfg);
  const { state, path: statePath } = readState(flags);
  const out = { configPath: cfgPath, configExisted: existed, profile: neg, observed: obs, last: state, statePath };
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log('── 选路状态（只读）──');
  console.log(`配置              : ${cfgPath}${existed ? '' : '（不存在，用缺省值）'}`);
  console.log(`档位              : 本机 ${neg.self} · 对端 ${neg.peer} ⇒ ${neg.effective}${neg.unconfirmed ? '（有 auto 未落盘）' : ''}`);
  console.log(`当前观测          : 内网 ${obs.lanReachable} · 隧道端口 ${obs.tunnelListening}`);
  if (state.at) {
    console.log(`最近一次判决      : ${state.at} ⇒ 走 ${state.route} / 动作 ${state.action}`);
    console.log(`那次依据          : ${state.why}`);
  } else {
    console.log('最近一次判决      : （还没跑过 decide）');
  }
  console.log(`状态文件          : ${statePath}`);
  return 0;
}

async function main() {
  const argv = cliGuard(SPEC);
  const { flags, positional } = parseArgs(argv, SPEC);
  const cmd = positional[0];
  switch (cmd) {
    case 'decide': return await cmdDecide(flags);
    case 'status': return await cmdStatus(flags);
    default: {
      console.error(`错误：不认识的子命令 ${cmd ?? '(空)'}\n（运行 \`node dsh-peer-arbiter.mjs --help\` 看用法）`);
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
    process.exitCode = await main();
  } catch (e) {
    console.error('❌ ' + String(e?.message ?? e));
    process.exitCode = 2;
  }
}
