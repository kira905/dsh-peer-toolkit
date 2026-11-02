// test/04-sync-rules.test.mjs —— 覆盖规则全枚举（这条错了就是"用本机覆盖对端新文档"）
import { createSuite } from './harness.mjs';
import { classify, backupName, conflictName, hitsDualWrite, summarize, conflictAlreadyPresent, REASONS } from '../lib/sync-rules.mjs';

export async function run() {
  const s = createSuite('04 同步覆盖规则');
  const L = { size: 100, mtimeMs: 2_000 };
  const older = { exists: true, size: 100, mtimeMs: 1_000, sha256: null };
  const newer = { exists: true, size: 100, mtimeMs: 3_000, sha256: null };

  s.section('六种情形');
  s.eq('对端没有 ⇒ new', classify({ local: L, remote: { exists: false } }).reason, 'new');
  s.eq('new 会写', classify({ local: L, remote: { exists: false } }).willWrite, true);
  s.eq('size+mtime 都相等 ⇒ skip-same', classify({ local: L, remote: { exists: true, size: 100, mtimeMs: 2_000 } }).reason, 'skip-same');
  s.eq('skip-same 不写', classify({ local: L, remote: { exists: true, size: 100, mtimeMs: 2_000 } }).willWrite, false);
  s.eq('size 同 + sha 同 ⇒ skip-same', classify({ local: L, remote: { exists: true, size: 100, mtimeMs: 9_999, sha256: 'abc' }, localSha: 'abc' }).reason, 'skip-same');
  s.eq('本机更新 ⇒ update', classify({ local: L, remote: older }).reason, 'update');
  s.eq('update 要备份（先备份再覆盖）', classify({ local: L, remote: older }).needsBackup, true);
  s.eq('对端更新 ⇒ skip-remote-newer（绝不反向覆盖）', classify({ local: L, remote: newer }).reason, 'skip-remote-newer');
  s.eq('对端更新 ⇒ 不写', classify({ local: L, remote: newer }).willWrite, false);
  s.eq('mtime 相同但 size 不同 ⇒ conflict', classify({ local: { size: 50, mtimeMs: 2_000 }, remote: { exists: true, size: 100, mtimeMs: 2_000 } }).reason, 'conflict');
  s.eq('conflict ⇒ 落冲突副本', classify({ local: { size: 50, mtimeMs: 2_000 }, remote: { exists: true, size: 100, mtimeMs: 2_000 } }).conflictCopy, true);
  s.eq('mtime 判不了（NaN）⇒ conflict', classify({ local: { size: 100, mtimeMs: NaN }, remote: { exists: true, size: 100, mtimeMs: NaN } }).reason, 'conflict');
  s.eq('命中双写黑名单 ⇒ dual-write-conflict', classify({ local: L, remote: older, dualWrite: true }).reason, 'dual-write-conflict');
  s.eq('双写命中 ⇒ 永不覆盖（needsBackup=false）', classify({ local: L, remote: older, dualWrite: true }).needsBackup, false);
  s.eq('七种原因常量', REASONS, ['new', 'update', 'skip-same', 'skip-remote-newer', 'conflict', 'dual-write-conflict', 'skip-conflict-exists']);
  s.ok('每种情形都给了人话理由', [classify({ local: L, remote: older }).why, classify({ local: L, remote: newer }).why].every((w) => typeof w === 'string' && w.length > 4));

  s.section('备份 / 冲突副本命名');
  s.eq('备份名（顶层）', backupName('a.md', '20261102-0130'), 'a.md.bak-20261102-0130');
  s.eq('备份名（子目录不丢）', backupName('docs/a.md', 'T'), 'docs/a.md.bak-T');
  s.eq('冲突名', conflictName('docs/a.md', 'node-a', 'T'), 'docs/a.md.conflict-node-a-T');

  s.section('双写黑名单');
  s.eq('命中正则', hitsDualWrite('docs/变更流水/2026.md', ['变更流水']), true);
  s.eq('不命中', hitsDualWrite('docs/readme.md', ['变更流水']), false);
  s.eq('空表不命中', hitsDualWrite('x', []), false);
  s.eq('非法正则被忽略（不炸整轮）', hitsDualWrite('x', ['([', 'x']), true);

  s.section('冲突副本去重（不然每轮 --apply 都多堆一个）');
  s.eq('同内容副本已在 ⇒ 判"落过了"', conflictAlreadyPresent('abc', ['abc']), true);
  s.eq('没有同内容 ⇒ 还要落', conflictAlreadyPresent('abc', ['def']), false);
  s.eq('空表 ⇒ 不判', conflictAlreadyPresent('abc', []), false);
  s.eq('没有本地 sha ⇒ 不判（宁可落一份，也不要静默丢）', conflictAlreadyPresent(null, ['abc']), false);

  s.section('汇总：会删除的文件数恒为 0（这就是"从不删除"的可读断言）');
  const rows = [
    { classification: { reason: 'new', willWrite: true } },
    { classification: { reason: 'update', willWrite: true } },
    { classification: { reason: 'skip-same', willWrite: false } },
  ];
  const sum = summarize(rows);
  s.eq('总数', sum.total, 3);
  s.eq('要传', sum.toSend, 2);
  s.eq('wouldDelete 恒 0', sum.wouldDelete, 0);
  s.eq('byReason 分桶', sum.byReason, { new: 1, update: 1, 'skip-same': 1 });

  return s.done();
}
