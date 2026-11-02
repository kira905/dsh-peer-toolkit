// lib/net.mjs —— 端口 / 可达性 / ssh 定位（零依赖，零副作用）
//
// 本仓所有"对面通不通"的判断都从这里出，**不各写一份**：
//   · tcpProbe()      能不能连上（对 SSH 型转发，连通即"在听"）
//   · listeningBind() 端口到底绑在哪个地址上（**只有它**能区分 127.0.0.1 与 0.0.0.0）
//   · findSsh()       系统自带 ssh 在哪
//   · assertLoopbackBind() —— 「只许环回」这条硬约束的**唯一**执行点
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** 是不是环回地址（只认这三个字面值；不解析 DNS，免得 example.com 被解析成环回） */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(String(host ?? '').toLowerCase());
}

/**
 * 「只许环回」的唯一执行点：不是环回就**直接抛**，调用方没有"绕过"的口子。
 * 本仓所有会开端口的地方（隧道本地端、agent 若将来起服务）都必须过这道。
 */
export function assertLoopbackBind(host, where = 'listener') {
  if (!isLoopbackHost(host)) {
    throw new Error(`拒绝绑定非环回地址：${where} 收到 "${host}"（本仓只许 127.0.0.1 / ::1 / localhost）`);
  }
  return host;
}

/**
 * TCP 能不能连上（毫秒级）。连上立刻销毁 socket，不发任何业务字节。
 * @returns {Promise<boolean>}
 */
export function tcpProbe(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let sock;
    try {
      sock = net.connect({ host, port: Number(port) });
    } catch {
      finish(false);
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      sock.destroy();
      finish(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      finish(false);
    });
    sock.once('error', () => {
      sock.destroy();
      finish(false);
    });
  });
}

/** 无限等？不 —— 给一个"等它开始听"的轮询（隧道 up 之后用），返回是否等到 */
export async function waitTcpListen(host, port, timeoutMs = 8000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await tcpProbe(host, port, Math.min(1000, stepMs + 500))) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  } while (Date.now() < deadline);
  return false;
}

/**
 * 本机上某个端口**绑在哪个地址、pid 是谁**（只读）。
 * Windows 走 netstat，类 Unix 走 ss/lsof。返回 null 表示没在听。
 * @returns {{bind:string, port:number, pid:number|null, raw:string}|null}
 */
export function listeningBind(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (process.platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    const out = String(r.stdout || '');
    const re = new RegExp(`^\\s*TCP\\s+(\\S+):${p}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im');
    const m = out.match(re);
    if (!m) return null;
    return { bind: m[1], port: p, pid: Number(m[2]), raw: m[0].trim() };
  }
  const ss = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' });
  if (ss.status === 0) {
    const line = String(ss.stdout || '')
      .split(/\r?\n/)
      .find((l) => new RegExp(`[:.]${p}\\s`).test(l));
    if (line) {
      const pidM = line.match(/pid=(\d+)/);
      const bindM = line.match(/\s(\S+):(\d+)\s/);
      return { bind: bindM ? bindM[1] : '?', port: p, pid: pidM ? Number(pidM[1]) : null, raw: line.trim() };
    }
  }
  return null;
}

/** 端口在听，且**只**绑环回？返回 {ok, bind, why} —— 用于"只有环回监听"的断言 */
export function assertLoopbackListening(port) {
  const rec = listeningBind(port);
  if (!rec) return { ok: false, bind: null, why: `${port} 没在监听` };
  if (!isLoopbackHost(rec.bind)) return { ok: false, bind: rec.bind, why: `${port} 绑在 ${rec.bind}（不是环回）` };
  return { ok: true, bind: rec.bind, why: `${port} 只绑 ${rec.bind}` };
}

/** 系统自带 ssh 在哪（Windows 优先 System32\OpenSSH，其次 PATH；类 Unix 用 PATH） */
export function findSsh() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(sys)) return sys;
    const r = spawnSync('where', ['ssh'], { encoding: 'utf8', windowsHide: true });
    const first = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return first || 'ssh';
  }
  const r = spawnSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' });
  const first = String(r.stdout || '').trim().split(/\r?\n/)[0];
  return first || 'ssh';
}

/** 进程还在不在（down 之后断言"无残留"用） */
export function pidAlive(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // 活着但没权限发信号
  }
}

/** 结束一个进程（只给 tunnel down 用；调用方必须先证明它就是我们记录的那个 pid） */
export function killPid(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, why: '非法 pid' };
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(p), '/F'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, why: String(r.stderr || r.stdout || '').trim(), rc: r.status };
  }
  try {
    process.kill(p, 'SIGTERM');
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}
