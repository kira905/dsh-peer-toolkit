#!/usr/bin/env node
// test/redact-scan.mjs —— 发布前脱敏扫描（零依赖）
//
// ── 它判什么 ──────────────────────────────────────────────────────────────────
// 两层规则，加起来判「零命中」（白名单除外，白名单每条都要写理由）：
//   ① **通用规则**（写在本文件里）：内网地址三段、用户目录、盘符绝对路径、
//      密钥文件名形状、隧道服务商字样、当前运行者的用户名（从环境取，不落字面）。
//   ② **本部署专有词**（**不在本文件里**，从仓外 deny 文件注入 `--deny-file`）：
//      私有对端机名、本机主机名、机名简称、中转服务器地址、私有中转仓路径、
//      中转侧账号 / 密钥名、生产树路径 …… 凡是"只对某一套部署成立"的词。
//
// ── 为什么专有词不能写在规则表里 ──────────────────────────────────────────────
// 规则表本身是要发布的。一张写着具体机名的表，等于把机名一起发出去 ——
// 「规则不是数据」这句话只在规则**真的通用**时才成立。
// 所以：规则表只放通用形状，具体词一律从**仓外**注入（与仓外那份权威扫描器
// `scan-oss-sanitize.mjs` 同一个取舍：the rule table can be published without
// publishing anything private）。本文件因此可以被读者逐行读完、自己判断有没有私货。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node test/redact-scan.mjs                          # 扫本仓，只跑通用规则
//   node test/redact-scan.mjs <目录>                   # 扫指定目录
//   node test/redact-scan.mjs --deny-file <路径>       # 追加本部署专有词表（必须在被扫目录之外）
//   node test/redact-scan.mjs --json                   # 机器可读（stdout 只有 JSON）
//
// deny 文件格式（UTF-8 文本；`#` 开头为注释、空行忽略）：
//   a) 每行 `名字<TAB>正则<TAB>说明`
//   b) 每行一个词（不含 TAB）⇒ 当作**字面词**，自动转义并按词边界匹配
//   c) 整份 JSON：`[{ "name": "...", "pattern": "...", "why": "..." }, ...]`
//      （也接受二维数组 `[["名字","正则","说明"], ...]` 或 `{ "patterns": [...] }`）
//
// 行为约定（这几条就是它存在的意义，别改）：
//   · **不带** `--deny-file` ⇒ 照常跑通用规则、rc 仍可 0；但输出里必须明确打印一行
//     「⚠️ 具体部署词表未注入（--deny-file），本模式下只做通用规则」——不许静默通过。
//   · **带** `--deny-file` 但文件不存在 / 读不动 / 解析失败 / 正则编译失败 / 空文件
//     ⇒ rc=2 并报错（防"以为扫了其实没扫"）。
//   · `--deny-file` 指向**被扫目录之内** ⇒ rc=2（专有词一进仓，这个扫描器就白做了）。
//
// 退出码：0 = 非白名单零命中 · 1 = 有命中 · 2 = 参数 / deny 文件错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

class UsageError extends Error {}
class DenyError extends Error {}

const USAGE = `用法：
  node test/redact-scan.mjs                        # 扫本仓（只用通用规则）
  node test/redact-scan.mjs <目录>                 # 扫指定目录
  node test/redact-scan.mjs --deny-file <路径>     # 追加本部署专有词表（必须在被扫目录之外）
  node test/redact-scan.mjs --json                 # 机器可读

写什么：只读。不写任何文件、不发网络请求。
退出码：0 = 非白名单零命中 · 1 = 有命中 · 2 = 参数 / deny 文件错误`;

// ── 参数 ──────────────────────────────────────────────────────────────────────
function parseArgs(args) {
  let dir = null;
  let denyFile = null;
  let asJson = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') {
      asJson = true;
      continue;
    }
    if (a === '--deny-file') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) throw new UsageError('--deny-file 后面要跟一个文件路径');
      denyFile = v;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) throw new UsageError(`不认识的参数：${a}`);
    if (dir) throw new UsageError(`只接受一个目录参数（多余：${a}）`);
    dir = a;
  }
  return { dir, denyFile, asJson };
}

