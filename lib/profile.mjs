// lib/profile.mjs —— 「传输档」的三档语义 + 两端协商 + auto 只做建议（零 I/O 的纯部分 + 可注入探测）
//
// ── 这一件为什么单独存在（本仓的设计重心）─────────────────────────────────────
// 多机协同最容易写错的地方不是"怎么连"，而是"假设对方能装什么"。我们的真实拓扑就是**混合**的：
// 一台是企业机（有 EDR、没有本机管理员、装 TUN 客户端会被拦），另一台是自家机（什么都能装）。
// 一条通道通不通，由**两端里更保守的那端**决定 —— 所以档位是**每台机器各自声明**的，
// 不是"整套部署一个值"。这条一旦搞错，给出的方案在受限那端就是不可执行的。
//
// ── 三档 ──────────────────────────────────────────────────────────────────────
//   restricted  受限主机：公司机 / 有 EDR / 没有本机管理员 / 装 TUN 会被拦
//               ⇒ 只许**用户态端口转发**（系统自带 ssh -L）；禁 TUN 驱动、禁第三方网络客户端、
//                 禁注册常驻服务、禁起守护进程
//   free        自由主机：自家机 / 无 EDR / 有管理员
//               ⇒ 同上两条都可，**另外可选** overlay 网络（本仓不实现，见 README §5）
//   auto        不是一档"设置"，是**一次探测**：给出建议，**绝不自动落盘**
//
// ── 硬规矩（卡面写死，本文件就是它的执行点）─────────────────────────────────────
//   ① 两端协商 = **取最保守档** ⇒ 只要 restricted 能用的通道，就是全场景可用的下界；
//   ② auto 只输出 `suggestion` + `reason`，`pinned:false`；**落盘必须人显式 `--pin`**；
//   ③ 本文件**不断言任何环境**（探测函数可注入），所以夹具能在"受限环境"里跑出受限建议。
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findSsh } from './net.mjs';

export const PROFILES = ['restricted', 'free', 'auto'];
export const PINNED_PROFILES = ['restricted', 'free'];
export const DEFAULT_PROFILE = 'restricted'; // 缺省从严：没写就当受限机（不给自己开后门）

/** 归一：不认识的档位一律回落 restricted，并如实报告 wasInvalid */
export function normalizeProfile(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (PROFILES.includes(v)) return { profile: v, wasInvalid: false };
  if (!v) return { profile: DEFAULT_PROFILE, wasInvalid: false, why: '未声明 ⇒ 缺省 restricted（从严）' };
  return { profile: DEFAULT_PROFILE, wasInvalid: true, why: `不认识的档位 "${value}" ⇒ 回落 restricted` };
}

/** 本档允许的传输通道（本仓实现只有 lan / tunnel 两条，overlay 只在文档里） */
export function allowedTransports(profile) {
  const { profile: p } = normalizeProfile(profile);
  const base = ['lan', 'tunnel'];
  // restricted 与 free 的**可实现**通道集相同 —— 差别在 free 端**额外允许** overlay，
  // 而 overlay 不是本仓的实现（见 README §5：两端都自由时可以换，DSH 侧不用改）。
  return p === 'free' ? [...base, 'overlay(optional)'] : base;
}

/**
 * 两端协商：取最保守档。
 * `auto`（=尚未落盘）在协商里按 **restricted** 计 —— 这就是"不许猜"的落地形态：
 * 猜错方向永远是"以为对方能装 TUN"，代价是方案不可执行；从严只会少用一条可选通道。
 * @returns {{effective:'restricted'|'free', allowOverlay:boolean, transports:string[],
 *            unconfirmed:boolean, self:string, peer:string, why:string}}
 */
export function negotiate(selfProfile, peerProfile) {
  const a = normalizeProfile(selfProfile);
  const b = normalizeProfile(peerProfile);
  const unconfirmed = a.profile === 'auto' || b.profile === 'auto';
  // auto 在协商里按 restricted 计；已落盘的按声明值
  const rank = (p) => (p === 'free' ? 1 : 0);
  const effRank = Math.min(unconfirmed ? 0 : rank(a.profile), unconfirmed ? 0 : rank(b.profile));
  const effective = effRank >= 1 ? 'free' : 'restricted';
  const why = unconfirmed
    ? `有一端还是 auto（未落盘）⇒ 协商按 restricted 计（不猜）`
    : effective === 'free'
      ? '两端都是 free（已落盘）⇒ 可用 overlay，但仍默认 lan/tunnel'
      : '至少一端是 restricted ⇒ 取最保守档 ⇒ 只走用户态转发（lan/tunnel 都不需要装东西）';
  return {
    effective,
    allowOverlay: effective === 'free',
    transports: allowedTransports(effective),
    unconfirmed,
    self: a.profile,
    peer: b.profile,
    why,
  };
}

