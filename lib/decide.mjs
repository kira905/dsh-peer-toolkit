// lib/decide.mjs —— 「这一次该走哪条路」的**纯判决**（件 net-arbiter 的提炼）
//
// ── 为什么要把它抽成纯函数 ────────────────────────────────────────────────────
// 选路逻辑一旦混进"真去探网络 / 真去开关隧道"的副作用里，就**没法做夹具**：
// 想验"lan 断了应该切隧道"就得先真把网线拔一次。所以这里零 I/O、零时钟、零副作用 ——
// 夹具直接 import 跑负例，生产侧 CLI import **同一个**函数（验的就是跑的那份判据）。
//
// ── 语义（三条）───────────────────────────────────────────────────────────────
//   ① **lan 优先**：内网直连能通就走内网（快、不占 ssh 进程）；通不通由调用方实测后传进来。
//   ② **tunnel 兜底**：lan 不通就起用户态转发（restricted 档唯一允许的越网手段）。
//   ③ **迟滞 + 幂等**：目标 down 要连续 `confirmRounds` 轮才真 down（防抖）；
//      目标 up 且已在听 ⇒ **零动作**（绝不重复建连：第二次 ssh -L 会抢同一个本地端口）。
//
// ── 一条容易搞错的边界 ────────────────────────────────────────────────────────
//   `lanReachable === null`（探不到）**不等于** false。探不到时往任何方向动手都可能错：
//   往 up 方向硬起 = 可能重复建连；往 down 方向硬停 = 可能误杀正在用的通道
//   ⇒ 一律 `probe-unknown`，只记一行等下一轮。这是本文件里最要紧的一条负例。
export const DECIDE_VERSION = '1.0.0';

/** 收缩迟滞缺省轮数：连续 2 轮判到「不需要隧道」才真 down */
export const SHRINK_CONFIRM_ROUNDS = 2;

function asCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

const tri = (v) => (v === true ? true : v === false ? false : null);

/**
 * 唯一判决。
 * @param {object} p
 * @param {'restricted'|'free'|'auto'} [p.effective] 两端协商后的**有效档**（见 lib/profile.negotiate）
 * @param {boolean|null} p.lanReachable  内网直连是否通（null=探不到）
 * @param {boolean|null} p.tunnelListening 隧道本地端口是否在听（null=探不到）
 * @param {object} [p.prev] 上一轮状态（只需要 tunnelWantStreak / tunnelIdleStreak）
 * @param {number} [p.confirmRounds]
 */
export function decideRoute({ effective = 'restricted', lanReachable, tunnelListening, prev, confirmRounds } = {}) {
  const lan = tri(lanReachable);
  const tun = tri(tunnelListening);
  const rounds =
    Number.isFinite(Number(confirmRounds)) && Number(confirmRounds) >= 1
      ? Math.trunc(Number(confirmRounds))
      : SHRINK_CONFIRM_ROUNDS;

  const wantTunnel = lan === false; // 只有"lan 明确不通"才需要隧道
  const prevWant = asCount(prev?.tunnelWantStreak);
  const prevIdle = asCount(prev?.tunnelIdleStreak);
  const tunnelWantStreak = wantTunnel ? prevWant + 1 : 0;
  const tunnelIdleStreak = wantTunnel ? 0 : prevIdle + 1;

  const base = {
    version: DECIDE_VERSION,
    effective,
    wantTunnel,
    confirmRounds: rounds,
    tunnelWantStreak,
    tunnelIdleStreak,
    observed: { lanReachable: lan, tunnelListening: tun },
  };

  // ── ① 探不到就别动手 ───────────────────────────────────────────────────────
  if (lan === null || tun === null) {
    return {
      ...base,
      route: 'none',
      action: 'probe-unknown',
      steps: [],
      why: lan === null ? '内网可达性探测失败 ⇒ 不知道现状就不动手，等下一轮' : '隧道端口探活失败 ⇒ 不动手，等下一轮',
    };
  }

  // ── ② lan 通 ⇒ 走内网；隧道若开着，按迟滞收 ────────────────────────────────
  if (lan === true) {
    if (tun === false) {
      return { ...base, route: 'lan', action: 'none', steps: [], why: '内网直连可达、隧道本来就没开 ⇒ 走 lan，零动作' };
    }
    if (tunnelIdleStreak < rounds) {
      return {
        ...base,
        route: 'lan',
        action: 'wait',
        steps: [],
        why: `内网直连可达，但隧道只是连续第 ${tunnelIdleStreak}/${rounds} 轮判到「不需要」⇒ 本轮**不关**（迟滞防抖）`,
      };
    }
    return {
      ...base,
      route: 'lan',
      action: 'down',
      steps: ['down'],
      why: `内网直连连续 ${tunnelIdleStreak} 轮（≥${rounds}）可达 ⇒ 收掉隧道（短租纪律：不长期挂着）`,
    };
  }

  // ── ③ lan 不通 ⇒ 走隧道 ────────────────────────────────────────────────────
  if (tun === true) {
    return {
      ...base,
      route: 'tunnel',
      action: 'none',
      steps: [],
      why: `内网直连不通、隧道已在听（连续第 ${tunnelWantStreak} 轮需要）⇒ 走 tunnel，零动作（幂等）`,
    };
  }
  return {
    ...base,
    route: 'none',
    action: 'ensure-up',
    steps: ['up'],
    why: '内网直连不通、隧道没开 ⇒ 起用户态转发（restricted 档唯一允许的越网手段）',
  };
}

/** 只加字段的状态补丁（老读者的字段一个都不碰） */
export function decideStatePatch(decision, atIso = new Date().toISOString()) {
  return {
    decisionVersion: DECIDE_VERSION,
    route: decision?.route ?? null,
    action: decision?.action ?? null,
    why: decision?.why ?? null,
    tunnelWantStreak: asCount(decision?.tunnelWantStreak),
    tunnelIdleStreak: asCount(decision?.tunnelIdleStreak),
    at: atIso,
  };
}

/**
 * 判决 → 具体要连的地址（纯函数，便于夹具断言"切到哪去了"）。
 * tunnel 一律 127.0.0.1 —— 本仓只许环回，这一条不参数化。
 * @returns {{kind:'lan'|'tunnel', host:string, port:number}|null}
 */
export function routeEndpoint(route, cfg) {
  if (route === 'lan') {
    const host = cfg?.peer?.lanHost;
    const port = Number(cfg?.peer?.lanPort);
    if (!host || !Number.isFinite(port)) return null;
    return { kind: 'lan', host, port };
  }
  if (route === 'tunnel') {
    const port = Number(cfg?.tunnel?.localPort);
    if (!Number.isFinite(port)) return null;
    return { kind: 'tunnel', host: '127.0.0.1', port };
  }
  return null;
}

export default { decideRoute, decideStatePatch, routeEndpoint, SHRINK_CONFIRM_ROUNDS, DECIDE_VERSION };