// ── 通用规则（任何部署都适用；这里不许出现任何机器标识）────────────────────────
// [名字, 正则, 说明]
const GENERIC_PATTERNS = [
  ['内网地址 192.168/16', /192\.168\.\d+\.\d+/, '内网地址'],
  ['内网地址 10/8', /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, '内网地址'],
  ['内网地址 172.16/12', /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, '内网地址'],
  ['用户目录', /[Cc]:\\Users/i, '用户目录'],
  ['盘符绝对路径', /(?<![A-Za-z])[A-Za-z]:[\\/]/, '私有部署的盘符路径'],
  ['私有密钥文件名', /id_(ed25519|rsa)_(?!demo)[A-Za-z0-9_-]+/, '密钥文件名（示例名 demo 除外）'],
  ['隧道服务商字样', /\bvps\b|阿里云|腾讯云|华为云|cloudflare/i, '隧道服务商 / 中转商'],
];

// 本机用户名从环境取（不把任何一个真实用户名写进仓）
const USERNAME = process.env.USERNAME || process.env.USER || '';
const withEnv = () =>
  USERNAME ? [...GENERIC_PATTERNS, ['运行者用户名', new RegExp(`\\b${USERNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '当前运行者的用户名']] : GENERIC_PATTERNS;

// ── deny 文件（本部署专有词，从仓外注入）──────────────────────────────────────
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 字面词 → 带词边界的正则源（CJK 词不加边界：\b 对汉字无意义） */
function literalToSource(word) {
  const pre = /^[A-Za-z0-9_]/.test(word) ? '(?<![A-Za-z0-9_])' : '';
  const suf = /[A-Za-z0-9_]$/.test(word) ? '(?![A-Za-z0-9_])' : '';
  return `${pre}${escRe(word)}${suf}`;
}

function denyEntry(name, pattern, why) {
  return { name: name || '(未命名)', pattern, why: why || '注入项（来自仓外 deny 文件）' };
}

function loadDenyTerms(file, root) {
  const abs = path.resolve(file);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new DenyError(`deny 文件不存在：${abs}`);
  }
  if (!st.isFile()) throw new DenyError(`deny 文件不是普通文件：${abs}`);
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new DenyError(`deny 文件必须在被扫目录之外（否则专有词又进仓了）：${abs}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new DenyError(`deny 文件读不动：${abs} —— ${e.message}`);
  }

  const trimmed = raw.trim();
  const entries = [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      throw new DenyError(`deny 文件 JSON 解析失败：${e.message}`);
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.patterns) ? data.patterns : null;
    if (!list) throw new DenyError('deny 文件 JSON 必须是数组，或 { "patterns": [...] }');
    for (const it of list) {
      if (Array.isArray(it)) {
        if (!it[1]) throw new DenyError(`deny 条目缺正则：${JSON.stringify(it)}`);
        entries.push(denyEntry(String(it[0] ?? ''), String(it[1]), String(it[2] ?? '')));
      } else if (typeof it === 'string') {
        entries.push(denyEntry(it, literalToSource(it), ''));
      } else if (it && typeof it === 'object') {
        const pat = it.pattern ?? it.word;
        if (!pat) throw new DenyError(`deny 条目缺 pattern / word：${JSON.stringify(it)}`);
        entries.push(denyEntry(String(it.name ?? ''), String(pat), String(it.why ?? it.note ?? '')));
      } else {
        throw new DenyError(`deny 条目形状不认识：${JSON.stringify(it)}`);
      }
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length >= 2 && parts[1].trim()) {
        entries.push(denyEntry(parts[0].trim(), parts[1].trim(), (parts[2] ?? '').trim()));
      } else {
        entries.push(denyEntry(s, literalToSource(s), ''));
      }
    }
  }

  if (!entries.length) {
    throw new DenyError(`deny 文件里没有任何条目（空词表 = 等于没注入，拒绝静默通过）：${abs}`);
  }

  return entries.map((e) => {
    try {
      return [e.name, new RegExp(e.pattern, 'i'), e.why];
    } catch (err) {
      throw new DenyError(`deny 条目正则编译失败：[${e.name}] /${e.pattern}/ —— ${err.message}`);
    }
  });
}