// ── auto 探测（三个信号，全部可注入 ⇒ 夹具能在受限环境里跑出受限建议）──────────────

/** 默认运行器：跑一条命令读输出（探测专用，只读命令） */
function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/**
 * 探测"本机有没有本机管理员权限"。
 * Windows 判据 = `whoami /groups` 里出现高完整性级别 SID `S-1-16-12288`（提权中）；
 * 类 Unix 判据 = uid === 0。探不到 ⇒ null（**不是 false**，别把"不知道"当成"没有"）。
 */
export function probeAdmin({ platform = process.platform, run = defaultRun, uid = process.getuid?.() } = {}) {
  if (platform !== 'win32') {
    if (typeof uid !== 'number') return null;
    return uid === 0;
  }
  const r = run('whoami', ['/groups']);
  if (r.status !== 0) return null;
  const out = r.stdout;
  if (!/S-1-5-32-544/.test(out)) return false; // 连管理员组都不在
  return /S-1-16-(12288|16384)/.test(out); // 高完整性 / 系统完整性 = 真提权
}

/**
 * 探测 TUN 驱动在不在（**只读存在性**，绝不安装任何东西）。
 * Windows: wintun.sys（WireGuard/Tailscale 用）/ tap0901.sys（OpenVPN 用）
 * Linux: /dev/net/tun      macOS: /dev/utun0
 */
export function probeTun({ platform = process.platform, exists = fs.existsSync, windir = process.env.WINDIR || 'C:\\Windows' } = {}) {
  const candidates =
    platform === 'win32'
      ? [path.join(windir, 'System32', 'drivers', 'wintun.sys'), path.join(windir, 'System32', 'drivers', 'tap0901.sys')]
      : platform === 'darwin'
        ? ['/dev/utun0', '/dev/utun']
        : ['/dev/net/tun'];
  const found = candidates.filter((p) => {
    try {
      return exists(p);
    } catch {
      return false;
    }
  });
  return { present: found.length > 0, found, checked: candidates };
}

/** 探测 ssh 客户端在不在（复用 lib/net 的 findSsh，可注入） */
export function probeSsh({ exists = fs.existsSync, finder = findSsh } = {}) {
  let bin = null;
  try {
    bin = finder();
  } catch {
    bin = null;
  }
  const ok = !!bin && (bin === 'ssh' || exists(bin));
  return { present: ok, bin };
}

/**
 * `auto` 的完整探测 → 建议。**结果里没有 "apply" 这个字段**：不落盘。
 * 规则（三条同时满足才建议 free）：有管理员 + TUN 驱动在 + ssh 在。
 * @returns {{suggestion:'restricted'|'free', pinned:false, signals:{admin:boolean|null,tun:object,ssh:object}, reason:string}}
 */
export function suggestProfile({ platform = process.platform, run = defaultRun, exists = fs.existsSync, uid, windir } = {}) {
  const admin = probeAdmin({ platform, run, uid });
  const tun = probeTun({ platform, exists, windir });
  const ssh = probeSsh({ exists });
  const unknown = admin === null;
  const freeReady = admin === true && tun.present && ssh.present;
  const reasons = [];
  reasons.push(`管理员权限：${admin === true ? '有' : admin === false ? '没有' : '探不到（whoami 失败）'}`);
  reasons.push(`TUN 驱动：${tun.present ? `在（${tun.found.join(', ')}）` : '不在'}`);
  reasons.push(`ssh 客户端：${ssh.present ? `在（${ssh.bin}）` : '不在'}`);
  if (freeReady) reasons.push('三条都满足 ⇒ 可以走自由档（但**仍然**默认只用用户态转发）');
  else if (unknown) reasons.push('探不到关键信号 ⇒ 从严建议受限档');
  else reasons.push('不满足自由档的条件 ⇒ 建议受限档');
  return {
    suggestion: freeReady ? 'free' : 'restricted',
    pinned: false,
    signals: { admin, tun, ssh },
    reason: reasons.join('；'),
  };
}

/**
 * 落盘前的唯一校验：只有人能写档位，且只接受 restricted / free。
 * ⚠️ 传 `auto` 到这里的调用方是 bug（auto 是探测、不是设置）⇒ 直接拒。
 */
export function validatePin(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!PINNED_PROFILES.includes(v)) {
    return { ok: false, why: `--pin 只接受 restricted 或 free（收到 "${value}"；auto 是探测、不是档位）` };
  }
  return { ok: true, profile: v };
}

export default {
  PROFILES,
  PINNED_PROFILES,
  DEFAULT_PROFILE,
  normalizeProfile,
  allowedTransports,
  negotiate,
  probeAdmin,
  probeTun,
  probeSsh,
  suggestProfile,
  validatePin,
};
