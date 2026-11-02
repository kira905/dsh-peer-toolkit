// lib/sync-rules.mjs —— 文本同步的**覆盖规则**（纯函数 · 件 text-sync-direct 的提炼）
//
// ── 为什么规则要单独抽出来 ────────────────────────────────────────────────────
// "哪份该传、哪份该跳、哪份只能落冲突副本"是这条工具的全部风险所在：
// 规则写错 = 用本机覆盖对端的新文档（**不可逆**，且对端也在产文档）。
// 抽成纯函数后，夹具可以枚举全部 6 种情形并断言；生产跑的**就是**这同一份函数。
//
// ── 规则表（照生产口径，一字不改）──────────────────────────────────────────────
//   对端没有                        ⇒ new        （新增）
//   同名、本机更新、内容不同        ⇒ update     （传；覆盖前备份 <名>.bak-<stamp>，只留最近 1 份）
//   同名、对端更新、内容不同        ⇒ skip-remote-newer（绝不反向覆盖）
//   同名、内容不同、mtime 判不了谁新 ⇒ conflict   （原件不动，落 <名>.conflict-<tag>-<stamp>）
//   命中双写黑名单                  ⇒ dual-write-conflict（永不覆盖，只落冲突副本）
//   内容相同（sha 相等）或 size+mtime 都相等 ⇒ skip-same
// 🔴 全程**绝不删除**任何目标文件；唯一会被清理的是我们自己的 `.bak-<stamp>` 旧备份。
export const REASONS = ['new', 'update', 'skip-same', 'skip-remote-newer', 'conflict', 'dual-write-conflict', 'skip-conflict-exists'];

/**
 * 单份文件的判决。
 * @param {object} p
 * @param {{size:number, mtimeMs:number}} p.local 本机文件（必须存在）
 * @param {{exists:boolean, size?:number, mtimeMs?:number, sha256?:string|null}} p.remote 对端同名文件
 * @param {string|null} [p.localSha] 本机 sha（给了就做"内容相同"快判；不给就按 size+mtime 快路径）
 * @param {boolean} [p.dualWrite] 是否命中双写黑名单
 * @returns {{reason:string, willWrite:boolean, needsBackup:boolean, conflictCopy:boolean, why:string}}
 */
export function classify({ local, remote, localSha = null, dualWrite = false }) {
  // 「没有」= 没给对象，或**明确** exists:false。
  // 刻意宽容：给了对象却没写 exists 字段的（调用方 stat 成功但只填了 size/mtime）按"存在"处理 ——
  // 因为约定是"只有 stat 成功才放对象"，用 exists:true 当唯一判据会把它误判成"对端没有"，
  // 那就变成用本机覆盖对端（2026-11-02 夹具真抓到过这个形态）。
  if (!remote || remote.exists === false) {
    return { reason: 'new', willWrite: true, needsBackup: false, conflictCopy: false, why: '对端没有这份 ⇒ 新增' };
  }
  if (dualWrite) {
    return {
      reason: 'dual-write-conflict',
      willWrite: true,
      needsBackup: false,
      conflictCopy: true,
      why: '命中双写黑名单（两边都在改它）⇒ 永不覆盖，只落冲突副本',
    };
  }
  const sameSize = Number(remote.size) === Number(local.size);
  const sameMtime = Number(remote.mtimeMs) === Number(local.mtimeMs);
  if (sameSize && sameMtime) {
    return { reason: 'skip-same', willWrite: false, needsBackup: false, conflictCopy: false, why: 'size 与 mtime 都相等 ⇒ 当成同一份，跳过' };
  }
  if (sameSize && typeof remote.sha256 === 'string' && typeof localSha === 'string' && remote.sha256 === localSha) {
    return { reason: 'skip-same', willWrite: false, needsBackup: false, conflictCopy: false, why: 'sha 相等 ⇒ 内容相同，跳过（只 mtime 不同）' };
  }
  const lm = Number(local.mtimeMs);
  const rm = Number(remote.mtimeMs);
  if (Number.isFinite(lm) && Number.isFinite(rm)) {
    if (lm > rm) {
      return { reason: 'update', willWrite: true, needsBackup: true, conflictCopy: false, why: `本机更新（${new Date(lm).toISOString()} > ${new Date(rm).toISOString()}）⇒ 更新，覆盖前备份` };
    }
    if (lm < rm) {
      return { reason: 'skip-remote-newer', willWrite: false, needsBackup: false, conflictCopy: false, why: `对端更新（${new Date(rm).toISOString()} > ${new Date(lm).toISOString()}）⇒ **跳过**，绝不反向覆盖` };
    }
  }
  return { reason: 'conflict', willWrite: true, needsBackup: false, conflictCopy: true, why: '内容不同且 mtime 判不了谁新 ⇒ 原件不动，落冲突副本' };
}

/** 冲突副本 / 备份的文件名（把规则集中在这里，免得两个地方各拼一套） */
export function backupName(relPath, stampStr) {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
  const base = relPath.slice(dir.length);
  return `${dir}${base}.bak-${stampStr}`;
}

export function conflictName(relPath, tag, stampStr) {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
  const base = relPath.slice(dir.length);
  return `${dir}${base}.conflict-${tag}-${stampStr}`;
}

/** 双写黑名单命中判定（传正则字符串数组；非法正则 ⇒ 忽略该条，不让它把整轮搞崩） */
export function hitsDualWrite(relPath, patterns = []) {
  for (const p of patterns) {
    try {
      if (new RegExp(p).test(relPath)) return true;
    } catch {
      /* 非法正则：跳过 */
    }
  }
  return false;
}

/**
 * 冲突副本去重：发件端判了 conflict，但**同一份内容的冲突副本对端已经有了** ⇒ 不再传。
 * 没有这一条，每次 `--apply` 都会在对端多堆一个 `.conflict-*`（重复跑十次就十个）。
 */
export function conflictAlreadyPresent(localSha, existingConflictShas = []) {
  return !!localSha && Array.isArray(existingConflictShas) && existingConflictShas.includes(localSha);
}

/** 结论汇总（`plan` 打印与夹具断言都用它） */
export function summarize(rows) {
  const out = { total: rows.length, byReason: {} };
  for (const r of rows) out.byReason[r.classification.reason] = (out.byReason[r.classification.reason] ?? 0) + 1;
  out.toSend = rows.filter((r) => r.classification.willWrite).length;
  out.wouldDelete = 0; // 本工具永远为 0 —— 这就是"绝不删除"的可读断言
  return out;
}

export default { REASONS, classify, backupName, conflictName, hitsDualWrite, conflictAlreadyPresent, summarize };
