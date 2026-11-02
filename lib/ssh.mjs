// lib/ssh.mjs —— ssh 参数拼装（隧道与远端执行**共用同一份**，不各写一套）
//
// ── 为什么单独一个文件 ────────────────────────────────────────────────────────
// 隧道（`-N -T -L`）和"在对端跑一条 node 命令"用的连接参数必须一致：
// 同一把密钥、同一份 known_hosts、同一个超时。分开写迟早出现"隧道能连、取数连不上"。
//
// ── 一段刻意的选择：**不写用户的 `~/.ssh/known_hosts`** ─────────────────────────
// 本仓默认把 known_hosts 放在自己的 state 目录（`~/.dsh-peer/state/known_hosts`）。
// 理由：开源工具没有资格往用户的家目录里塞主机指纹（我第一次手工验证时就顺手写了一条，
// 那正是要避免的副作用）。想共用你自己的文件，显式配 `peer.knownHosts` 即可。
import path from 'node:path';
import fs from 'node:fs';
import { findSsh } from './net.mjs';
import { peerSshTarget, stateDir } from './config.mjs';

export const DEFAULT_CONNECT_TIMEOUT = 10;
export const DEFAULT_ALIVE_INTERVAL = 30;

/** 本仓自己的 known_hosts（默认位置；父目录自动建） */
export function defaultKnownHosts(flags = {}) {
  const p = path.join(stateDir(flags), 'known_hosts');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/**
 * 公共连接选项（隧道 / 远端执行 / doctor 三处同用）。
 * @returns {{sshBin:string, args:string[], target:string, knownHosts:string, keyPath:string|null}}
 */
export function sshBase(cfg, { flags = {}, sshBin = null, connectTimeout = DEFAULT_CONNECT_TIMEOUT } = {}) {
  const peer = peerSshTarget(cfg);
  const knownHosts = peer.knownHosts || defaultKnownHosts(flags);
  fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'ServerAliveInterval=' + DEFAULT_ALIVE_INTERVAL,
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-p', String(peer.port),
  ];
  if (peer.keyPath && fs.existsSync(peer.keyPath)) args.push('-i', peer.keyPath);
  return { sshBin: sshBin || findSsh(), args, target: peer.target, knownHosts, keyPath: peer.keyPath };
}

/**
 * 隧道专用：`-N -T` + 本地转发 `127.0.0.1:<local> → 对端环回:<remote>`。
 * 🔴 本地绑定地址**写死 127.0.0.1**（不读配置里的 bind，配置里改了也会在 assertConfig 那关被拒）——
 *    这是"只许环回"的第二道，不是重复：配置坏了也不至于把通道开到局域网上。
 */
export function tunnelArgs(cfg, base) {
  const localPort = Number(cfg?.tunnel?.localPort);
  const remotePort = Number(cfg?.tunnel?.remotePort);
  return [
    ...base.args,
    '-N',
    '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    base.target,
  ];
}

/**
 * 远端执行一个 node 脚本：`ssh ... -- <node> "<script>" <sub> <args...>`
 * 只允许"固定入口 + 固定子命令"：本仓**不支持**把任意命令字符串拼进远端 shell
 * （那等于给对面开了个远程 root shell，还带引号地雷）。
 */
export function remoteNodeArgs(base, remoteScript, argv = []) {
  const q = (s) => {
    const t = String(s);
    if (/["\r\n]/.test(t)) throw new Error(`远端参数含引号或换行，拒绝拼接：${t}`);
    return /\s/.test(t) ? `"${t}"` : t;
  };
  // ssh 把 `--` 之后的参数拼成远端命令串；用 `node` 让对端按它自己的 node 跑同一份脚本
  return [...base.args, base.target, '--', 'node', q(remoteScript), ...argv.map(q)];
}

/**
 * ssh 探针：`ssh ... exit 0`，用来判"能不能认证上去"（不执行任何业务）。
 * 用 `exit 0` 而不是 POSIX 习惯的 `true`：对端默认 shell 在 Windows 上是 cmd.exe，
 * `true` 在那里**不是命令**（会回一句 "不是内部或外部命令" 且退出码非 0）。
 * `exit 0` 在 cmd.exe 与 sh 下都成立。
 */
export function remoteProbeArgs(base) {
  return [...base.args, base.target, '--', 'exit', '0'];
}

export default { sshBase, tunnelArgs, remoteNodeArgs, remoteProbeArgs, defaultKnownHosts };
