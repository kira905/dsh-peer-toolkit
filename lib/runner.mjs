// lib/runner.mjs —— 「在对端跑脚本 / 传文件」的两种执行器（零依赖）
//
// 两种模式，**同一套接口**：
//   local  本机直接跑（夹具与"同机双实例"演练用；remotePath 就是本机路径）
//   ssh    经 ssh 在对端跑 `node <remoteScript> <sub> <args...>`
//
// ── 为什么传文件不走 scp ──────────────────────────────────────────────────────
// 我们的对端有 Windows（默认 shell 是 cmd.exe，连 `cat` 都没有）。scp 也依赖对端路径写法，
// 引号/盘符坑特别多。改用**同一份脚本自己收发**：
//   put  = ssh ... node <script> --internal-put <dest>   （stdin 传二进制）
//   get  = ssh ... node <script> --internal-get <src>    （stdout 出二进制）
// 两端都是 node ⇒ 跨平台、二进制安全、只依赖一个我们自己的入口。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sshBase, remoteNodeArgs, remoteProbeArgs } from './ssh.mjs';

export const RUNNER_MODES = ['local', 'ssh'];

/** 本机执行器：用来跑夹具、以及"两台实例都在本机"时的演练 */
export function localRunner({ cwd = process.cwd() } = {}) {
  return {
    kind: 'local',
    /** 跑一个 node 脚本（`scriptPath` = 本机绝对路径） */
    node(scriptPath, argv = [], opts = {}) {
      const r = spawnSync(process.execPath, [scriptPath, ...argv], {
        cwd: opts.cwd ?? cwd,
        encoding: 'utf8',
        input: opts.input,
        timeout: opts.timeoutMs ?? 120_000,
        windowsHide: true,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
      return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error ? String(r.error.message) : null };
    },
    put(buf, dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return { code: 0, stdout: '', stderr: '' };
    },
    get(src) {
      try {
        return { code: 0, buffer: fs.readFileSync(src), stderr: '' };
      } catch (e) {
        return { code: 1, buffer: null, stderr: String(e?.message ?? e) };
      }
    },
    probe() {
      return { ok: true, why: 'local（无需连接）' };
    },
  };
}

/**
 * ssh 执行器。
 * @param {object} cfg 配置（见 lib/config.mjs）
 * @param {{flags?:object, sshBin?:string|null, remoteScript?:string}} opts
 *        remoteScript = 对端那份 dsh-peer-sync.mjs 的绝对路径（cfg.sync.remoteRepoPath + 文件名）
 */
export function sshRunner(cfg, { flags = {}, sshBin = null, remoteScript = null, timeoutMs = 120_000 } = {}) {
  const base = sshBase(cfg, { flags, sshBin });
  const script = remoteScript || path.posix.join(String(cfg?.sync?.remoteRepoPath || '.').replace(/\\/g, '/'), 'dsh-peer-sync.mjs');
  const run = (args, opts = {}) =>
    spawnSync(base.sshBin, args, {
      encoding: opts.binary ? null : 'utf8',
      input: opts.input,
      timeout: opts.timeoutMs ?? timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  return {
    kind: 'ssh',
    sshBin: base.sshBin,
    base,
    /** 在对端跑 `node <script> <argv...>` */
    node(_scriptIgnored, argv = [], opts = {}) {
      const r = run(remoteNodeArgs(base, script, argv), opts);
      return {
        code: r.status,
        stdout: String(r.stdout || ''),
        stderr: String(r.stderr || ''),
        error: r.error ? String(r.error.message) : null,
      };
    },
    put(buf, dest) {
      const r = run(remoteNodeArgs(base, script, ['--internal-put', dest]), { input: buf });
      return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    },
    get(src) {
      const r = run(remoteNodeArgs(base, script, ['--internal-get', src]), { binary: true });
      return { code: r.status, buffer: r.stdout ?? null, stderr: String(r.stderr || '') };
    },
    /** 认证探针：只跑 `true`，不碰任何业务 */
    probe() {
      const r = run(remoteProbeArgs(base), { timeoutMs: 20_000 });
      const err = String(r.stderr || '');
      if (r.status === 0) return { ok: true, why: '认证通过（零 shell 属预期）' };
      if (/Permission denied/i.test(err)) return { ok: false, why: '认证失败（Permission denied）：密钥没被对端接受' };
      if (/Connection (timed out|refused)/i.test(err)) return { ok: false, why: '连不上（超时/拒绝）：地址或端口不对' };
      return { ok: false, why: `ssh 退出码 ${r.status}：${err.split(/\r?\n/)[0] || '(无输出)'}` };
    },
  };
}

export default { localRunner, sshRunner, RUNNER_MODES };
