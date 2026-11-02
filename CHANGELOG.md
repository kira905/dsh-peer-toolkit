# 变更记录

本仓遵循语义化版本。日期格式 `YYYY-MM-DD`。

## 0.1.1 — 2026-11-02

脱敏修订：只收紧"扫描规则表本身会不会成为私有标识的载体"，**不改任何 CLI 行为**。

### 安全

- **脱敏规则表去字面量化**：`test/redact-scan.mjs` 的规则表拆成两层 ——
  通用规则（内网地址三段 / 用户目录 / 盘符绝对路径 / 密钥文件名形状 / 隧道服务商字样 /
  运行者用户名）留在仓里；**本部署专有词**（私有对端机名、本机主机名、机名简称、
  中转服务器地址、私有中转仓路径、中转侧账号与密钥名、生产树路径）改为从**仓外**注入，
  仓内不再出现任何私有标识字面量。理由：规则表本身是要发布的，写着具体机名的表等于把机名
  一起发出去 ——「规则不是数据」只在规则真的通用时才成立。
- 新增 `--deny-file <仓外路径>`：不带时照常跑通用规则、rc 仍可 `0`，但输出里**明确提示
  「词表未注入」**（机读面同样不静默）；带了却注入失败（文件不存在 / 空词表 / JSON 解析失败 /
  正则编译不过 / 词表落在被扫目录里）⇒ `rc=2` 报错，防"以为扫了其实没扫"。
  词表支持三种写法：`名字<TAB>正则<TAB>说明`、每行一个词、JSON 数组。
- 白名单撤掉「扫描器自身整文件放行」那一条（私有字面量搬走后不再需要）；现在只对
  「隧道服务商字样」这一条排除自身 —— 服务商品牌属通用词，且必然与规则表自身字形重合。

### 测试

- 新增 `test/07-redact-scan.test.mjs`（30 条断言）：两层规则、注入通道正控 / 负控、
  注入失败必须红、`--json` 机读面不静默、白名单不再有 `*` 通配。
- 新增 `test/deny-terms.example.txt`：仓外词表的形状示例（**只含占位词**）。
- 全套 `node test/run.mjs`：8 个夹具 / 291 条断言。

### 文档

- README（中英）新增 §4.1「规则表只放通用形状，专有词从仓外注入」，含 `--deny-file` 用法、
  三种词表格式与行为约定；目录树补上新增的两个测试文件。

## 0.1.0 — 2026-11-02

首个公开版本。四件多机协同工具 + 一套同机双实例验收夹具。

### 新增

**件① 信箱（跨机投递消息 + 回执）**
- `dsh-mailbox.mjs`：`keygen` / `status` / `send --text|--cmd` / `wait` / `results` / `inbox`。
- `dsh-peer-agent.mjs`：`--once` / `--dry-run` / `--loop N` / `--status` / `--self-test`；
  **默认不执行命令**，`exec` 类信封需 `--allow-exec` 才跑，否则回一条 `refused` 回执。
- 信封 = AES-256-GCM（`lib/envelope.mjs`）：密钥只在两端本地，介质里无明文，
  篡改一个字节即解不开（GCM 认证）。
- spool 目录协议（`inbox` / `outbox` / `done` / `rejected`），原子写、不覆盖已存在文件。
- 介质不绑平台：共享盘 / 私有 git 仓 / 本仓的 `dsh-peer-sync` 都行（本仓不实现搬运协议）。

**件② 选路（走内网还是走隧道）**
- `dsh-peer-arbiter.mjs`：`decide`（默认干跑）/ `decide --apply` / `status`。
- 判决抽成纯函数 `lib/decide.mjs`（零 I/O）：夹具验的就是生产跑的那一份。
- 三条规则：迟滞（连续 2 轮"不需要"才关）、幂等（已在听则零动作）、
  **探不到就不动手**（`probe-unknown`，既不硬起也不硬停）。

**件③ 文本同步（先比对、只传差量、从不删除）**
- `dsh-peer-sync.mjs`：`plan`（默认干跑）/ `plan --apply` / `status`，以及对端用的
  `--internal-compare` / `--internal-place` / `--internal-put` / `--internal-get` / `--internal-tmpdir`。
- 覆盖规则抽成纯函数 `lib/sync-rules.mjs`：新增 / 更新（覆盖前备份）/ 跳过（对端较新）/
  冲突副本 / 双写黑名单 / 内容相同 六种，另加"冲突副本去重"。
- 批次包容器 `lib/packfile.mjs`（一行头 + 每文件一行 JSON，base64 内联），按字节切批。
- 🔴 从不删除任何目标文件；不提供 `--delete` / `--purge`。

**件④ 隧道生命周期 + 传输档**
- `dsh-peer-tunnel.mjs`：`profile` / `up` / `down` / `status` / `doctor`。
- 只做用户态 `ssh -L` 端口转发；本地端**代码内固定** `127.0.0.1`，配置改成别的会被拒（`rc=2`），
  起来后发现绑定非环回**立刻自关**。
- `down` 只杀 pid 文件里记录的那个进程；端口被别人占着时只报告，不误杀。
- 传输档 `lib/profile.mjs`：`restricted` / `free` / `auto` 三档，**每台机各自声明**，
  协商取两端最保守档；`auto` 只做建议（探测管理员 / TUN 驱动 / ssh 客户端），**绝不自动落盘**，
  落盘必须 `profile --pin <restricted|free> --apply`。

**公共件**
- `lib/cli-args.mjs`：所有 CLI 共用参数闸 —— `--help` 打印用法并 `rc=0`（不执行动作），
  未知参数 `rc=2` 立刻退出。
- `lib/config.mjs`：配置原子写；默认数据根 `~/.dsh-peer`（**不写 `~/.dsh`**）。
- `lib/net.mjs`：TCP 探活、LISTENING 绑定地址解析、"只许环回"的唯一断言点。
- `lib/ssh.mjs`：隧道与远端执行共用同一份 ssh 参数；known_hosts 缺省放本仓 state，
  **不写用户的 `~/.ssh/known_hosts`**。
- `lib/runner.mjs`：`local`（演练）/ `ssh`（真跨机）两种执行器；传文件走自带脚本（stdin/stdout），
  不依赖 scp，也不依赖对端有 `cat`。

### 安全与约束

- 🔴 不引入任何第三方运行时依赖（只用 `node:` 内置模块）。
- 🔴 不装 TUN 驱动、不装第三方网络客户端、不注册常驻服务、不起守护。
- 🔴 通道只绑环回；不提供任何"暴露到局域网"的开关。
- 远端执行**只允许固定入口 + 固定子命令**，不支持拼接任意命令字符串。
- 对端 shell 兼容 `cmd.exe`（探针用 `exit 0` 而不是 `true`）。

### 测试

- `test/run.mjs` 一套跑全部：7 个夹具 / 262 条断言。
- `99-dual-instance.test.mjs`：**同机双实例闭环**（真 `ssh -L`）——
  投信 → 对面收到 → 回执 → 选路切换 → 起隧道 → 对面可达 → 关隧道 → 不可达且无残留进程；
  并断言全程只有环回监听、源码里没有任何"注册服务/计划任务"的调用。

### 未包含（指针）

- `peer-channel` / `dsh-session-mirror` 留在 `dsh-board-toolkit`（与看板有真实耦合），见 README §7。
- `postcard` / `life-shared-push` / `life-say-collector` / `hands-tunnel` / WOL 唤醒件 /
  `merge-memory` / `attrib-ledger` 的理由见 README §7。
