#!/usr/bin/env node
// dsh-peer-tunnel.mjs —— 隧道生命周期 + 传输档（件 relay-cli / relay-ondemand 的**用户态转发部分**）
//
// ── 它做一件很小的事 ──────────────────────────────────────────────────────────
// 在本机开一个**只绑环回**的本地端口，经系统自带的 `ssh -L` 转发到对端的环回端口。
// 零 npm 依赖、不装服务、不起守护、不碰 TUN 驱动。用完 `down` 就干净了。
//
// ── 为什么只有这一条实现（这是本仓最重要的取舍，见 README §5）───────────────────
// 多机协同的通道有两种做法：①用户态端口转发（ssh -L）②overlay 网络（Tailscale / WireGuard）。
// 后者体验更好，但要装 TUN 驱动 / 常驻服务 / 要管理员 —— 在**受限主机**（公司机、有 EDR、
// 没有本机管理员）上根本做不了。而①在最受限的机器上也成立 ⇒ **它就是全场景的下界**。
// 所以本仓只实现①；两端都自由的人可以自己换②，对外仍是"本地端口"，本仓四件都不用改。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node dsh-peer-tunnel.mjs profile                 # 看两端档位 + 协商结果（只读）
//   node dsh-peer-tunnel.mjs profile --auto          # 探测本机，给建议（**不落盘**）
//   node dsh-peer-tunnel.mjs profile --pin free --apply   # 人确认落盘（只有这条会写配置）
//   node dsh-peer-tunnel.mjs up                      # 起隧道（已在跑则复用）
//   node dsh-peer-tunnel.mjs down                    # 停隧道（只杀我们自己记录的 pid）
//   node dsh-peer-tunnel.mjs status                  # 状态（只读）
//   node dsh-peer-tunnel.mjs doctor                  # 自检（只读；会做一次认证探针）
//
// 退出码：0 成功 · 2 参数/配置错误 · 5 起来但端口没在听 · 6 停了但端口仍被占 · 7 自检有失败项 · 10 隧道不在
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cliGuard, parseArgs } from './lib/cli-args.mjs';
import { loadConfig, saveConfig, assertConfig, tunnelPidPath, stateDir } from './lib/config.mjs';
import { findSsh, assertLoopbackBind, tcpProbe, waitTcpListen, listeningBind, pidAlive, killPid } from './lib/net.mjs';
import { sshBase, tunnelArgs } from './lib/ssh.mjs';
import { negotiate, suggestProfile, validatePin, normalizeProfile } from './lib/profile.mjs';
import { localRunner, sshRunner } from './lib/runner.mjs';

const SELF = fileURLToPath(import.meta.url);

const SPEC = {
  cmd: 'dsh-peer-tunnel',
  usage: 'node dsh-peer-tunnel.mjs <profile|up|down|status|doctor> [选项]',
  summary: '跨机通道的隧道生命周期（只做用户态 ssh -L 转发，只绑环回）',
  commands: [
    { name: 'profile', desc: '看两端传输档 / 协商结果；--auto 只给建议；--pin 才落盘' },
    { name: 'up', desc: '起隧道（已在跑则复用，幂等）' },
    { name: 'down', desc: '停隧道（只杀本文件记录的 pid）' },
    { name: 'status', desc: '只读：档位 / 隧道进程 / 端口绑定' },
    { name: 'doctor', desc: '只读自检：ssh 在哪 / 密钥在不在 / 能不能认证上' },
  ],
  flags: [
    { name: '--config', arg: 'PATH', desc: '配置文件路径（缺省 ~/.dsh-peer/peer-config.json）' },
    { name: '--auto', desc: 'profile 子命令：探测本机并打印建议（不写盘）' },
    { name: '--pin', arg: 'PROFILE', desc: 'profile 子命令：要落盘的档位（restricted|free），须配 --apply' },
    { name: '--apply', desc: '真写配置（不加就只是打印计划）' },
    { name: '--force', desc: 'up：即使端口已被别人占也照起（一般别用）' },
    { name: '--ssh-bin', arg: 'PATH', desc: '指定 ssh 可执行文件（缺省自动找系统自带的）' },
    { name: '--json', desc: '输出 JSON' },
  ],
  writes: '只有 `profile --pin X --apply` 会写 peer-config.json；`up` 会写 state/tunnel.pid.json 与 ssh 日志；`down` 会删 pid 文件。启动/结束 ssh 进程。',
  exits: '0 成功 · 2 参数或配置错误 · 5 起来但端口没在听 · 6 停了但端口仍被占 · 7 自检有失败项 · 10 隧道不在',
  examples: [
    'node dsh-peer-tunnel.mjs profile',
    'node dsh-peer-tunnel.mjs profile --auto',
    'node dsh-peer-tunnel.mjs up --json',
    'node dsh-peer-tunnel.mjs down',
  ],
  notes: [
    '本地绑定地址**代码内固定 127.0.0.1**，配置里改成 0.0.0.0 会被拒（rc=2）。',
    '`down` 只杀 pid 文件里记录的那个进程；端口被别人占着时只报告，不误杀。',
  ],
};

