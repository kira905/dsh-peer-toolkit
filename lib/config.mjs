// lib/config.mjs —— 配置解析 / 原子写 / 路径约定（零依赖）
//
// ── 一条刻意的边界：本仓**默认不往 `~/.dsh` 里写任何东西** ──────────────────────
// 我们的生产机上一整套工具已经把 `~/.dsh` 塞满了；开源版跑在别人机器上更不该去动
// DSH 自己的目录。所以本仓的缺省根 = `~/.dsh-peer`（可用 `--config` / `DSH_PEER_HOME` 改）。
// 想跟 DSH 放一起的人**显式**指定即可，默认不猜。
//
// ── 为什么配置要原子写 ────────────────────────────────────────────────────────
// `peer-config.json` 会被 tunnel / arbiter / mailbox / sync 四件同时读；写到一半被打断
// 就是"配置损坏 ⇒ 四件全歇"。所以一律 tmp → fsync → rename（同目录，同一卷，不会 EXDEV）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const DEFAULT_HOME = path.join(os.homedir(), '.dsh-peer');
/** 隧道本地端**只许**这个绑定地址（不可配置 —— 本仓的硬约束，不是默认值） */
export const LOOPBACK = '127.0.0.1';

export function dshPeerHome(flags = {}) {
  return path.resolve(flags.config ? path.dirname(path.resolve(flags.config)) : process.env.DSH_PEER_HOME || DEFAULT_HOME);
}

export function configPath(flags = {}) {
  if (flags.config) return path.resolve(flags.config);
  if (process.env.DSH_PEER_CONFIG) return path.resolve(process.env.DSH_PEER_CONFIG);
  return path.join(dshPeerHome(flags), 'peer-config.json');
}

export function resolveTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 缺省配置：**全部示例值**（RFC 5737 文档地址段 / 占位主机名），可直接跑双实例夹具 */
export function defaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    self: {
      name: 'node-a',
      // 每台机器**各自**声明；缺省从严（restricted）
      transportProfile: 'restricted',
    },
    peer: {
      name: 'node-b',
      transportProfile: 'restricted',
      // 内网直连（lan 通道）；示例用 RFC 5737 文档保留地址，不是真实设备
      lanHost: '192.0.2.10',
      lanPort: 19080,
      // 走隧道时的 ssh 落地（示例值；双实例夹具改成 127.0.0.1）
      sshHost: '192.0.2.10',
      sshPort: 22,
      sshUser: 'demo',
      keyPath: '~/.ssh/id_ed25519_demo',
      knownHosts: null,
    },
    tunnel: {
      // 本地端只绑 127.0.0.1；远端端是**对面**的环回端口
      bind: LOOPBACK,
      localPort: 19080,
      remotePort: 19080,
    },
    mailbox: {
      spoolDir: '~/.dsh-peer/spool',
      keyPath: '~/.dsh-peer/mailbox.key',
    },
    sync: {
      // 对面仓的绝对路径（远端执行 `node <remoteRepoPath>/dsh-peer-sync.mjs`）
      remoteRepoPath: '/opt/dsh-peer-toolkit',
      // 要同步的目录对（多个就写多条；`~` 会展开）
      pairs: [{ name: 'docs', localDir: '~/dsh-peer-docs', remoteDir: '~/dsh-peer-docs' }],
      // 双写黑名单：命中正则的相对路径**永不覆盖**，只落冲突副本
      dualWrite: [],
      // 冲突副本里用的本方标识（缺省取 self.name）
      conflictTag: null,
    },
  };
}

/** 深合并（两层：顶层键 + 一个子对象层），数组与标量直接覆盖 */
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 读配置：不存在 ⇒ 返回缺省值 + existed:false（**不写盘**，写盘只由 --apply / --init 触发） */
export function loadConfig(flags = {}) {
  const p = configPath(flags);
  const d = defaultConfig();
  if (!fs.existsSync(p)) return { cfg: d, existed: false, path: p };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`配置损坏（${p}）：${e.message}`);
  }
  const cfg = mergeDeep(d, raw);
  // bind 不接受外部值：配置里写了非环回 ⇒ 记下来，由调用方拒（见 assertConfig）
  return { cfg, existed: true, path: p };
}

/** 原子写配置（同目录 tmp → fsync → rename） */
export function saveConfig(cfg, p) {
  const target = path.resolve(p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target); // 同目录同卷，不会 EXDEV
  return target;
}

/**
 * 配置自检：只查"会让我们干错事"的几项。
 * 最要紧的一条 = **本地绑定地址必须是环回**（非环回 = 把通道暴露给局域网，本仓禁止）。
 */
export function assertConfig(cfg) {
  const problems = [];
  const bind = String(cfg?.tunnel?.bind ?? LOOPBACK);
  if (bind !== LOOPBACK) problems.push(`tunnel.bind 只许 ${LOOPBACK}（收到 "${bind}"）—— 本仓不允许把通道暴露出去`);
  const lp = Number(cfg?.tunnel?.localPort);
  const rp = Number(cfg?.tunnel?.remotePort);
  if (!Number.isFinite(lp) || lp <= 0 || lp > 65535) problems.push(`tunnel.localPort 非法：${cfg?.tunnel?.localPort}`);
  if (!Number.isFinite(rp) || rp <= 0 || rp > 65535) problems.push(`tunnel.remotePort 非法：${cfg?.tunnel?.remotePort}`);
  if (!cfg?.peer?.sshHost) problems.push('peer.sshHost 缺失');
  if (!cfg?.peer?.sshUser) problems.push('peer.sshUser 缺失');
  return { ok: problems.length === 0, problems };
}

export function stateDir(flags = {}) {
  return path.join(dshPeerHome(flags), 'state');
}

export function tunnelPidPath(flags = {}) {
  return path.join(stateDir(flags), 'tunnel.pid.json');
}

export function routeStatePath(flags = {}) {
  return path.join(stateDir(flags), 'route-state.json');
}

export function resolveSpool(cfg) {
  return path.resolve(resolveTilde(cfg?.mailbox?.spoolDir || '~/.dsh-peer/spool'));
}

export function resolveKey(cfg) {
  return path.resolve(resolveTilde(cfg?.mailbox?.keyPath || '~/.dsh-peer/mailbox.key'));
}

export function peerSshTarget(cfg) {
  const p = cfg?.peer ?? {};
  return {
    host: p.sshHost,
    port: Number(p.sshPort ?? 22),
    user: p.sshUser,
    keyPath: p.keyPath ? path.resolve(resolveTilde(p.keyPath)) : null,
    knownHosts: p.knownHosts ? path.resolve(resolveTilde(p.knownHosts)) : null,
    target: `${p.sshUser}@${p.sshHost}`,
  };
}

export default {
  SCHEMA_VERSION,
  LOOPBACK,
  DEFAULT_HOME,
  dshPeerHome,
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  assertConfig,
  stateDir,
  tunnelPidPath,
  routeStatePath,
  resolveSpool,
  resolveKey,
  peerSshTarget,
  resolveTilde,
};
