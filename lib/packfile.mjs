// lib/packfile.mjs —— 批次包容器（一行头 + 每文件一行 JSON，base64 内联）
//
// ── 为什么自己做一个容器 ──────────────────────────────────────────────────────
// 不用 zip/tar：它们要么要第三方库、要么依赖对端有同名命令（Windows 的 `tar` 时有时无）。
// 这个容器只依赖 JSON + base64 —— 两端都是 node，天然可读，出问题能直接打开看。
// 代价：base64 膨胀 33%。所以有 `maxBatchBytes` 上限，按批切，不一次性推几万份。
//
// 格式：
//   第 1 行：{"v":1,"count":N,"batchId":"…","createdAt":"…"}
//   之后每行：{"relPath":"a/b.md","size":123,"sha256":"…","mtimeMs":123,"data":"<base64>"}
import { sha256Buf, assertSafeRelPath } from './files.mjs';

export const PACK_VERSION = 1;

/** @param {{relPath:string, mtimeMs:number, buffer:Buffer, reason?:string}[]} items */
export function writePack(items, { batchId = null, now = new Date() } = {}) {
  const head = {
    v: PACK_VERSION,
    count: items.length,
    batchId: batchId || `b-${now.getTime().toString(36)}`,
    createdAt: now.toISOString(),
  };
  const lines = [JSON.stringify(head)];
  for (const it of items) {
    const relPath = assertSafeRelPath(it.relPath);
    lines.push(
      JSON.stringify({
        relPath,
        size: it.buffer.length,
        sha256: sha256Buf(it.buffer),
        mtimeMs: Math.round(it.mtimeMs),
        // 判决随包走：接收端**不重算规则**（重算会因为两个方向 mtime 不同而得出不同结论 ——
        // 那是"发件端判 skip、收件端判 update"这类事故的来源）。
        reason: typeof it.reason === 'string' ? it.reason : null,
        data: it.buffer.toString('base64'),
      }),
    );
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

/** 解析批次包；任何一行坏掉都**抛**（宁可整批不落，不要落半批） */
export function loadPack(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) throw new Error('批次包为空');
  let head;
  try {
    head = JSON.parse(lines[0]);
  } catch (e) {
    throw new Error(`批次包头解析失败：${e.message}`);
  }
  if (head.v !== PACK_VERSION) throw new Error(`批次包版本不支持：${head.v}`);
  const items = [];
  for (let i = 1; i < lines.length; i += 1) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch (e) {
      throw new Error(`第 ${i} 行解析失败：${e.message}`);
    }
    const relPath = assertSafeRelPath(o.relPath);
    const buffer = Buffer.from(String(o.data ?? ''), 'base64');
    if (buffer.length !== Number(o.size)) throw new Error(`第 ${i} 行（${relPath}）长度不符：声明 ${o.size} 实得 ${buffer.length}`);
    if (sha256Buf(buffer) !== o.sha256) throw new Error(`第 ${i} 行（${relPath}）sha256 不符 —— 包被改过或截断`);
    items.push({ relPath, size: o.size, mtimeMs: Number(o.mtimeMs) || 0, sha256: o.sha256, reason: typeof o.reason === 'string' ? o.reason : null, buffer });
  }
  if (head.count !== items.length) throw new Error(`批次包条目数不符：头声 ${head.count} 实得 ${items.length}`);
  return { head, items };
}

/** 按总字节上限切批（单文件超上限 ⇒ 自己单独一批，并如实返回 oversized 清单） */
export function chunkByBytes(items, maxBytes) {
  const batches = [];
  const oversized = [];
  let cur = [];
  let curBytes = 0;
  for (const it of items) {
    const cost = it.buffer.length;
    if (cost > maxBytes) {
      oversized.push(it.relPath);
      batches.push([it]);
      continue;
    }
    if (curBytes + cost > maxBytes && cur.length) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += cost;
  }
  if (cur.length) batches.push(cur);
  return { batches, oversized };
}

export default { PACK_VERSION, writePack, loadPack, chunkByBytes };