function logLine(flags, obj) {
  try {
    const dir = path.join(stateDir(flags));
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const s = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    fs.appendFileSync(path.join(dir, `tunnel-${s}.jsonl`), JSON.stringify({ ts: d.toISOString(), ...obj }) + '\n', 'utf8');
  } catch {
    /* 日志失败不阻断 */
  }
}

function readPidFile(flags) {
  const p = tunnelPidPath(flags);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writePidFile(flags, rec) {
  const p = tunnelPidPath(flags);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function clearPidFile(flags) {
  const p = tunnelPidPath(flags);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── profile ─────────────────────────────────────────────────────────────────

function cmdProfile(flags) {
  const { cfg, existed, path: cfgPath } = loadConfig(flags);
  const selfP = normalizeProfile(cfg?.self?.transportProfile);
  const peerP = normalizeProfile(cfg?.peer?.transportProfile);
  const neg = negotiate(selfP.profile, peerP.profile);
  const out = {
    configPath: cfgPath,
    configExisted: existed,
    self: { name: cfg?.self?.name ?? null, declared: cfg?.self?.transportProfile ?? null, effective: selfP.profile },
    peer: { name: cfg?.peer?.name ?? null, declared: cfg?.peer?.transportProfile ?? null, effective: peerP.profile },
    negotiated: neg,
  };

  if (flags.auto) {
    const sug = suggestProfile();
    out.auto = sug;
    out.autoNote = 'auto 只给建议、**不写盘**。确认后用：profile --pin <restricted|free> --apply';
  }

  if (flags.pin !== undefined && flags.pin !== true) {
    const v = validatePin(flags.pin);
    if (!v.ok) {
      console.error(`错误：${v.why}`);
      return 2;
    }
    out.pin = { profile: v.profile, applied: flags.apply === true, configPath: cfgPath };
    if (flags.apply === true) {
      cfg.self.transportProfile = v.profile;
      saveConfig(cfg, cfgPath);
      out.pin.wrote = true;
      out.pin.reread = negotiate(v.profile, cfg?.peer?.transportProfile);
    } else {
      out.pin.wrote = false;
      out.pin.plan = `把 self.transportProfile 写成 "${v.profile}"（加 --apply 才真写）`;
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log('── 传输档（每台机器各自声明，协商取最保守那端）──');
  console.log(`配置              : ${cfgPath}${existed ? '' : '（还不存在 ⇒ 用缺省值；profile --pin … --apply 会建）'}`);
  console.log(`本机 ${String(out.self.name).padEnd(12)}: 声明 ${out.self.declared} ⇒ 生效 ${out.self.effective}`);
  console.log(`对端 ${String(out.peer.name).padEnd(12)}: 声明 ${out.peer.declared} ⇒ 生效 ${out.peer.effective}`);
  console.log(`协商后果          : ${neg.effective}${neg.allowOverlay ? '（允许 overlay，可选）' : '（只走 lan / tunnel）'}`);
  console.log(`可用通道          : ${neg.transports.join(' · ')}`);
  console.log(`判据              : ${neg.why}`);
  if (out.auto) {
    console.log('\n── auto 探测（只给建议，不落盘）──');
    console.log(`建议              : ${out.auto.suggestion}`);
    console.log(`依据              : ${out.auto.reason}`);
    console.log(`下一步            : ${out.autoNote}`);
  }
  if (out.pin) {
    console.log(`\n── 落盘 ──`);
    console.log(out.pin.wrote ? `✅ 已写入：self.transportProfile = ${out.pin.profile}` : `计划：${out.pin.plan}`);
  }
  return 0;
}

// ── up ──────────────────────────────────────────────────────────────────────

async function cmdUp(flags) {
  const { cfg, path: cfgPath } = loadConfig(flags);
  const chk = assertConfig(cfg);
  if (!chk.ok) {
    console.error(`⛔ 配置不合法（${cfgPath}）：\n  - ${chk.problems.join('\n  - ')}`);
    return 2;
  }
  // 第二道（不是重复）：就算配置被手工改成 0.0.0.0，也在这里拦住
  try {
    assertLoopbackBind(cfg?.tunnel?.bind ?? '127.0.0.1', 'tunnel.bind');
  } catch (e) {
    console.error(`⛔ ${e.message}`);
    return 2;
  }

  const localPort = Number(cfg.tunnel.localPort);
  const cur = readPidFile(flags);
  const alreadyListening = await tcpProbe('127.0.0.1', localPort, 800);

  if (cur && pidAlive(cur.pid) && alreadyListening) {
    if (flags.json) console.log(JSON.stringify({ up: true, reused: true, pid: cur.pid, localPort }, null, 2));
    else console.log(`ℹ 隧道已在跑（pid=${cur.pid}，127.0.0.1:${localPort} 在听）⇒ 复用，不重复建连。`);
    return 0;
  }
  if (alreadyListening && flags.force !== true) {
    const rec = listeningBind(localPort);
    console.error(`⛔ 本地端口 ${localPort} 已被占用（${rec ? `bind=${rec.bind} pid=${rec.pid}` : '未知进程'}）。`);
    console.error('   多半是上一次的隧道没关，或者你另开了别的服务。先查：dsh-peer-tunnel status');
    console.error('   （确实要抢这个端口再加 --force；那会先 down 掉本仓记录的隧道）');
    return 5;
  }

  const peer = cfg.peer ?? {};
  const keyPath = peer.keyPath ? path.resolve(String(peer.keyPath).replace(/^~/, process.env.USERPROFILE || process.env.HOME || '~')) : null;
  if (keyPath && !fs.existsSync(keyPath)) {
    console.error(`⛔ 私钥不存在：${keyPath}`);
    console.error('   先把公钥加到对端（README §3.1 有一步步的做法），或改 peer.keyPath。');
    return 2;
  }

  const base = sshBase(cfg, { flags, sshBin: flags['ssh-bin'] || null });
  const args = tunnelArgs(cfg, base);
  const logPath = path.join(stateDir(flags), 'tunnel-ssh.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(base.sshBin, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  const rec = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    sshBin: base.sshBin,
    localPort,
    remotePort: Number(cfg.tunnel.remotePort),
    target: base.target,
    // 记下命令行便于事后核对（不含密钥内容，只有路径）
    args,
  };
  writePidFile(flags, rec);

  const ok = await waitTcpListen('127.0.0.1', localPort, 9000);
  const bind = ok ? listeningBind(localPort) : null;
  const loopbackOnly = ok ? !!bind && (bind.bind === '127.0.0.1' || bind.bind === '::1') : false;

  logLine(flags, { action: 'up', pid: child.pid, ok, loopbackOnly, localPort, target: base.target });

  if (!ok) {
    if (flags.json) console.log(JSON.stringify({ up: false, pid: child.pid, localPort, logPath }, null, 2));
    else {
      console.error(`⚠️ ssh 进程起了（pid=${child.pid}）但 127.0.0.1:${localPort} 没在听。`);
      console.error(`   看这条日志：${logPath}`);
      console.error('   常见原因：密钥没被对端接受 / 对端 sshd 没开 / 远端端口没人监听。');
    }
    return 5;
  }
  if (!loopbackOnly) {
    // 极端情况：绑定地址不是环回 ⇒ 立刻收掉，绝不把通道留在局域网上
    killPid(child.pid);
    clearPidFile(flags);
    console.error(`⛔ 端口绑在 ${bind?.bind}（不是环回）⇒ 已立即关闭（本仓不允许把通道暴露出去）。`);
    return 6;
  }

  if (flags.json) {
    console.log(JSON.stringify({ up: true, pid: child.pid, localPort, bind: bind.bind, target: base.target, logPath }, null, 2));
  } else {
    console.log(`✅ 隧道已起：pid=${child.pid}`);
    console.log(`   本机 127.0.0.1:${localPort} → ${base.target}:127.0.0.1:${cfg.tunnel.remotePort}`);
    console.log(`   绑定地址 ${bind.bind}（只环回）`);
    console.log(`   日志 ${logPath}`);
  }
  return 0;
}

// ── down ────────────────────────────────────────────────────────────────────

async function cmdDown(flags) {
  const { cfg, path: cfgPath } = loadConfig(flags);
  const localPort = Number(cfg?.tunnel?.localPort ?? 19080);
  const rec = readPidFile(flags);
  const killed = [];

  if (rec && rec.pid && pidAlive(rec.pid)) {
    const r = killPid(rec.pid);
    killed.push({ pid: rec.pid, ok: r.ok, why: r.why ?? null });
  }
  clearPidFile(flags);

  // 等端口真的释放（最多 5 秒）
  let still = null;
  for (let i = 0; i < 20; i += 1) {
    still = listeningBind(localPort);
    if (!still) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  logLine(flags, { action: 'down', killed, portStillListening: !!still, localPort, configPath: cfgPath });

  if (still) {
    const ours = rec && still.pid && still.pid === rec.pid;
    if (flags.json) {
      console.log(JSON.stringify({ down: false, killed, portStillListening: true, portPid: still.pid, ours }, null, 2));
    } else {
      console.error(`⚠️ 已停我们记录的那个进程，但本地端口 ${localPort} 仍被占（pid=${still.pid ?? '未知'}）。`);
      console.error(ours ? '   那是同一个 pid 还没退干净，稍等再 status 看一眼。' : '   **不是我们起的** ⇒ 本仓不替你杀别人的进程。');
    }
    return 6;
  }

  if (flags.json) console.log(JSON.stringify({ down: true, killed, portStillListening: false, localPort }, null, 2));
  else {
    console.log(killed.length ? `🛑 已停隧道：${killed.map((k) => `pid=${k.pid}`).join(', ')}` : 'ℹ 本来就没有在跑的隧道');
    console.log(`   本地端口 ${localPort}：已释放`);
    console.log('   ⚠️ 本次只停**本机这一端**；对端若另有常驻（比如它自己的服务），不在本工具的管辖内。');
  }
  return 0;
}

// ── status ──────────────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const { cfg, path: cfgPath, existed } = loadConfig(flags);
  const localPort = Number(cfg?.tunnel?.localPort ?? 19080);
  const rec = readPidFile(flags);
  const alive = rec ? pidAlive(rec.pid) : false;
  const listening = await tcpProbe('127.0.0.1', localPort, 800);
  const bind = listening ? listeningBind(localPort) : null;
  const neg = negotiate(cfg?.self?.transportProfile, cfg?.peer?.transportProfile);
  const out = {
    configPath: cfgPath,
    configExisted: existed,
    profile: {
      self: normalizeProfile(cfg?.self?.transportProfile).profile,
      peer: normalizeProfile(cfg?.peer?.transportProfile).profile,
      negotiated: neg.effective,
      allowOverlay: neg.allowOverlay,
      unconfirmed: neg.unconfirmed,
    },
    tunnel: {
      pid: rec?.pid ?? null,
      startedAt: rec?.startedAt ?? null,
      pidAlive: alive,
      listening,
      bind: bind?.bind ?? null,
      portPid: bind?.pid ?? null,
      localPort,
      remotePort: Number(cfg?.tunnel?.remotePort ?? 0),
      target: `${cfg?.peer?.sshUser}@${cfg?.peer?.sshHost}`,
    },
    ok: !!(rec && alive && listening && bind && (bind.bind === '127.0.0.1' || bind.bind === '::1')),
  };
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return out.ok ? 0 : 10;
  }
  console.log('── 隧道状态 ──');
  console.log(`配置              : ${cfgPath}${existed ? '' : '（不存在，用缺省值）'}`);
  console.log(`档位              : 本机 ${out.profile.self} · 对端 ${out.profile.peer} ⇒ 协商 ${out.profile.negotiated}${out.profile.unconfirmed ? '（有 auto 未落盘）' : ''}`);
  console.log(`对端              : ${out.tunnel.target}（远端环回 ${out.tunnel.remotePort}）`);
  console.log(`隧道进程          : ${rec ? `pid=${rec.pid} 起于 ${rec.startedAt} ${alive ? '（活）' : '（已死）'}` : '（无记录）'}`);
  console.log(`本地端口          : ${listening ? `${bind?.bind}:${localPort} 在听（pid=${bind?.pid}）` : `${localPort} 没在听`}`);
  console.log(`判定              : ${out.ok ? '✅ 隧道在，且只绑环回' : '⚠️ 隧道不在（或绑定不是环回）'}`);
  return out.ok ? 0 : 10;
}

// ── doctor ──────────────────────────────────────────────────────────────────

function cmdDoctor(flags) {
  const { cfg, path: cfgPath, existed } = loadConfig(flags);
  const chk = assertConfig(cfg);
  const base = sshBase(cfg, { flags, sshBin: flags['ssh-bin'] || null });
  const sshExists = base.sshBin === 'ssh' ? true : fs.existsSync(base.sshBin);
  const checks = [];
  checks.push({ name: '配置文件', ok: existed, detail: existed ? cfgPath : `${cfgPath}（不存在，用缺省值）`, warnOnly: true });
  checks.push({ name: '配置自检', ok: chk.ok, detail: chk.ok ? '通过（本地只绑环回）' : chk.problems.join('；') });
  checks.push({ name: 'ssh 可执行文件', ok: sshExists, detail: base.sshBin });
  checks.push({ name: '私钥', ok: !!(base.keyPath && fs.existsSync(base.keyPath)), detail: base.keyPath || '（未配置 peer.keyPath）', warnOnly: !base.keyPath });
  checks.push({ name: 'known_hosts', ok: true, detail: base.knownHosts });

  const runner = sshRunner(cfg, { flags, sshBin: base.sshBin });
  const probe = runner.probe();
  checks.push({ name: '认证探针', ok: probe.ok, detail: probe.why });

  const neg = negotiate(cfg?.self?.transportProfile, cfg?.peer?.transportProfile);
  checks.push({ name: '两端档位', ok: !neg.unconfirmed, detail: `本机 ${neg.self} · 对端 ${neg.peer} ⇒ ${neg.effective}${neg.unconfirmed ? '（有 auto 未落盘，必须人工确认）' : ''}`, warnOnly: true });

  const fails = checks.filter((c) => !c.ok && !c.warnOnly);
  const ok = fails.length === 0;
  if (flags.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 7;
  }
  console.log('── 自检（只读）──');
  for (const c of checks) {
    const mark = c.ok ? '✅' : c.warnOnly ? '⚠️' : '❌';
    console.log(`${mark} ${c.name}：${c.detail}`);
  }
  console.log(ok ? '\n判定：✅ 关键项通过' : '\n判定：❌ 有失败项（见上）');
  return ok ? 0 : 7;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = cliGuard(SPEC);
  const { flags, positional } = parseArgs(argv, SPEC);
  const cmd = positional[0];
  switch (cmd) {
    case 'profile': return cmdProfile(flags);
    case 'up': return await cmdUp(flags);
    case 'down': return await cmdDown(flags);
    case 'status': return await cmdStatus(flags);
    case 'doctor': return cmdDoctor(flags);
    default: {
      console.error(`错误：不认识的子命令 ${cmd ?? '(空)'}\n（运行 \`node dsh-peer-tunnel.mjs --help\` 看用法）`);
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
