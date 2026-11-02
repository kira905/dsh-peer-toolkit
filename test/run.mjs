#!/usr/bin/env node
// test/run.mjs —— 跑全部夹具（零依赖，串行，失败即非零退出）
//
// 用法：
//   node test/run.mjs            # 跑全部（含 e2e，会真起 ssh 隧道，约 30~60 秒）
//   node test/run.mjs --fast     # 跳过 e2e（只跑纯函数与 CLI 夹具，约 2 秒）
//   node test/run.mjs profile decide   # 只跑文件名里含这些词的
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const only = args.filter((a) => !a.startsWith('-'));

const files = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .filter((f) => (fast && f.startsWith('99-') ? false : true))
  .filter((f) => (only.length ? only.some((k) => f.includes(k)) : true));

console.log(`── dsh-peer-toolkit 回归（${files.length} 个夹具${fast ? '，--fast 跳过 e2e' : ''}）──`);

let total = 0;
let fail = 0;
const bad = [];
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  try {
    const mod = await import(new URL(f, import.meta.url).href);
    const r = (await mod.run?.()) ?? { total: 0, fail: 1, rows: [{ name: '(没有导出 run())', pass: false }] };
    total += r.total ?? 0;
    fail += r.fail ?? 0;
    if ((r.fail ?? 0) > 0) bad.push({ file: f, rows: (r.rows ?? []).filter((x) => !x.pass) });
  } catch (e) {
    fail += 1;
    total += 1;
    bad.push({ file: f, rows: [{ name: `夹具崩溃：${e?.stack ?? e}` }] });
    console.log(`  ✗ 夹具崩溃：${e?.message ?? e}`);
  }
}

console.log(`\n══ 汇总 ══`);
console.log(`断言 ${total} 条 · 失败 ${fail} 条`);
for (const b of bad) {
  console.log(`\n✖ ${b.file}`);
  for (const r of b.rows) console.log(`    ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
process.exitCode = fail === 0 ? 0 : 1;
