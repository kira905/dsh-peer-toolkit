// test/07-redact-scan.test.mjs —— 脱敏扫描器自己的夹具（两层规则 / 注入通道 / 红黑判定）
//
// 这条夹具守的是"扫描器自己别骗人"：
//   ① 仓内规则表只有通用形状 ⇒ 不带词表跑，仓必须是 0 命中且**明确提示词表未注入**；
//   ② 通用规则真的会报（在仓外的临时目录里埋通用形状，正控）；
//   ③ 注入通道真的会报（仓外词表里写假机名，正控）；不注入时同样内容**不报**（负控 ——
//      这正是"专有词确实不在仓里"的证据）；
//   ④ 带词表却注入失败（缺文件 / 空文件 / 坏正则 / 词表落在被扫目录里）⇒ rc=2，不静默放过；
//   ⑤ 白名单不再整文件放行扫描器自身（只允许「隧道服务商字样」这一条排除自己）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSuite } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const ROOT = path.resolve(HERE, '..');
const SCAN = path.join(ROOT, 'test', 'redact-scan.mjs');
const NOT_INJECTED = '⚠️ 具体部署词表未注入（--deny-file），本模式下只做通用规则';

const scan = (args) => spawnSync(process.execPath, [SCAN, ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
const stdoutOf = (r) => r.stdout ?? '';
const jsonOf = (r) => {
  try {
    return JSON.parse(stdoutOf(r));
  } catch {
    return null;
  }
};

export async function run() {
  const s = createSuite('07 脱敏扫描器（两层规则 + 注入通道）');
  const base = path.join(os.tmpdir(), `peer-redact-${process.pid}-${Date.now()}`);
  const dirGeneric = path.join(base, 'generic');
  const dirInjected = path.join(base, 'injected');
  fs.mkdirSync(dirGeneric, { recursive: true });
  fs.mkdirSync(dirInjected, { recursive: true });

  // 只用假值；且这些假值的**字形必须与规则不重合** —— 否则本夹具自己就会被扫描器报出来
  // （"扫描器不许报自己"这条纪律，对夹具同样成立）。所以运行时拼出来，源码里不出现完整形状。
  const fakeLan = ['192', '168', '1', '10'].join('.');
  const fakeHome = path.win32.join('C:', 'Users', 'someone');
  const fakeKey = ['id', 'ed25519', 'prod'].join('_');
  const fakePeer = ['example', 'host', 'a'].join('-');

  fs.writeFileSync(path.join(dirGeneric, 'planted.txt'), [`lan = ${fakeLan}`, `home = ${fakeHome}`, `key = ${fakeKey}`].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dirInjected, 'planted.txt'), [`peer = ${fakePeer}`, 'relay = 203.0.113.7'].join('\n'), 'utf8');

  const denyTsv = path.join(base, 'deny-fake.tsv');
  fs.writeFileSync(
    denyTsv,
    ['# 夹具假词表（仓外）', `示例对端机名\t${fakePeer}\t夹具：私有对端机名`, '示例中转地址\t203\\.0\\.113\\.\\d+\t夹具：中转地址'].join('\n') + '\n',
    'utf8',
  );
  const denyWords = path.join(base, 'deny-words.txt');
  fs.writeFileSync(denyWords, `# 一行一个词（与权威扫描器同格式）\n${fakePeer}\n`, 'utf8');
  const denyJson = path.join(base, 'deny-fake.json');
  fs.writeFileSync(denyJson, JSON.stringify([{ name: '示例对端机名', pattern: fakePeer, why: '夹具' }], null, 2), 'utf8');
  const denyEmpty = path.join(base, 'deny-empty.tsv');
  fs.writeFileSync(denyEmpty, '# 只有注释，等于没词表\n', 'utf8');
  const denyBadRe = path.join(base, 'deny-bad.tsv');
  fs.writeFileSync(denyBadRe, '坏正则\texample-(unclosed\t夹具\n', 'utf8');

  s.section('① 仓内：只用通用规则也必须自证干净');
  const repo = scan([]);
  s.eq('扫本仓 rc=0（仓内零命中）', repo.status, 0);
  s.ok('输出里有「词表未注入」的明确提示（不许静默）', stdoutOf(repo).includes(NOT_INJECTED), stdoutOf(repo).slice(0, 400));
  s.ok('输出里报「注入词表 0 条」', /注入词表 0 条/.test(stdoutOf(repo)), stdoutOf(repo).split('\n')[1] ?? '');

  const repoJson = scan(['--json']);
  const rj = jsonOf(repoJson);
  s.ok('--json 的 stdout 是可解析的纯 JSON', rj !== null, stdoutOf(repoJson).slice(0, 200));
  s.eq('--json: denyFileInjected=false', rj?.denyFileInjected, false);
  s.ok('--json: warning 字段非空（机读面也不许静默）', typeof rj?.warning === 'string' && rj.warning.length > 0, JSON.stringify(rj?.warning));
  s.eq('--json: 非白名单命中 0 条', rj?.hits?.length, 0);

  s.section('② 白名单不再整文件放行扫描器自身');
  const selfWl = (rj?.whitelisted ?? []).filter((h) => h.file === 'test/redact-scan.mjs');
  s.ok('扫描器自身最多只有「隧道服务商字样」这一条被白名单', selfWl.every((h) => h.pattern === '隧道服务商字样'), JSON.stringify(selfWl.map((h) => h.pattern)));
  s.ok('白名单里没有任何 * 通配（整文件放行已撤）', (rj?.whitelisted ?? []).every((h) => typeof h.pattern === 'string' && h.pattern !== '*'), '出现 * 通配');

  s.section('③ 通用规则正控（仓外临时目录埋通用形状）');
  const gen = scan([dirGeneric]);
  s.eq('埋了通用形状 ⇒ rc=1', gen.status, 1);
  const gj = jsonOf(scan([dirGeneric, '--json']));
  const genNames = (gj?.hits ?? []).map((h) => h.pattern);
  s.ok('报出「内网地址 192.168/16」', genNames.includes('内网地址 192.168/16'), genNames.join(','));
  s.ok('报出「用户目录」', genNames.includes('用户目录'), genNames.join(','));
  s.ok('报出「私有密钥文件名」', genNames.includes('私有密钥文件名'), genNames.join(','));
  s.ok('通用规则里出现了「运行者用户名」这一条（从环境取，不落字面）', (gj?.genericPatterns ?? 0) >= 7, String(gj?.genericPatterns));

  s.section('④ 注入通道：正控 + 负控');
  const inj = scan([dirInjected, '--deny-file', denyTsv]);
  s.eq('带仓外词表 ⇒ rc=1', inj.status, 1);
  const ij = jsonOf(scan([dirInjected, '--deny-file', denyTsv, '--json']));
  s.eq('注入词表条数 2', ij?.denyTerms, 2);
  s.ok('抓到假机名（example-host-a 形状）', (ij?.hits ?? []).some((h) => h.text.includes(fakePeer)), JSON.stringify((ij?.hits ?? []).map((h) => h.pattern)));
  s.ok('抓到假中转地址 203.0.113.7', (ij?.hits ?? []).some((h) => h.pattern === '示例中转地址'), JSON.stringify((ij?.hits ?? []).map((h) => h.pattern)));

  const noInj = scan([dirInjected]);
  s.eq('不带词表时同样内容 rc=0（负控：专有词确实不在仓里）', noInj.status, 0);
  s.ok('负控输出仍带「未注入」提示', stdoutOf(noInj).includes(NOT_INJECTED), stdoutOf(noInj).slice(0, 300));

  s.section('⑤ 一行一个词 / JSON 词表也认（与权威扫描器同格式）');
  s.eq('一行一个词的词表 rc=1', scan([dirInjected, '--deny-file', denyWords]).status, 1);
  s.eq('JSON 词表 rc=1', scan([dirInjected, '--deny-file', denyJson]).status, 1);

  s.section('⑥ 注入失败必须红（防"以为扫了其实没扫"）');
  s.eq('词表文件不存在 ⇒ rc=2', scan([dirInjected, '--deny-file', path.join(base, 'nope.tsv')]).status, 2);
  s.eq('词表存在但只有注释（空词表）⇒ rc=2', scan([dirInjected, '--deny-file', denyEmpty]).status, 2);
  s.eq('词表里正则编译不过 ⇒ rc=2', scan([dirInjected, '--deny-file', denyBadRe]).status, 2);
  s.eq('词表落在被扫目录里 ⇒ rc=2', scan([dirInjected, '--deny-file', path.join(dirInjected, 'planted.txt')]).status, 2);
  s.eq('要扫的目录不存在 ⇒ rc=2', scan([path.join(base, 'no-such-dir')]).status, 2);
  s.eq('未知参数 ⇒ rc=2', scan(['--definitely-not-a-real-flag']).status, 2);

  s.section('⑦ --help 不执行扫描');
  const help = scan(['--help']);
  s.eq('--help rc=0', help.status, 0);
  s.ok('--help 里有用法与退出码', /用法/.test(stdoutOf(help)) && /退出码/.test(stdoutOf(help)), stdoutOf(help).slice(0, 200));

  fs.rmSync(base, { recursive: true, force: true });
  return s.done();
}
