// test/99-dual-instance.test.mjs —— 灵魂夹具：同机双实例闭环（真 ssh -L，不是假转发）
//
// ── 它证明什么（卡面验收第 1、2 条）──────────────────────────────────────────
// 在一台机上起**两个实例**（两个 home + 两个端口）当两台机，跑一次完整闭环：
//   投信 → 对面收到 → 回执 → 选路切换 → 起隧道 → 对面可达 → 关隧道 → 不可达且无残留进程
// 并断言：全程**只有环回监听**（无 0.0.0.0）、**没有新增常驻服务/计划任务**。
//
// ── 为什么用真 ssh ────────────────────────────────────────────────────────────
// 假转发（自己写个 TCP 代理冒充 `ssh -L`）验不出"密钥对不对、转发参数对不对、进程会不会残留"。
// 这里用系统自带的 ssh.exe 连本机 sshd（127.0.0.1:22），走的就是生产跑的那条路。
//
// ── 前置（缺了这条夹具会**明确失败**，不静默跳过）────────────────────────────────
//   · 本机 sshd 在 127.0.0.1:22 上
//   · 有一把能免密登录自己的密钥（缺省 ~/.ssh/id_ed25519_<PEER_E2E_KEY 名>）
//   可用环境变量覆盖：PEER_E2E_KEY（密钥文件名）、PEER_E2E_SSHUSER（用户名）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createSuite } from './harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const ROOT = path.resolve(HERE, '..');
const TUNNEL = path.join(ROOT, 'dsh-peer-tunnel.mjs');
const ARBITER = path.join(ROOT, 'dsh-peer-arbiter.mjs');
const MAILBOX = path.join(ROOT, 'dsh-mailbox.mjs');
const AGENT = path.join(ROOT, 'dsh-peer-agent.mjs');
const SYNC = path.join(ROOT, 'dsh-peer-sync.mjs');

const SSH_USER = process.env.PEER_E2E_SSHUSER || process.env.USERNAME || process.env.USER || 'demo';

/**
 * 候选密钥：`PEER_E2E_KEY` 指定了就用它，否则扫 `~/.ssh` 下所有 `id_*` 私钥逐个试连。
 * 刻意**不写死任何密钥文件名**：一来避免把某台机器的专属名字带进公开仓，
 * 二来换了机器也能跑（只要有一把能免密登录自己的 key 就行）。
 */
function candidateKeys() {
  if (process.env.PEER_E2E_KEY) return [path.join(os.homedir(), '.ssh', process.env.PEER_E2E_KEY)];
  const dir = path.join(os.homedir(), '.ssh');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^id_/.test(f) && !f.endsWith('.pub') && !/\.bak|\.old/i.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function runCli(bin, args, env, timeout = 120_000) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, timeout, windowsHide: true });
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 本机 netstat 里这个端口的 LISTENING 行（拆出**本地地址**列 —— 外语地址列恒是 0.0.0.0:0，别拿它当绑定地址） */
function listenLines(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '')
    .split(/\r?\n/)
    .filter((l) => /\bLISTENING\b/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
    .map((l) => {
      const raw = l.trim();
      const cols = raw.split(/\s+/);
      return { raw, local: cols[1] || '', foreign: cols[2] || '' };
    });
}

function httpGet(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ ok: true, body: d }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: null });
    });
    req.on('error', (e) => resolve({ ok: false, body: null, error: e.code || String(e.message) }));
  });
}