// ── 白名单：[文件相对路径正则, 命中名, 理由] —— 每条都必须能对第三个人讲清 ────────
// 注意：这里**不再整文件放行扫描器自身**。规则表里已经没有私有标识字面量了，
// 唯一的光标是「隧道服务商字样」——服务商品牌属通用词（不是任何一台机器的标识），
// 而它必然与本文件自身的字形重合（规则表里写着这些词才能找它们）⇒ 只对那一条排除自身。
const WHITELIST = [
  [
    /^test[\\/]redact-scan\.mjs$/,
    '隧道服务商字样',
    '规则表只写通用形状（本文件已无任何机器标识）；服务商品牌属通用词，且必然与本文件自身的字形重合 ⇒ 仅对这条排除自身',
  ],
  [/^lib[\\/]net\.mjs$/, '盘符绝对路径', 'WINDIR 环境变量的缺省值 = 系统目录默认值，不是私有部署路径'],
  [/^lib[\\/]profile\.mjs$/, '盘符绝对路径', '同上（WINDIR 缺省值）'],
  [/^test[\\/]01-profile\.test\.mjs$/, '盘符绝对路径', '夹具注入的 windir 参数，同样是系统目录默认值'],
  [/^README\.md$/, '私有密钥文件名', '示例密钥名（明示为占位）'],
  [/^README\.en\.md$/, '私有密钥文件名', '同上'],
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '_tmp', 'logs', 'state', 'coverage']);
const BINARY = /\.(png|jpe?g|gif|webp|zip|tgz|gz|db|ico|pdf)$/i;

function walk(root, dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(root, path.join(dir, e.name), out);
    } else if (e.isFile()) {
      const rel = path.relative(root, path.join(dir, e.name));
      if (BINARY.test(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`\n❌ ${e.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }

  const root = path.resolve(args.dir || path.resolve(HERE, '..'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`\n❌ 要扫的目录不存在或不是目录：${root}\n`);
    process.exitCode = 2;
    return;
  }

  let denyTerms = [];
  if (args.denyFile) {
    try {
      denyTerms = loadDenyTerms(args.denyFile, root);
    } catch (e) {
      process.stderr.write(`\n❌ ${e.message}\n\n（带了 --deny-file 就必须真注入成功；扫一半不算扫。）\n`);
      process.exitCode = 2;
      return;
    }
  }

  const generic = withEnv();
  const PATTERNS = [...generic, ...denyTerms];
  const injected = denyTerms.length > 0;
  const warning = injected ? null : '⚠️ 具体部署词表未注入（--deny-file），本模式下只做通用规则';
  if (warning && args.asJson) process.stderr.write(`${warning}\n`);

  const hits = [];
  const files = walk(root, root);
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const [name, re, why] of PATTERNS) {
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i])) continue;
        const wl = WHITELIST.find(([fileRe, hitName]) => fileRe.test(rel) && (hitName === '*' || hitName === name));
        hits.push({
          file: rel.replace(/\\/g, '/'),
          line: i + 1,
          pattern: name,
          why,
          text: lines[i].trim().slice(0, 160),
          whitelisted: !!wl,
          whitelistReason: wl ? wl[2] : null,
        });
      }
    }
  }

  const real = hits.filter((h) => !h.whitelisted);
  const wl = hits.filter((h) => h.whitelisted);

  if (args.asJson) {
    console.log(
      JSON.stringify(
        {
          root,
          files: files.length,
          patterns: PATTERNS.length,
          genericPatterns: generic.length,
          denyTerms: denyTerms.length,
          denyFileInjected: injected,
          warning,
          hits: real,
          whitelisted: wl,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`扫描仓根：${root}`);
    console.log(`文件 ${files.length} 个 · 通用规则 ${generic.length} 条 · 注入词表 ${denyTerms.length} 条`);
    if (warning) console.log(warning);
    console.log(`\n── 命中（非白名单）：${real.length} 条 ──`);
    for (const h of real) console.log(`❌ ${h.file}:${h.line}  [${h.pattern}]  ${h.text}`);
    if (!real.length) console.log('（零命中）');
    console.log(`\n── 白名单命中：${wl.length} 条 ──`);
    for (const h of wl) console.log(`⚪ ${h.file}:${h.line}  [${h.pattern}]  ${h.whitelistReason}`);
    if (!wl.length) console.log('（无）');
  }
  process.exitCode = real.length === 0 ? 0 : 1;
}

main();
