// test/05-cli-help.test.mjs —— `--help` 不执行真动作 / 未知参数 rc=2（本生态铁律）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSuite } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const ROOT = path.resolve(HERE, '..');
const BINS = ['dsh-peer-tunnel.mjs', 'dsh-peer-arbiter.mjs', 'dsh-mailbox.mjs', 'dsh-peer-agent.mjs', 'dsh-peer-sync.mjs'];

export async function run() {
  const s = createSuite('05 CLI 参数闸');
  const tmpHome = path.join(os.tmpdir(), `peer-help-${process.pid}-${Date.now()}`);
  const env = { ...process.env, DSH_PEER_HOME: tmpHome };

  for (const bin of BINS) {
    const file = path.join(ROOT, bin);
    s.ok(`${bin} 存在`, fs.existsSync(file), file);

    const h = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
    const helpText = `${h.stdout ?? ''}${h.stderr ?? ''}`;
    s.eq(`${bin} --help 退出码 0（不执行动作）`, h.status, 0);
    s.ok(`${bin} --help 含"用法"`, /用法/.test(helpText), helpText.slice(0, 160));
    s.ok(`${bin} --help 写了"写什么"`, /写什么/.test(helpText), '用法里没交代副作用');

    const u = spawnSync(process.execPath, [file, '--definitely-not-a-real-flag'], { encoding: 'utf8', env, timeout: 30_000, windowsHide: true });
    const uText = `${u.stdout ?? ''}${u.stderr ?? ''}`;
    s.eq(`${bin} 未知参数退出码 2`, u.status, 2);
    s.ok(`${bin} 未知参数提示"不认识的参数"`, /不认识的参数/.test(uText), uText.slice(0, 160));
  }

  s.section('副作用断言：--help / 未知参数 都不该碰盘');
  s.ok('临时 home 目录没被创建（说明没走到真动作）', !fs.existsSync(tmpHome), `被创建了：${tmpHome}`);

  s.section('内部子命令存在（对端用），且有帮助可言');
  const syncFile = path.join(ROOT, 'dsh-peer-sync.mjs');
  const it = spawnSync(process.execPath, [syncFile, '--internal-tmpdir'], { encoding: 'utf8', env, timeout: 20_000, windowsHide: true });
  s.eq('--internal-tmpdir rc=0', it.status, 0);
  let tmpdir = null;
  try {
    tmpdir = JSON.parse(it.stdout).tmpdir;
  } catch {
    tmpdir = null;
  }
  s.ok('--internal-tmpdir 回了一个目录', typeof tmpdir === 'string' && tmpdir.length > 0, String(it.stdout).slice(0, 120));
  s.ok('--internal-tmpdir 是绝对路径', !!tmpdir && path.isAbsolute(tmpdir), String(tmpdir));

  return s.done();
}
