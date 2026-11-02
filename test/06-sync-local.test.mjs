// test/06-sync-local.test.mjs —— 三段式同步的真跑演练（local runner：本机两个目录当两台机）
//
// 这条夹具的用途：证明**覆盖规则在真文件上**按预期工作，而不只是纯函数对。
// 断言重点：新增会来 / 本机更新的会来且先备份 / 对端更新的绝不覆盖 / 冲突落副本 / **一个都不删**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSuite } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const ROOT = path.resolve(HERE, '..');
const SYNC = path.join(ROOT, 'dsh-peer-sync.mjs');

const T1 = 1_700_000_000; // 较早
const T2 = 1_700_001_000; // 较晚

function writeWithTime(file, text, sec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  fs.utimesSync(file, sec, sec);
}

export async function run() {
  const s = createSuite('06 同步三段式（local runner 演练）');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-sync-'));
  const local = path.join(base, 'local');
  const remote = path.join(base, 'remote');
  const env = { ...process.env, DSH_PEER_HOME: path.join(base, 'home') };

  // 场景布置
  writeWithTime(path.join(local, 'a-new.md'), '新文件', T1); // 对端没有 ⇒ new
  writeWithTime(path.join(remote, 'a-new.md.bak-check'), '', T1); // 干扰项：非同名，不影响判决
  writeWithTime(path.join(local, 'b-same.md'), '一样', T1); // 完全相同 ⇒ skip-same
  writeWithTime(path.join(remote, 'b-same.md'), '一样', T1);
  writeWithTime(path.join(local, 'c-local-newer.md'), '本机版', T2); // 本机更新 ⇒ update + 备份
  writeWithTime(path.join(remote, 'c-local-newer.md'), '对端旧版', T1);
  writeWithTime(path.join(local, 'd-remote-newer.md'), '本机旧版', T1); // 对端更新 ⇒ 跳过
  writeWithTime(path.join(remote, 'd-remote-newer.md'), '对端新版', T2);
  writeWithTime(path.join(local, 'e-conflict.md'), '本机短', T1); // size 不同 + mtime 相同 ⇒ conflict
  writeWithTime(path.join(remote, 'e-conflict.md'), '对端比较长的一版', T1);
  writeWithTime(path.join(local, 'cli/变更流水/20261102.md'), '本机流水', T2); // 双写黑名单
  writeWithTime(path.join(remote, 'cli/变更流水/20261102.md'), '对端流水', T1);

  // 双写黑名单走**配置**（不是命令行）—— 验配置那份长期口径也生效
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'peer-config.json'), JSON.stringify({ sync: { dualWrite: ['变更流水'] } }, null, 2), 'utf8');

  const remoteBefore = new Map();
  for (const f of fs.readdirSync(remote, { recursive: true })) {
    const abs = path.join(remote, String(f));
    if (fs.statSync(abs).isFile()) remoteBefore.set(String(f).replace(/\\/g, '/'), fs.readFileSync(abs, 'utf8'));
  }

  const runCli = (extra) =>
    spawnSync(
      process.execPath,
      [SYNC, 'plan', '--runner', 'local', '--local-dir', local, '--remote-dir', remote, '--tag', 'node-a', '--json', ...extra],
      { encoding: 'utf8', env, timeout: 120_000, windowsHide: true },
    );
  s.section('第一段：干跑（默认）—— 只算不写');
  const dry = runCli([]);
  s.eq('干跑 rc=0', dry.status, 0, `${dry.stderr}`);
  let dryJson = null;
  try {
    dryJson = JSON.parse(dry.stdout);
  } catch {
    dryJson = null;
  }
  s.ok('干跑输出是 JSON', !!dryJson, String(dry.stdout).slice(0, 200));
  const pair = dryJson?.pairs?.[0] ?? {};
  s.eq('扫到 6 份', pair.scanned, 6);
  const byReason = pair.summary?.byReason ?? {};
  s.eq('new 1 份', byReason.new, 1);
  s.eq('update 1 份', byReason.update, 1);
  s.eq('skip-same 1 份', byReason['skip-same'], 1);
  s.eq('skip-remote-newer 1 份', byReason['skip-remote-newer'], 1);
  s.eq('conflict 1 份', byReason.conflict, 1);
  s.eq('dual-write-conflict 1 份', byReason['dual-write-conflict'], 1);
  s.eq('干跑：会删除的文件数 0', pair.summary?.wouldDelete, 0);
  s.eq('干跑没写对端（a-new.md 仍不存在）', fs.existsSync(path.join(remote, 'a-new.md')), false);

  s.section('第二段：--apply 真传 + 落位');
  const real = runCli(['--apply', '--dual-write', '变更流水']);
  s.eq('真跑 rc=0', real.status, 0, `${real.stderr}`);
  let realJson = null;
  try {
    realJson = JSON.parse(real.stdout);
  } catch {
    realJson = null;
  }
  s.ok('真跑输出是 JSON', !!realJson, String(real.stdout).slice(0, 300));
  s.eq('新增的到对端了', fs.readFileSync(path.join(remote, 'a-new.md'), 'utf8'), '新文件');
  s.eq('本机更新的覆盖了对端', fs.readFileSync(path.join(remote, 'c-local-newer.md'), 'utf8'), '本机版');
  const cDir = fs.readdirSync(remote).filter((f) => f.startsWith('c-local-newer.md.bak-'));
  s.eq('覆盖前留了 1 份备份', cDir.length, 1, `实际：${cDir.join(',')}`);
  s.ok('备份里是对端的旧内容', fs.readFileSync(path.join(remote, cDir[0]), 'utf8') === '对端旧版', '备份内容不对');
  s.eq('对端更新的没被覆盖', fs.readFileSync(path.join(remote, 'd-remote-newer.md'), 'utf8'), '对端新版');
  s.eq('冲突：原件不动', fs.readFileSync(path.join(remote, 'e-conflict.md'), 'utf8'), '对端比较长的一版');
  const conflicts = fs.readdirSync(remote).filter((f) => f.includes('.conflict-node-a-'));
  s.eq('冲突：落了 1 份冲突副本', conflicts.length, 1, `实际：${conflicts.join(',')}`);
  s.ok('冲突副本里是本机版本', fs.readFileSync(path.join(remote, conflicts[0]), 'utf8') === '本机短', '冲突副本内容不对');
  s.eq('双写黑名单：对端原件不动', fs.readFileSync(path.join(remote, 'cli/变更流水/20261102.md'), 'utf8'), '对端流水');
  const dwConflicts = fs.readdirSync(path.join(remote, 'cli/变更流水')).filter((f) => f.includes('.conflict-'));
  s.eq('双写黑名单：只落冲突副本', dwConflicts.length, 1, `实际：${dwConflicts.join(',')}`);

  s.section('第三段：从不删除（原有文件一个不少）');
  for (const [rel, content] of remoteBefore) {
    const stillThere = fs.existsSync(path.join(remote, rel));
    s.ok(`原文件还在：${rel}`, stillThere, '被删了！');
    if (stillThere && !rel.includes('c-local-newer') && !rel.includes('变更流水')) {
      s.eq(`原文件内容未变（对端较新 / 相同那几份）：${rel}`, fs.readFileSync(path.join(remote, rel), 'utf8'), content);
    }
  }

  s.section('第四段：幂等（再跑一轮不该再传）');
  const again = runCli(['--apply', '--dual-write', '变更流水', '--json']);
  s.eq('第二轮 rc=0', again.status, 0);
  let againJson = null;
  try {
    againJson = JSON.parse(again.stdout);
  } catch {
    againJson = null;
  }
  const sent2 = againJson?.pairs?.[0]?.summary?.toSend ?? null;
  s.eq('第二轮需传 0 份（幂等）', sent2, 0, `实际需传 ${sent2}`);

  fs.rmSync(base, { recursive: true, force: true });
  return s.done();
}
