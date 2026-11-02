// test/01-profile.test.mjs —— 传输档三档 + 两端协商 + auto 探测（卡面"三档各有夹具"那条）
import { createSuite } from './harness.mjs';
import { normalizeProfile, allowedTransports, negotiate, suggestProfile, validatePin, probeAdmin, probeTun, probeSsh, PROFILES } from '../lib/profile.mjs';

export async function run() {
  const s = createSuite('01 传输档 / 协商 / auto 探测');

  s.section('归一：三档 + 脏值');
  s.eq('restricted 原样', normalizeProfile('restricted').profile, 'restricted');
  s.eq('free 原样', normalizeProfile('free').profile, 'free');
  s.eq('auto 原样', normalizeProfile('auto').profile, 'auto');
  s.eq('大写也认', normalizeProfile('FREE').profile, 'free');
  s.eq('空 ⇒ 缺省 restricted（从严）', normalizeProfile('').profile, 'restricted');
  s.eq('空 ⇒ 标 wasInvalid=false', normalizeProfile('').wasInvalid, false);
  s.eq('乱写 ⇒ 回落 restricted', normalizeProfile('whatever').profile, 'restricted');
  s.eq('乱写 ⇒ 标 wasInvalid=true（如实报告）', normalizeProfile('whatever').wasInvalid, true);
  s.eq('三档常量', PROFILES, ['restricted', 'free', 'auto']);

  s.section('允许通道：overlay 只在 free 出现');
  s.eq('restricted 通道集', allowedTransports('restricted'), ['lan', 'tunnel']);
  s.eq('free 通道集（多一个可选 overlay）', allowedTransports('free'), ['lan', 'tunnel', 'overlay(optional)']);

  s.section('协商：取两端最保守档');
  const r1 = negotiate('restricted', 'free');
  s.eq('受限 + 自由 ⇒ restricted', r1.effective, 'restricted');
  s.eq('⇒ 不许 overlay', r1.allowOverlay, false);
  s.eq('⇒ 不是未确认状态', r1.unconfirmed, false);
  const r2 = negotiate('free', 'free');
  s.eq('自由 + 自由 ⇒ free', r2.effective, 'free');
  s.eq('⇒ 允许 overlay', r2.allowOverlay, true);
  const r3 = negotiate('auto', 'free');
  s.eq('auto 参与 ⇒ 按 restricted 计（不猜对方能装 TUN）', r3.effective, 'restricted');
  s.eq('auto 参与 ⇒ 标 unconfirmed（必须落盘）', r3.unconfirmed, true);
  const r4 = negotiate('restricted', 'auto');
  s.eq('auto 在对端也一样从严', r4.effective, 'restricted');
  s.eq('两端 auto ⇒ 仍 restricted', negotiate('auto', 'auto').effective, 'restricted');

  s.section('auto 探测：受限环境给 restricted（卡面明确要求这条）');
  // 受限环境注入：没有管理员、没有 TUN 驱动、ssh 在
  const restrictedEnv = {
    platform: 'win32',
    run: () => ({ status: 0, stdout: 'Mandatory Label\\Medium Mandatory Level S-1-16-8192', stderr: '' }),
    exists: (p) => /ssh\.exe$/.test(String(p)), // 只有 ssh.exe 存在
    windir: 'C:\\Windows',
  };
  const sugR = suggestProfile(restrictedEnv);
  s.eq('受限环境建议 = restricted', sugR.suggestion, 'restricted');
  s.eq('结果永远不落盘（pinned=false）', sugR.pinned, false);
  s.ok('受限环境给出可读理由', /管理员权限：没有|TUN 驱动：不在/.test(sugR.reason), sugR.reason);
  s.ok('探测结果里**没有** apply / write 之类字段', !('apply' in sugR) && !('wrote' in sugR));

  // 自由环境注入：有管理员 + 有 TUN + 有 ssh
  const freeEnv = {
    platform: 'win32',
    run: () => ({ status: 0, stdout: 'BUILTIN\\Administrators S-1-5-32-544 ... Mandatory Label\\High Mandatory Level S-1-16-12288', stderr: '' }),
    exists: (p) => /ssh\.exe$/.test(String(p)) || /wintun\.sys$/.test(String(p)),
    windir: 'C:\\Windows',
  };
  const sugF = suggestProfile(freeEnv);
  s.eq('自由环境建议 = free', sugF.suggestion, 'free');
  s.eq('自由环境仍不落盘', sugF.pinned, false);

  // 探不到管理员（whoami 失败）⇒ 从严
  const unknownEnv = {
    platform: 'win32',
    run: () => ({ status: 1, stdout: '', stderr: 'boom' }),
    exists: (p) => /ssh\.exe$/.test(String(p)) || /wintun\.sys$/.test(String(p)),
    windir: 'C:\\Windows',
  };
  const sugU = suggestProfile(unknownEnv);
  s.eq('探不到关键信号 ⇒ 从严 restricted', sugU.suggestion, 'restricted');
  s.eq('admin 探不到记 null（不是 false）', sugU.signals.admin, null);
  s.ok('理由里写明"探不到"', /探不到/.test(sugU.reason), sugU.reason);

  s.section('三个探测件单独可注入（夹具不需要碰真机）');
  s.eq('probeAdmin：无管理员组 ⇒ false', probeAdmin({ platform: 'win32', run: () => ({ status: 0, stdout: 'nothing', stderr: '' }) }), false);
  s.eq('probeAdmin：管理员组但中完整性 ⇒ false（未提权）', probeAdmin({ platform: 'win32', run: () => ({ status: 0, stdout: 'S-1-5-32-544 S-1-16-8192', stderr: '' }) }), false);
  s.eq('probeAdmin：高完整性 ⇒ true', probeAdmin({ platform: 'win32', run: () => ({ status: 0, stdout: 'S-1-5-32-544 S-1-16-12288', stderr: '' }) }), true);
  s.eq('probeAdmin：unix uid 0 ⇒ true', probeAdmin({ platform: 'linux', uid: 0 }), true);
  s.eq('probeAdmin：unix uid 1000 ⇒ false', probeAdmin({ platform: 'linux', uid: 1000 }), false);
  s.eq('probeTun：wintun 在 ⇒ present', probeTun({ platform: 'win32', exists: (p) => /wintun\.sys$/.test(p), windir: 'C:\\Windows' }).present, true);
  s.eq('probeTun：都没有 ⇒ 不在', probeTun({ platform: 'win32', exists: () => false, windir: 'C:\\Windows' }).present, false);
  s.eq('probeSsh：找不到 ⇒ absent', probeSsh({ exists: () => false, finder: () => 'ssh' }).present, true);
  s.eq('probeSsh：finder 抛错也不崩', probeSsh({ exists: () => false, finder: () => { throw new Error('x'); } }).present, false);

  s.section('--pin 只接受 restricted / free');
  s.eq('pin restricted', validatePin('restricted'), { ok: true, profile: 'restricted' });
  s.eq('pin free', validatePin('free'), { ok: true, profile: 'free' });
  s.eq('pin auto 被拒（auto 是探测不是档位）', validatePin('auto').ok, false);
  s.eq('pin 乱写被拒', validatePin('xyz').ok, false);

  return s.done();
}
