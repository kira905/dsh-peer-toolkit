// test/02-decide.test.mjs —— 选路纯判决（全情形枚举，含"探不到就不动手"的负例）
import { createSuite } from './harness.mjs';
import { decideRoute, decideStatePatch, routeEndpoint, SHRINK_CONFIRM_ROUNDS } from '../lib/decide.mjs';

export async function run() {
  const s = createSuite('02 选路判决');

  s.section('探不到 ⇒ 一律 probe-unknown（最要紧的负例）');
  const u1 = decideRoute({ lanReachable: null, tunnelListening: false });
  s.eq('lan 探不到 ⇒ 不动手', u1.action, 'probe-unknown');
  s.eq('lan 探不到 ⇒ route=none', u1.route, 'none');
  const u2 = decideRoute({ lanReachable: true, tunnelListening: null });
  s.eq('隧道探不到 ⇒ 不动手', u2.action, 'probe-unknown');
  s.ok('理由写明"等下一轮"', /等下一轮/.test(u1.why), u1.why);

  s.section('lan 可达 ⇒ 走 lan；隧道按迟滞收');
  const a1 = decideRoute({ lanReachable: true, tunnelListening: false });
  s.eq('lan 通 / 隧道没开 ⇒ route=lan', a1.route, 'lan');
  s.eq('⇒ 零动作', a1.action, 'none');
  const a2 = decideRoute({ lanReachable: true, tunnelListening: true, prev: {} });
  s.eq('lan 通 / 隧道开着（第 1 轮）⇒ 不关（迟滞）', a2.action, 'wait');
  s.eq('⇒ route 仍是 lan', a2.route, 'lan');
  const a3 = decideRoute({ lanReachable: true, tunnelListening: true, prev: { tunnelIdleStreak: 1 } });
  s.eq('连续第 2 轮不需要 ⇒ 才 down', a3.action, 'down');
  s.eq('down 的步骤', a3.steps, ['down']);
  const a4 = decideRoute({ lanReachable: true, tunnelListening: true, prev: { tunnelIdleStreak: 5 }, confirmRounds: 1 });
  s.eq('confirmRounds=1 ⇒ 当轮就 down', a4.action, 'down');

  s.section('lan 不通 ⇒ 走隧道（这就是"选路切换"）');
  const b1 = decideRoute({ lanReachable: false, tunnelListening: true });
  s.eq('lan 断 / 隧道已在听 ⇒ route=tunnel', b1.route, 'tunnel');
  s.eq('⇒ 零动作（幂等，绝不重复建连）', b1.action, 'none');
  const b2 = decideRoute({ lanReachable: false, tunnelListening: false });
  s.eq('lan 断 / 隧道没开 ⇒ ensure-up', b2.action, 'ensure-up');
  s.eq('ensure-up 的步骤', b2.steps, ['up']);
  s.eq('⇒ route 暂时 none（还没起来）', b2.route, 'none');
  s.eq('wantTunnel=true', b2.wantTunnel, true);

  s.section('迟滞计数器');
  s.eq('需要时 wantStreak 累加', decideRoute({ lanReachable: false, tunnelListening: false, prev: { tunnelWantStreak: 2 } }).tunnelWantStreak, 3);
  s.eq('需要时 idleStreak 归零', decideRoute({ lanReachable: false, tunnelListening: false, prev: { tunnelIdleStreak: 9 } }).tunnelIdleStreak, 0);
  s.eq('不需要时 wantStreak 归零', decideRoute({ lanReachable: true, tunnelListening: false, prev: { tunnelWantStreak: 9 } }).tunnelWantStreak, 0);
  s.eq('不需要时 idleStreak 累加', decideRoute({ lanReachable: true, tunnelListening: false, prev: { tunnelIdleStreak: 1 } }).tunnelIdleStreak, 2);
  s.eq('脏状态值（负数/字符串）不炸', decideRoute({ lanReachable: true, tunnelListening: false, prev: { tunnelIdleStreak: -5 } }).tunnelIdleStreak, 1);
  s.eq('缺省收缩阈值', SHRINK_CONFIRM_ROUNDS, 2);

  s.section('有效档带进判决（供上层展示）');
  s.eq('restricted 档原样带出', decideRoute({ effective: 'restricted', lanReachable: false, tunnelListening: false }).effective, 'restricted');

  s.section('状态补丁：只加字段');
  const p = decideStatePatch(a3, '2026-11-02T00:00:00.000Z');
  s.eq('补丁 route', p.route, 'lan');
  s.eq('补丁 action', p.action, 'down');
  s.eq('补丁 at 用传入时刻', p.at, '2026-11-02T00:00:00.000Z');
  s.ok('补丁不含 observed 之外的业务字段', typeof p.tunnelWantStreak === 'number' && typeof p.tunnelIdleStreak === 'number');

  s.section('routeEndpoint：隧道一律 127.0.0.1');
  const cfg = { peer: { lanHost: '192.0.2.10', lanPort: 19080 }, tunnel: { localPort: 19081 } };
  s.eq('lan 端点', routeEndpoint('lan', cfg), { kind: 'lan', host: '192.0.2.10', port: 19080 });
  s.eq('tunnel 端点（写死环回）', routeEndpoint('tunnel', cfg), { kind: 'tunnel', host: '127.0.0.1', port: 19081 });
  s.eq('none ⇒ null', routeEndpoint('none', cfg), null);
  s.eq('lan 但没配 lanHost ⇒ null', routeEndpoint('lan', { peer: {}, tunnel: { localPort: 1 } }), null);

  return s.done();
}
