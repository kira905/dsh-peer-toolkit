// lib/files.mjs —— 目录遍历 / 哈希 / 排除规则（零依赖）
//
// 口径与生产同步件一致（宁可少传，不要传错）：
//   · 只收**文本**扩展名（二进制大件不该走这条通道；要传大件用别的工具）
//   · 恒定排除 VCS 与依赖目录（`.git` / `node_modules` / `.venv` …）
//   · 只读已有文件，**不创建、不删除**
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEXT_EXTS = [
  '.md', '.txt', '.json', '.jsonl', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.ps1', '.psm1', '.cmd', '.bat', '.sh',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.html', '.css', '.sql', '.csv',
];

export const SKIP_DIRS = ['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'dist', 'build', 'coverage'];

/** 相对路径是否被排除（按段比对，`foo/node_modules/bar` 也命中） */
export function isExcluded(relPath, skipDirs = SKIP_DIRS) {
  const segs = relPath.split(/[\\/]/);
  return segs.some((s) => skipDirs.includes(s));
}

/** 扩展名是否在文本白名单里 */
export function isTextFile(relPath, exts = TEXT_EXTS) {
  return exts.includes(path.extname(relPath).toLowerCase());
}

/**
 * 遍历目录，产出 `[{relPath, size, mtimeMs}]`（relPath 一律用 `/` 分隔，跨平台可比）。
 * @param {string} root
 * @param {{textExts?:string[], skipDirs?:string[], maxFiles?:number}} [opts]
 */
export function walkFiles(root, opts = {}) {
  const exts = opts.textExts ?? TEXT_EXTS;
  const skip = opts.skipDirs ?? SKIP_DIRS;
  const maxFiles = opts.maxFiles ?? 20000;
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // 权限不够 / 不存在：跳过这一层，不阻断整轮
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skip.includes(e.name)) continue;
        stack.push(childRel);
        continue;
      }
      if (!e.isFile()) continue; // 符号链接 / 设备文件一律不碰
      if (!isTextFile(childRel, exts)) continue;
      if (isExcluded(childRel, skip)) continue;
      let st;
      try {
        st = fs.statSync(path.join(root, childRel));
      } catch {
        continue;
      }
      out.push({ relPath: childRel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      if (out.length >= maxFiles) return out;
    }
  }
  return out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(abs) {
  return sha256Buf(fs.readFileSync(abs));
}

/** 时间戳串（备份 / 冲突副本命名用；本地时间，便于人读） */
export function stampOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 相对路径的安全校验：不许绝对路径、不许 `..` 逃逸（对端落位前的最后一道） */
export function assertSafeRelPath(relPath) {
  const p = String(relPath ?? '');
  if (!p) throw new Error('空的相对路径');
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) throw new Error(`拒绝绝对路径：${p}`);
  const segs = p.split(/[\\/]/);
  if (segs.some((s) => s === '..')) throw new Error(`拒绝路径逃逸：${p}`);
  return p.replace(/\\/g, '/');
}

export default { TEXT_EXTS, SKIP_DIRS, isExcluded, isTextFile, walkFiles, sha256Buf, sha256File, stampOf, assertSafeRelPath };
