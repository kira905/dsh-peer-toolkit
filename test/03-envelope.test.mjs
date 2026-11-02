// test/03-envelope.test.mjs —— 信封加密 / spool 目录协议（件 mailbox 的安全底座）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSuite } from './harness.mjs';
import {
  seal, unseal, keyFingerprint, generateKey, loadKey, cutStream, newId, sha256,
  ensureSpool, writeEnvelope, listEnvelopes, readEnvelope, moveEnvelope, spoolStats, INBOX, OUTBOX, DONE, REJECTED,
} from '../lib/envelope.mjs';

export async function run() {
  const s = createSuite('03 信封 / spool 协议');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-env-'));
  const keyA = crypto.randomBytes(32);
  const keyB = crypto.randomBytes(32);

  s.section('加密往返');
  const body = { v: 1, id: 't-1', kind: 'text', text: '你好，对端' };
  const sealed = seal(body, keyA);
  s.eq('往返一致', unseal(sealed, keyA), body);
  s.ok('信封里没有明文', !sealed.includes('你好'), '密文里出现了明文！');
  s.ok('信封带指纹', /"fp":\s*"[0-9a-f]{16}"/.test(sealed), sealed.slice(0, 80));
  s.eq('指纹 = sha256(key) 前 16', keyFingerprint(keyA), crypto.createHash('sha256').update(keyA).digest('hex').slice(0, 16));

  s.section('错密钥 / 篡改 / 版本 —— 必须抛（= 拒收）');
  s.throws('错密钥解不开', () => unseal(sealed, keyB), /指纹不匹配|unable to authenticate|bad decrypt/i);
  const tampered = (() => {
    const o = JSON.parse(sealed);
    const b = Buffer.from(o.ct, 'base64');
    b[0] ^= 0xff; // 改一个字节
    o.ct = b.toString('base64');
    return JSON.stringify(o);
  })();
  s.throws('密文改一字节 ⇒ GCM 认证失败', () => unseal(tampered, keyA));
  s.throws('协议版本不支持 ⇒ 抛', () => unseal(JSON.stringify({ v: 99, iv: 'x', tag: 'y', ct: 'z' }), keyA), /协议版本/);

  s.section('密钥文件：三种形态都认');
  const kp = path.join(root, 'mailbox.key');
  const g1 = generateKey(kp, true);
  s.ok('首建 created=true', g1.created === true);
  s.eq('指纹可读', typeof g1.fingerprint, 'string');
  s.eq('裸 32 字节可直接读', loadKey(kp).length, 32);
  const g2 = generateKey(kp, false);
  s.eq('再跑不 force ⇒ 复用', g2.created, false);
  const hexPath = path.join(root, 'hex.key');
  fs.writeFileSync(hexPath, keyA.toString('hex'), 'utf8');
  s.eq('64 位 hex 形态', loadKey(hexPath).equals(keyA), true);
  const b64Path = path.join(root, 'b64.key');
  fs.writeFileSync(b64Path, keyA.toString('base64'), 'utf8');
  s.eq('base64 形态', loadKey(b64Path).equals(keyA), true);
  s.throws('不存在 ⇒ 抛（提示先 keygen）', () => loadKey(path.join(root, 'nope.key')), /密钥不存在/);

  s.section('输出裁剪：截断要如实标');
  const big = 'x'.repeat(1000);
  const cut = cutStream(big, 100);
  s.eq('超上限 ⇒ truncated=true', cut.truncated, true);
  s.eq('原始字节数如实', cut.bytes, 1000);
  s.eq('留下 100 字节', cut.text.length, 100);
  const small = cutStream('ok', 100);
  s.eq('没超 ⇒ truncated=false', small.truncated, false);

  s.section('id / sha');
  const ids = new Set(Array.from({ length: 50 }, () => newId('m')));
  s.eq('50 个 id 全不重复', ids.size, 50);
  s.eq('sha256 稳定', sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  s.section('spool 目录协议');
  const spool = path.join(root, 'spool');
  ensureSpool(spool);
  for (const d of [INBOX, OUTBOX, DONE, REJECTED]) s.ok(`目录 ${d} 已建`, fs.existsSync(path.join(spool, d)));
  writeEnvelope(path.join(spool, INBOX), 'm-1', seal({ id: 'm-1', kind: 'text', text: 'a' }, keyA));
  writeEnvelope(path.join(spool, INBOX), 'm-2', seal({ id: 'm-2', kind: 'text', text: 'b' }, keyA));
  s.eq('listEnvelopes 排序', listEnvelopes(path.join(spool, INBOX)), ['m-1', 'm-2']);
  s.eq('readEnvelope 解得出', unseal(readEnvelope(path.join(spool, INBOX), 'm-1'), keyA).text, 'a');
  const mv = moveEnvelope(path.join(spool, INBOX), path.join(spool, DONE), 'm-1');
  s.eq('移动成功', mv.moved, true);
  s.ok('源已不在', !fs.existsSync(path.join(spool, INBOX, 'm-1.json')));
  s.ok('目标在', fs.existsSync(path.join(spool, DONE, 'm-1.json')));
  const mv2 = moveEnvelope(path.join(spool, DONE), path.join(spool, DONE), 'm-1');
  s.eq('目标已存在 ⇒ 不覆盖', mv2.moved, false);
  const st = spoolStats(spool);
  s.eq('积压读数 inbox', st.inbox, 1);
  s.eq('积压读数 outbox', st.outbox, 0);
  s.eq('积压读数 done', st.done, 1);

  s.section('原子写：不会留 .tmp');
  const left = fs.readdirSync(path.join(spool, INBOX)).filter((f) => f.endsWith('.json') === false);
  s.eq('inbox 里没有残留 tmp', left, []);

  fs.rmSync(root, { recursive: true, force: true });
  return s.done();
}