export async function run() {
  const s = createSuite('99 同机双实例闭环（真 ssh -L）');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-e2e-'));
  const homeA = path.join(base, 'inst-a');
  const homeB = path.join(base, 'inst-b');
  const spool = path.join(base, 'spool');
  const knownHosts = path.join(base, 'known_hosts');
  const mailKey = path.join(base, 'mailbox.key');
  fs.mkdirSync(homeA, { recursive: true });
  fs.mkdirSync(homeB, { recursive: true });

  const svcPort = await freePort();
  const tunnelPort = await freePort();
  let svc = null;
  const startSvc = () =>
    new Promise((resolve) => {
      svc = http.createServer((req, res) => res.end('peer-ok'));
      svc.listen(svcPort, '127.0.0.1', () => resolve(true));
    });
  const stopSvc = () =>
    new Promise((resolve) => {
      if (!svc) return resolve(true);
      svc.close(() => {
        svc = null;
        resolve(true);
      });
    });

  // 找一把能免密登录**本机**的 key（逐个试 `exit 0`；不写死任何密钥文件名）
  const tried = [];
  let sshKey = null;
  for (const k of candidateKeys()) {
    const r = spawnSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=6', '-i', k, `${SSH_USER}@127.0.0.1`, '--', 'exit', '0'],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );
    tried.push({ key: path.basename(k), rc: r.status });
    if (r.status === 0) {
      sshKey = k;
      break;
    }
  }

  const cfgA = {
    schemaVersion: 1,
    self: { name: 'node-a', transportProfile: 'restricted' },
    peer: {
      name: 'node-b',
      transportProfile: 'free',
      lanHost: '127.0.0.1',
      lanPort: svcPort,
      sshHost: '127.0.0.1',
      sshPort: 22,
      sshUser: SSH_USER,
      keyPath: sshKey,
      knownHosts,
    },
    tunnel: { bind: '127.0.0.1', localPort: tunnelPort, remotePort: svcPort },
    mailbox: { spoolDir: spool, keyPath: mailKey },
    sync: { remoteRepoPath: ROOT.replace(/\\/g, '/'), dualWrite: [] },
  };
  const cfgB = {
    schemaVersion: 1,
    self: { name: 'node-b', transportProfile: 'free' },
    peer: { name: 'node-a', transportProfile: 'restricted', sshHost: '127.0.0.1', sshPort: 22, sshUser: SSH_USER },
    tunnel: { bind: '127.0.0.1', localPort: tunnelPort + 1, remotePort: svcPort },
    mailbox: { spoolDir: spool, keyPath: mailKey },
    sync: { remoteRepoPath: ROOT.replace(/\\/g, '/') },
  };
  fs.writeFileSync(path.join(homeA, 'peer-config.json'), JSON.stringify(cfgA, null, 2), 'utf8');
  fs.writeFileSync(path.join(homeB, 'peer-config.json'), JSON.stringify(cfgB, null, 2), 'utf8');

  const envA = { ...process.env, DSH_PEER_HOME: homeA };
  const envB = { ...process.env, DSH_PEER_HOME: homeB };
  let tunnelPid = null;

  try {
    s.section('前置：本机 ssh 自连可用（缺这条整条闭环无意义）');
    s.ok('找到一把能免密登录本机的 key（只读使用，未复制未改动）', !!sshKey, `试过：${tried.map((t) => `${t.key}(rc=${t.rc})`).join(', ') || '(~/.ssh 下没有 id_* 私钥)'}`);

    // ── ① 信箱：投信 → 对面收到 → 回执 ──────────────────────────────────────
    s.section('① 投信 → 对面收到 → 回执');
    const kg = runCli(MAILBOX, ['keygen', '--json'], envA, 30_000);
    s.eq('A 端 keygen rc=0', kg.status, 0, kg.stderr);
    const kgInfo = readJson(kg.stdout);
    s.ok('拿到密钥指纹', !!kgInfo?.fingerprint, kg.stdout.slice(0, 160));
    fs.copyFileSync(mailKey, path.join(homeB, 'kept.key')); // 只是确认文件在两处；B 直接用同一路径

    const send1 = runCli(MAILBOX, ['send', '--text', '你好，这里是 A', '--json'], envA, 30_000);
    s.eq('A 发文本信封 rc=0', send1.status, 0, send1.stderr);
    const sent1 = readJson(send1.stdout);
    s.ok('拿到信封 id', !!sent1?.sent?.id, send1.stdout.slice(0, 200));
    s.eq('信封落在共享 spool/inbox', fs.existsSync(path.join(spool, 'inbox', `${sent1?.sent?.id}.json`)), true);

    const ag1 = runCli(AGENT, ['--once', '--json'], envB, 60_000);
    s.eq('B 端 agent 跑一轮 rc=0', ag1.status, 0, `${ag1.stderr}`.slice(0, 300));
    const ag1j = readJson(ag1.stdout);
    s.eq('B 端扫到 1 条', ag1j?.scanned, 1, JSON.stringify(ag1j)?.slice(0, 300));
    s.eq('B 端处理了 1 条', ag1j?.handled?.[0]?.id, sent1?.sent?.id);
    s.eq('B 端认得收件人是自己', ag1j?.self, 'node-b');

    const wait1 = runCli(MAILBOX, ['wait', String(sent1?.sent?.id), '--wait-sec', '15', '--json'], envA, 30_000);
    s.eq('A 收到回执 rc=0', wait1.status, 0, wait1.stderr);
    const r1 = readJson(wait1.stdout)?.receipt;
    s.eq('回执 ok=true', r1?.ok, true, JSON.stringify(r1)?.slice(0, 300));
    s.eq('回执来自 node-b', r1?.from, 'node-b');
    s.ok('回执带了正文', typeof r1?.reply === 'string' && r1.reply.length > 0, JSON.stringify(r1)?.slice(0, 300));

    // ── ② 安全默认：exec 信封默认拒执行 ──────────────────────────────────────
    s.section('② 默认拒执行（本仓与生产最要紧的一处差别）');
    const send2 = runCli(MAILBOX, ['send', '--cmd', 'echo should-not-run', '--json'], envA, 30_000);
    const sent2 = readJson(send2.stdout);
    const ag2 = runCli(AGENT, ['--once', '--json'], envB, 60_000);
    const ag2j = readJson(ag2.stdout);
    s.ok('没开 --allow-exec ⇒ 回执 refused', !!ag2j?.handled?.[0]?.refused, JSON.stringify(ag2j)?.slice(0, 300));
    const wait2 = runCli(MAILBOX, ['wait', String(sent2?.sent?.id), '--wait-sec', '15', '--json'], envA, 30_000);
    const r2 = readJson(wait2.stdout)?.receipt;
    s.eq('回执 ok=false', r2?.ok, false);
    s.ok('refused 说明了原因', /allow-exec/.test(String(r2?.refused)), String(r2?.refused));
    s.eq('wait 的退出码反映失败', wait2.status, 1);

    // ── ③ 显式允许后真执行 ────────────────────────────────────────────────────
    s.section('③ --allow-exec 之后真执行并回传输出');
    const send3 = runCli(MAILBOX, ['send', '--cmd', 'echo hello-exec', '--json'], envA, 30_000);
    const sent3 = readJson(send3.stdout);
    const ag3 = runCli(AGENT, ['--once', '--allow-exec', '--json'], envB, 60_000);
    const ag3j = readJson(ag3.stdout);
    s.eq('执行成功（exit=0）', ag3j?.handled?.[0]?.exitCode, 0, JSON.stringify(ag3j)?.slice(0, 300));
    const wait3 = runCli(MAILBOX, ['wait', String(sent3?.sent?.id), '--wait-sec', '20', '--json'], envA, 30_000);
    const r3 = readJson(wait3.stdout)?.receipt;
    s.eq('回执 ok=true', r3?.ok, true);
    s.ok('回执里有 stdout 内容', /hello-exec/.test(String(r3?.stdoutTail)), String(r3?.stdoutTail).slice(0, 200));

    // ── ④ 选路：lan 通 ⇒ 走内网 ──────────────────────────────────────────────
    s.section('④ 选路切换：内网通走内网');
    await startSvc();
    const d1 = runCli(ARBITER, ['decide', '--json'], envA, 60_000);
    s.eq('decide 干跑 rc=0', d1.status, 0, d1.stderr);
    const d1j = readJson(d1.stdout);
    s.eq('观测到内网可达', d1j?.observed?.lanReachable, true);
    s.eq('判决走 lan', d1j?.decision?.route, 'lan', JSON.stringify(d1j?.decision)?.slice(0, 300));
    s.eq('判决零动作（隧道没开也不用开）', d1j?.decision?.action, 'none');
    s.eq('干跑没有起任何隧道', fs.existsSync(path.join(homeA, 'state', 'tunnel.pid.json')), false);

    // ── ⑤ 选路切换：内网不通 ⇒ 该起隧道 ─────────────────────────────────────
    s.section('⑤ 选路切换：内网断 ⇒ 判 ensure-up');
    await stopSvc();
    const d2 = runCli(ARBITER, ['decide', '--json'], envA, 60_000);
    const d2j = readJson(d2.stdout);
    s.eq('观测到内网不可达', d2j?.observed?.lanReachable, false);
    s.eq('判决 ensure-up', d2j?.decision?.action, 'ensure-up', JSON.stringify(d2j?.decision)?.slice(0, 300));
    s.eq('判决 route 仍未就绪（要起来后下一轮才是 tunnel）', d2j?.decision?.route, 'none');
    s.ok('理由说的是起用户态转发', /用户态转发/.test(String(d2j?.decision?.why)), String(d2j?.decision?.why));

    // ── ⑥ 起隧道 → 对面可达 ──────────────────────────────────────────────────
    s.section('⑥ 起隧道 → 经隧道对面可达');
    const up = runCli(TUNNEL, ['up', '--json'], envA, 60_000);
    s.eq('隧道 up rc=0', up.status, 0, `${up.stdout}${up.stderr}`.slice(0, 400));
    const upj = readJson(up.stdout);
    tunnelPid = upj?.pid ?? null;
    s.ok('拿到隧道 pid', !!tunnelPid, up.stdout.slice(0, 200));
    s.eq('绑定地址是环回', upj?.bind, '127.0.0.1');

    await startSvc(); // 对面服务开起来（模拟对端的服务此刻在跑）
    const hit = await httpGet(tunnelPort);
    s.eq('经隧道访问到对端服务', hit.ok, true, String(hit.error ?? ''));
    s.eq('响应对端的内容', hit.body, 'peer-ok');

    // ── ⑦ 全程只有环回监听 ───────────────────────────────────────────────────
    s.section('⑦ 全程只有环回监听（netstat 断言）');
    const lines = listenLines(tunnelPort);
    s.ok('隧道端口有 LISTENING', lines.length > 0, 'netstat 里找不到');
    s.ok(
      '本地地址只绑 127.0.0.1',
      lines.every((l) => l.local === `127.0.0.1:${tunnelPort}`),
      lines.map((l) => l.raw).join(' | '),
    );
    s.ok('本地地址里没有 0.0.0.0（外语列 0.0.0.0:0 不算绑定）', lines.every((l) => !/^0\.0\.0\.0:/.test(l.local)), lines.map((l) => l.raw).join(' | '));

    // ── ⑧ 选路再判：lan 又不通 ⇒ 走 tunnel（幂等，不重复建连）───────────────
    s.section('⑧ lan 再断、隧道在听 ⇒ 判 tunnel 且零动作');
    await stopSvc();
    const d3 = runCli(ARBITER, ['decide', '--json'], envA, 60_000);
    const d3j = readJson(d3.stdout);
    s.eq('判决 route=tunnel', d3j?.decision?.route, 'tunnel', JSON.stringify(d3j?.decision)?.slice(0, 300));
    s.eq('判决零动作（幂等）', d3j?.decision?.action, 'none');

    // ── ⑨ 经隧道真跨机同步（ssh runner，不是 local）─────────────────────────
    s.section('⑨ 经 ssh 真跑一次文本同步（对端 node 进程落位）');
    const aDocs = path.join(base, 'docs-a');
    const bDocs = path.join(base, 'docs-b');
    fs.mkdirSync(aDocs, { recursive: true });
    fs.mkdirSync(bDocs, { recursive: true });
    fs.writeFileSync(path.join(aDocs, 'note.md'), '# 从 A 过去的\n', 'utf8');
    const sync1 = runCli(SYNC, ['plan', '--apply', '--local-dir', aDocs, '--remote-dir', bDocs, '--remote-repo', ROOT, '--json'], envA, 120_000);
    s.eq('ssh 模式同步 rc=0', sync1.status, 0, `${sync1.stdout}${sync1.stderr}`.slice(0, 500));
    s.eq('对端目录收到文件', fs.existsSync(path.join(bDocs, 'note.md')), true);
    s.eq('内容正确', fs.readFileSync(path.join(bDocs, 'note.md'), 'utf8'), '# 从 A 过去的\n');
    const sync2 = runCli(SYNC, ['plan', '--apply', '--local-dir', aDocs, '--remote-dir', bDocs, '--remote-repo', ROOT, '--json'], envA, 120_000);
    const sync2j = readJson(sync2.stdout);
    s.eq('再跑一轮需传 0 份（幂等）', sync2j?.pairs?.[0]?.summary?.toSend, 0, JSON.stringify(sync2j?.pairs?.[0]?.summary));

    // ── ⑩ 关隧道 → 不可达且无残留 ───────────────────────────────────────────
    s.section('⑩ 关隧道 → 不可达且无残留进程');
    const down = runCli(TUNNEL, ['down', '--json'], envA, 60_000);
    s.eq('隧道 down rc=0', down.status, 0, `${down.stdout}${down.stderr}`.slice(0, 400));
    const downj = readJson(down.stdout);
    s.eq('down 报告端口已释放', downj?.portStillListening, false);
    const after = await httpGet(tunnelPort, 1500);
    s.eq('隧道端口已不可达', after.ok, false);
    s.eq('netstat 里该端口已无 LISTENING', listenLines(tunnelPort).length, 0, listenLines(tunnelPort).join(' | '));
    if (tunnelPid) {
      let alive = true;
      try {
        process.kill(tunnelPid, 0);
      } catch {
        alive = false;
      }
      s.eq('隧道进程已退出（无残留）', alive, false, `pid ${tunnelPid} 还活着`);
    }
    s.eq('pid 文件已清', fs.existsSync(path.join(homeA, 'state', 'tunnel.pid.json')), false);
    const st = runCli(TUNNEL, ['status', '--json'], envA, 30_000);
    s.eq('status 判隧道不在（rc=10）', st.status, 10);

    // ── ⑪ 无新增常驻服务 / 计划任务（静态判据）───────────────────────────────
    s.section('⑪ 不注册常驻服务 / 计划任务（源码静态判据）');
    const srcFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.mjs')).concat(fs.readdirSync(path.join(ROOT, 'lib')).map((f) => path.join('lib', f))).filter((f) => f.endsWith('.mjs'));
    const hits = [];
    for (const rel of srcFiles) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const pat of [/schtasks/i, /New-Service/i, /sc\.exe\s+create/i, /Register-ScheduledTask/i, /systemctl\s+enable/i]) {
        if (pat.test(text)) hits.push(`${rel} 命中 ${pat}`);
      }
    }
    s.eq('源码里没有任何"注册服务/计划任务"的调用', hits, [], hits.join(' | '));
    s.eq('端口一释放后连 status 都判不在', listenLines(tunnelPort).length, 0);
  } finally {
    // 无论成败都要收干净：不留隧道进程、不留对面服务
    try {
      runCli(TUNNEL, ['down', '--json'], envA, 30_000);
    } catch {
      /* 尽力而为 */
    }
    await stopSvc();
    if (tunnelPid) {
      try {
        process.kill(tunnelPid, 0) && process.kill(tunnelPid, 'SIGTERM');
      } catch {
        /* 已经没了 */
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }

  return s.done();
}
