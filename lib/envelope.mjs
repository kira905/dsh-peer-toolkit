// lib/envelope.mjs —— 信箱的信封格式 + spool 目录协议（件 mailbox 的提炼）
//
// ── 设计（与生产同源的那部分）────────────────────────────────────────────────
// 信封 = AES-256-GCM 加密的 JSON；密钥**只存在两台机器本地**，不进任何中转介质。
// 好处：中转的那一头（共享盘 / 私有仓 / 同步过来的目录）里没有明文；
//      就算那份介质泄露，没有密钥也造不出**能被执行**的指令（GCM 带认证，改一个字节就解不开）。
//
// ── 与生产的差异（开源化时**故意**改掉的三处）──────────────────────────────────
//   ① 生产把 spool 放在一个**专门的私有 git 仓**的孤立分支上。
//      本仓**不绑 git、不绑平台**：spool 只是一个目录，怎么到对面由你选（见 README §4.1：
//      共享盘 / git 仓 / 本仓的 `dsh-peer-sync` 经隧道推）。
//   ② 生产默认 `~/.dsh`；本仓默认 `~/.dsh-peer`（不去动 DSH 自己的目录）。
//   ③ 生产 agent 收到就执行；本仓 agent **默认拒执行**，要显式 `--allow-exec`（见 dsh-peer-agent.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const INBOX = 'inbox';
export const OUTBOX = 'outbox';
export const DONE = 'done';
export const REJECTED = 'rejected';
export const SPOOL_DIRS = [INBOX, OUTBOX, DONE, REJECTED];

export const DEFAULT_MAX_INLINE = 512 * 1024; // 单条内联负载上限（原始字节）
export const DEFAULT_OUT_LIMIT = 64 * 1024; // 单条输出回传上限
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

// ── 密钥 ─────────────────────────────────────────────────────────────────────

export function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** 生成 / 读取 32 字节对称密钥（文件权限 0600；已存在且没有 --force 就复用） */
export function generateKey(keyPath, force = false) {
  if (fs.existsSync(keyPath) && !force) {
    const key = loadKey(keyPath);
    return { created: false, keyPath, fingerprint: keyFingerprint(key) };
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = crypto.randomBytes(32);
  // 明文密钥写盘前就把权限收到 0600（Windows 上 mode 基本无效，靠目录 ACL，README 里说明）
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return { created: true, keyPath, fingerprint: keyFingerprint(key) };
}

/** 读密钥：接受裸 32 字节 / 64 位 hex / base64 三种形态（我们生产上三种都出现过） */
export function loadKey(keyPath) {
  if (!fs.existsSync(keyPath)) {
    throw new Error(`密钥不存在：${keyPath}（先跑 \`dsh-mailbox keygen\`）`);
  }
  const raw = fs.readFileSync(keyPath);
  if (raw.length === 32) return raw;
  const txt = raw.toString('utf8').trim();
  const key = /^[0-9a-f]{64}$/i.test(txt) ? Buffer.from(txt, 'hex') : Buffer.from(txt, 'base64');
  if (key.length !== 32) throw new Error(`密钥长度错误：${key.length} 字节（需 32）`);
  return key;
}

// ── 信封 ─────────────────────────────────────────────────────────────────────

/** 加密成信封文本（返回 JSON 字符串，末尾带换行，便于直接写文件） */
export function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return (
    JSON.stringify(
      {
        v: PROTOCOL_VERSION,
        alg: 'aes-256-gcm',
        fp: keyFingerprint(key),
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
      },
      null,
      2,
    ) + '\n'
  );
}

/** 解密；任何异常（版本 / 指纹 / 认证失败）都抛 —— 调用方必须当"拒收"处理，不许当空信封 */
export function unseal(text, key) {
  const env = JSON.parse(text);
  if (env.v !== PROTOCOL_VERSION) throw new Error(`协议版本不支持：${env.v}`);
  if (env.fp && env.fp !== keyFingerprint(key)) throw new Error(`密钥指纹不匹配（信封 ${env.fp} / 本地 ${keyFingerprint(key)}）`);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function newId(prefix = 'm', now = new Date()) {
  return `${prefix}-${stamp(now)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 输出裁剪：回传上限之外的部分丢掉，但**如实标 truncated**（别让人以为拿到了全部） */
export function cutStream(text, limit = DEFAULT_OUT_LIMIT) {
  if (typeof text !== 'string') return { text: '', truncated: false, bytes: 0 };
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, truncated: false, bytes: buf.length };
  return { text: buf.subarray(0, limit).toString('utf8'), truncated: true, bytes: buf.length };
}

// ── spool 目录协议 ───────────────────────────────────────────────────────────

export function ensureSpool(spoolDir) {
  for (const d of SPOOL_DIRS) fs.mkdirSync(path.join(spoolDir, d), { recursive: true });
  return spoolDir;
}

/** 原子写一条信封（tmp → rename，避免对面读到半截 JSON） */
export function writeEnvelope(dir, id, text) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.json`);
  const tmp = path.join(dir, `.${id}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

/** 列信封 id（只认 `<id>.json`，忽略 tmp 与隐藏文件） */
export function listEnvelopes(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map((f) => f.slice(0, -5));
}

export function envelopePath(dir, id) {
  return path.join(dir, `${id}.json`);
}

export function readEnvelope(dir, id) {
  return fs.readFileSync(envelopePath(dir, id), 'utf8');
}

/** 搬信封（同卷 rename；跨卷退回 copy+unlink）。目标已存在 ⇒ 不覆盖（返回 overwritten:false） */
export function moveEnvelope(fromDir, toDir, id) {
  fs.mkdirSync(toDir, { recursive: true });
  const from = envelopePath(fromDir, id);
  const to = envelopePath(toDir, id);
  if (fs.existsSync(to)) return { moved: false, reason: '目标已存在（不覆盖）', to };
  try {
    fs.renameSync(from, to);
    return { moved: true, to };
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
    return { moved: true, to, via: 'copy' };
  }
}

/** 收件箱积压读数（`status` 用） */
export function spoolStats(spoolDir) {
  const out = { spoolDir };
  for (const d of SPOOL_DIRS) out[d] = listEnvelopes(path.join(spoolDir, d)).length;
  return out;
}

export default {
  PROTOCOL_VERSION,
  INBOX,
  OUTBOX,
  DONE,
  REJECTED,
  SPOOL_DIRS,
  DEFAULT_MAX_INLINE,
  DEFAULT_OUT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  keyFingerprint,
  generateKey,
  loadKey,
  seal,
  unseal,
  sha256,
  stamp,
  newId,
  cutStream,
  ensureSpool,
  writeEnvelope,
  listEnvelopes,
  envelopePath,
  readEnvelope,
  moveEnvelope,
  spoolStats,
};
