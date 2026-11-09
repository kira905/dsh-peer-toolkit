# dsh-peer-toolkit · 多机协同小工具

> ### 这是什么
> **多机协同四件**：加密信箱、选路、文本同步、按需隧道 —— 让两台机器上的助手互相说话。
>
> ### 它解决什么
> 多机协同真正的难点不是"怎么连"，是**每台机的环境不一样**：有的机器是企业机，装不了 TUN 客户端、起不了常驻服务。所以这里只做**用户态 `ssh -L` 端口转发**，并且每台机各自声明一个传输档（`restricted` / `free`），协商时**取两端最保守的那一档**。隧道要用才起、用完关掉，不留常驻进程。
>
> ### 一条命令跑起来
> ```powershell
> npm i -g @kira905/dsh-peer-toolkit
> dsh-mailbox keygen        # 两端用同一把密钥
> dsh-mailbox send --text "hello"
> ```
>
> ### 先看它长什么样（真实输出）
> ```text
> 用法
>   node dsh-mailbox.mjs <keygen|status|send|wait|results|inbox> [选项]
>
> 跨机投递消息 / 下发命令 + 收回执（信封加密；spool 目录怎么到对面由你选）
> ```
>
> ⚠️ 跨机工具的价值在"第二台机器"上 —— 只有一台机时，照 README 用**同机双实例**跑一遍闭环。

> ### 它不附带什么（先看清楚，省得装完失望）
>
> 这套开源出来的是**能用的工具 + 装完自检 + 设计文档**。有两块**不在开源范围里**：
>
> 1. **「自己盯着活干」的那套引擎**：定时调度、队列盯守、管家日报、自主决定要不要动手 —— 这几件还没整理出来放（整理完会陆续放）。它的**设计本身是公开的**，写在 [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design) 仓里，想自己实现的人照着做得到。
> 2. **「出事喊到人」的通道**：企业微信、语音播报这类 —— **不随开源发布**。
>
> 所以：装完你拿到的是一套**能用的工具**，不是一个会自己上班的管家。

---

> **本仓是命令行工具，不挂宿主界面，不需要 `dsh.bundle`（插件 `package.json` 里那行「让 DSH 启动时自动挂上我」的声明）、不需要写 `cordis.patch.yml`（DSH 读的插件挂载清单）。**
> 装它 = `npm i -g @kira905/dsh-peer-toolkit`（或 `npx -p @kira905/dsh-peer-toolkit dsh-peer-tunnel`）。
> 装进 `profile`（放插件的那个格子：`~/.dsh/profiles/<名字>`）也对，但那条 `declares no dsh.bundle` 警告是**正常现象**，不是故障。

## ⚠️ 先读这段（比任何用法都重要）

1. **跨机工具的最大坑：你只有一台机器。**
   本仓四件工具的全部价值都在"第二台机器"上。单机装完什么也干不了 —— 这不是 bug，
   这是跨机工具的本性。所以本仓**自带一套"同机双实例"演练**（见 §4）：用同一台机的两个目录 +
   两个端口当两台机，能在**没有第二台机器的情况下**把完整闭环跑一遍。**只有"能装"不算装好。**
2. **隧道只做一种实现：用户态 `ssh -L` 端口转发。**
   不装 TUN 驱动、不装第三方网络客户端、不注册常驻服务、不起守护进程。
   为什么只有这一种、什么情况下你可以换成 overlay 网络：见 **§5**（本节是本仓的设计重心）。
3. **本地端口只绑环回（`127.0.0.1`）。**
   这是代码里写死的，不是默认值 —— 配置里改成 `0.0.0.0` 会被直接拒绝（`rc=2`），
   隧道起来后发现绑定不是环回会**立刻自关**。本仓不会把通道暴露到局域网上。
4. **信箱的 agent 默认不执行命令。**
   `dsh-peer-agent` 收到 `exec` 类信封时，没有 `--allow-exec` 就拒执行并回一条 `refused` 回执。
   要执行必须由**机器的主人**把 `--allow-exec` 写进自己的调度命令里（见 §3.1）。
5. **本仓默认不往 `~/.dsh` 写任何东西。**
   自己的东西放 `~/.dsh-peer`（可用 `DSH_PEER_HOME` / `--config` 改）。DSH 自己的目录不归本仓管。
6. **`--help` 绝不执行动作。** 五个命令都接了参数闸：`--help` → `rc=0` 只打印用法；
   不认识的参数 → `rc=2` 立刻退出，**后面一行都不跑**。

---

## 装完自检（三条只读验法）

```powershell
# ① 命令在不在（只看文件存在，不执行）
Test-Path "$env:APPDATA\npm\dsh-peer-tunnel.CMD"     # npm i -g 装的
# 期望：True（装进某个 profile 就查 <数据根>/profiles/<profile>/node_modules/.bin/ 下同名文件）

# ② 用法能打出来，且不执行任何动作（rc 必须是 0）
node .\dsh-peer-tunnel.mjs --help

# ③ 只读自检：档位 / 隧道状态 / 配置是否合法
node .\dsh-peer-tunnel.mjs status
node .\dsh-peer-tunnel.mjs doctor      # 会做一次 ssh 认证探针（只跑 `exit 0`，不碰业务）
```

> 这三条都不写盘、不起进程。要跑真东西，先看 §4 的双实例演练。

---

## 同源说明

本仓**部分文件与一套内部生产实现同源**（同一份工程长期演进下来的两处落点）。

- **同源程度**：本仓是那套实现的**提炼导出**：**不是逐字副本，也不是完全重写**。
  生产件里绑死私有部署的部分（固定盘符、私有中转仓、固定的对端主机名、内网地址、隧道服务商）
  在导出时**全部换成了参数或示例值**；跨机取数的两件（见 §7）留在它们原来的仓里，本仓只写指针。
- **怎么判断差别**：本仓所有 CLI 都接了 `lib/cli-args.mjs`（生产的几件没有参数闸），
  所有默认值都是 RFC 5737 文档地址（`192.0.2.x`）与占位主机名 —— 拿单个文件当"生产实现"读之前，
  先看它有没有这两个特征。
- **许可**：本仓许可见仓根 `LICENSE`。

---

## 1. 环境与安装

```powershell
# Node 18+；无需 npm install（零第三方运行时依赖，只用 node: 内置模块）
node --version

# 直接用（在仓根）
node .\dsh-peer-tunnel.mjs profile

# 或者装到全局用 bin 名
npm i -g @kira905/dsh-peer-toolkit
dsh-peer-tunnel profile
```

需要系统里有 **ssh 客户端**（Windows 10+ 自带 `System32\OpenSSH\ssh.exe`；Linux/macOS 自带）。
本仓**不实现** ssh 协议，只调用系统自带的那一个。

### 环境变量（都可选）

| 变量 | 用在 | 含义 | 缺省 |
|---|---|---|---|
| `DSH_PEER_HOME` | 全部 | 本仓的数据根（配置 / 状态 / known_hosts） | `~/.dsh-peer` |
| `DSH_PEER_CONFIG` | 全部 | 直接指定配置文件路径（比上一条更精确） | `$DSH_PEER_HOME/peer-config.json` |

---

## 2. 仓库结构（全量文件）

```
dsh-peer-toolkit/
├── dsh-mailbox.mjs          # 件① 控制端：投消息 / 下发命令 + 等回执
├── dsh-peer-agent.mjs       # 件① 执行端：取信封 →（可选）执行 → 写回执
├── dsh-peer-arbiter.mjs     # 件② 选路：走内网还是走隧道
├── dsh-peer-sync.mjs        # 件③ 文本同步：先比对、只传差量、从不删除
├── dsh-peer-tunnel.mjs      # 件④ 隧道生命周期 + 传输档（restricted/free/auto）
├── lib/
│   ├── cli-args.mjs         # 参数闸（--help 不执行动作 / 未知参数 rc=2）
│   ├── config.mjs           # 配置读写（原子写）、路径约定、"只绑环回"自检
│   ├── net.mjs              # 端口探活 / LISTENING 绑定地址 / ssh 定位 / 进程判活
│   ├── ssh.mjs              # ssh 参数拼装（隧道与远端执行共用同一份）
│   ├── runner.mjs           # 对端执行器：local（演练）/ ssh（真跨机）
│   ├── profile.mjs          # ★ 传输档三档 + 两端协商 + auto 探测（见 §5）
│   ├── decide.mjs           # ★ 选路纯判决（零 I/O，夹具直接 import）
│   ├── envelope.mjs         # 信封（AES-256-GCM）+ spool 目录协议
│   ├── sync-rules.mjs       # ★ 覆盖规则纯函数（见 §3.3 的规则表）
│   ├── packfile.mjs         # 批次包容器（一行头 + 每文件一行 JSON）
│   └── files.mjs            # 遍历 / 哈希 / 排除规则 / 路径逃逸校验
├── test/
│   ├── run.mjs              # 跑全部（`--fast` 跳过 e2e）
│   ├── 01-profile.test.mjs  # 三档 + 协商 + auto 探测
│   ├── 02-decide.test.mjs   # 选路判决全情形
│   ├── 03-envelope.test.mjs # 加密 / 篡改 / spool 协议
│   ├── 04-sync-rules.test.mjs # 覆盖规则全枚举
│   ├── 05-cli-help.test.mjs # --help 不执行动作 / 未知参数 rc=2
│   ├── 06-sync-local.test.mjs # 同步三段式真跑（本机两个目录）
│   ├── 07-redact-scan.test.mjs # ★ 脱敏扫描器自身：两层规则 / 注入通道 / 红黑判定
│   ├── 99-dual-instance.test.mjs # ★ 同机双实例闭环（真 ssh -L）
│   ├── redact-scan.mjs      # 发布前脱敏扫描（通用规则在仓里，专有词从仓外 --deny-file 注入）
│   └── deny-terms.example.txt # 仓外 deny 词表的形状示例（只含占位词）
├── README.md
├── README.en.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── .gitignore
└── .gitattributes
```

---

## 3. 逐件说明

### 3.1 信箱：`dsh-mailbox`（控制端）+ `dsh-peer-agent`（执行端）

**它解决什么**：两台机器**不需要同时在线**也能协作。控制端把信封丢进 spool 目录，
对面的 agent 醒来取走、执行、（可选）把回执写回去。介质只负责"把目录搬过去"。

**信封是加密的**（AES-256-GCM）：中转介质往往是"我们控制不住的那一段"（云盘 / 别人能读的仓）。
加密 + GCM 认证 ⇒ ① 介质里没有明文；② 没有密钥的人改一个字节就解不开，伪造不出可执行指令。

| 命令 | 做什么 |
|---|---|
| `dsh-mailbox keygen` | 生成 32 字节对称密钥（**两端必须是同一把**） |
| `dsh-mailbox send --text "…"` | 投一条**纯消息**（对端不执行任何东西） |
| `dsh-mailbox send --cmd "…" [--wait]` | 投一条**要执行**的指令（对端需 `--allow-exec`） |
| `dsh-mailbox wait <id>` | 等某条的回执 |
| `dsh-mailbox results [--take]` | 列回执（`--take` 移进 `done/`） |
| `dsh-peer-agent --once` | 跑一轮：取信封 → 处理 → 回执（**默认不执行**） |
| `dsh-peer-agent --once --allow-exec` | 同上，但允许执行 `exec` 类信封 |

**spool 目录怎么到对面**（本仓不管、也不绑平台，你选一种）：

1. **共享盘 / 同步盘**（最简单：两端挂到同一个目录）；
2. **一个私有 git 仓的孤立分支**（我们生产用的就是这种：只 `fetch/push` 那个分支）；
3. **本仓自己的 `dsh-peer-sync`** 经隧道推过去（见 §3.3）。

> 本仓**不做**端到端的心跳或长连接：对面离线三天也不会丢信封，醒来一次性处理。

**退出码**：`0` 成功 · `1` 回执 `ok=false` / 执行失败 · `2` 参数或配置错 · `4` 等不到回执。

### 3.2 选路：`dsh-peer-arbiter`

**它判什么**：内网直连（`peer.lanHost:lanPort`）通不通 —— 通就走内网；不通就起隧道。
判决本身是**纯函数**（`lib/decide.mjs`，零 I/O），本件只是"观测 → 判决 → 执行"的薄壳。

| 命令 | 做什么 |
|---|---|
| `dsh-peer-arbiter decide` | **干跑（默认）**：只看观测与判决，不动任何东西 |
| `dsh-peer-arbiter decide --apply` | 真动：该起就起、该关就关 |
| `dsh-peer-arbiter status` | 只读：档位 / 观测 / 最近一次判决 |

三条规则（写在 `lib/decide.mjs` 里，夹具逐条钉住）：

- **迟滞**：判到"不需要隧道"要**连续 2 轮**才真关（防抖；`--confirm-rounds` 可调）；
- **幂等**：目标 up 且隧道已在听 ⇒ **零动作**（绝不重复建连：第二次 `ssh -L` 会抢同一个本地端口）；
- **探不到不动手**：探活失败（既非通也非不通）⇒ 只记一行等下一轮，**不硬起也不硬停**。

> 本仓**不装计划任务、不起守护**。要周期跑，用你系统自己的调度（Windows 的「任务计划程序」、
> cron、systemd timer 都行）；调度命令里再加 `--apply`。**要不要常驻是运维决定，不是工具的默认。**

### 3.3 文本同步：`dsh-peer-sync`

**它解决什么**：两台机器上的文档互相同步时，"全推过去"等于**用本机覆盖对端**，
而对端自己也在产文档。所以它是**先比对、只传差量**，且**从不删除**。

三段式：**A 本机出清单** → **B 对端比对（只读）** → **C 分批传 + 落位**。

| 命令 | 做什么 |
|---|---|
| `dsh-peer-sync plan` | **干跑（默认）**：A/B 真跑（只读），C 只出计划 —— 零传输、零写入 |
| `dsh-peer-sync plan --apply` | 真传 + 落位 |
| `dsh-peer-sync plan --runner local --local-dir A --remote-dir B` | 本机两个目录当两台机（演练/夹具） |
| `dsh-peer-sync status` | 只读：配置里的目录对 |

**覆盖规则（这条错了就是不可逆的文档覆盖，所以写死在这里）**：

| 情形 | 结论 |
|---|---|
| 对端没有 | **新增**（传） |
| 同名、本机更新、内容不同 | **更新**（传；覆盖前写 `<名>.bak-<stamp>` 备份） |
| 同名、对端更新、内容不同 | **跳过**（绝不反向覆盖） |
| 同名、内容不同、mtime 判不了谁新 | **冲突**：原件不动，落 `<名>.conflict-<tag>-<stamp>` 副本 |
| 命中双写黑名单 | **永不覆盖**（配置 `sync.dualWrite` 里的正则），只落冲突副本 |
| 内容相同（sha 相等 / size+mtime 都相等） | **跳过** |

🔴 **绝不删除**任何目标文件；也不提供 `--delete` / `--purge`。唯一会被清理的是我们自己的
`.bak-*` 备份 —— 而且本仓**不自动清理**（备份会累积，你自己按需删）。

**退出码**：`0` 完成（含"无变化"）· `2` 参数/配置错 · `3` **让路**（对端不可达 / 通道不通 —— 物理常态，不是失败）· `1` 真失败。

### 3.4 隧道：`dsh-peer-tunnel`

| 命令 | 做什么 |
|---|---|
| `profile` | 看两端档位 + 协商结果（只读） |
| `profile --auto` | 探测本机，**只给建议**（不落盘） |
| `profile --pin free --apply` | **人确认**后落盘（只有这条会写配置） |
| `up` | 起隧道（已在跑则复用，幂等） |
| `down` | 停隧道（只杀本文件记录的 pid） |
| `status` / `doctor` | 只读状态 / 只读自检 |

**退出码**：`0` 成功 · `2` 参数或配置错 · `5` 起来但端口没在听 · `6` 停了但端口仍被占 · `7` 自检有失败项 · `10` 隧道不在。

---

## 4. 怎么把它跑起来（同机双实例演练 —— 没有第二台机器也能验）

思路：**一台机当两台机用** —— 两个数据根 + 两个端口 + 一个两边都能看到的 spool 目录。
下面这段就是 `test/99-dual-instance.test.mjs` 在跑的东西，可以照着手工做一遍。

```powershell
# 0) 准备两个"实例"（两个数据根）
$A = "$env:TEMP\peer-a"; $B = "$env:TEMP\peer-b"
New-Item -ItemType Directory $A, $B -Force | Out-Null
$spool = "$env:TEMP\peer-spool"

# 1) 两端各写一份配置（示例端口 19080 / 19081，换成你机器上空闲的）
#    A 的 peer.sshHost 写 127.0.0.1 = "对端就是本机"（真跨机时写对端地址）
#    ⚠️ tunnel.bind 必须是 127.0.0.1，写别的会被拒
@'
{ "self":  { "name": "node-a", "transportProfile": "restricted" },
  "peer":  { "name": "node-b", "transportProfile": "free",
             "lanHost": "127.0.0.1", "lanPort": 19081,
             "sshHost": "127.0.0.1", "sshPort": 22, "sshUser": "<你在这台机上的用户名>",
             "keyPath": "~/.ssh/id_ed25519_demo" },
  "tunnel":  { "bind": "127.0.0.1", "localPort": 19080, "remotePort": 19081 },
  "mailbox": { "spoolDir": "<上面那个 spool 路径>", "keyPath": "<一个密钥文件路径>" },
  "sync":    { "remoteRepoPath": "<本仓在对端的绝对路径>" } }
'@ | Set-Content "$A\peer-config.json" -Encoding utf8

# 2) 投信 → 对面收到 → 回执
$env:DSH_PEER_HOME = $A; node .\dsh-mailbox.mjs keygen
node .\dsh-mailbox.mjs send --text "在吗" --wait        # ← 这句会等；另开一个窗口跑下一步
$env:DSH_PEER_HOME = $B; node .\dsh-peer-agent.mjs --once

# 3) 选路：内网通走内网；内网断则判"该起隧道"
$env:DSH_PEER_HOME = $A; node .\dsh-peer-arbiter.mjs decide

# 4) 起隧道 → 经隧道访问对端 → 关隧道 → 不可达
node .\dsh-peer-tunnel.mjs up
#   此时 127.0.0.1:19080 就是"对端的 19081"（对面得真有服务在听）
node .\dsh-peer-tunnel.mjs down
node .\dsh-peer-tunnel.mjs status      # rc=10 = 隧道不在
```

**自证判据（照抄夹具的断言，一个字都不用改）**：

- `netstat -ano -p TCP | findstr :19080` ⇒ **只有** `127.0.0.1:19080 LISTENING`，没有 `0.0.0.0:19080`；
- `down` 之后同一个端口**零 LISTENING**，且 `tasklist` 里那个 pid 已经没了；
- 全程没有新增任何服务 / 计划任务（本仓源码里就没有 `schtasks` / `New-Service` / `Register-ScheduledTask` 这类调用）。

> 想直接跑夹具：`node test/run.mjs`（约 20~25 秒，会真起一次 ssh 隧道）。
> `node test/run.mjs --fast` 跳过 e2e（约 4 秒）。
> e2e 需要本机 sshd 在跑、且有一把能免密登录自己的密钥（缺省找 `~/.ssh/id_ed25519_*`，
> 可用 `PEER_E2E_KEY` / `PEER_E2E_SSHUSER` 指定）。**缺前置会明确失败，不会静默跳过。**

### 4.1 发布前脱敏扫描：规则表只放通用形状，专有词从仓外注入

`test/redact-scan.mjs` 是本仓自己用的发布前把关件（零依赖、只读）。它分**两层**规则：

| 层 | 放在哪 | 内容 |
|---|---|---|
| **通用规则** | 就在仓里（这个文件） | 内网地址三段（`192.168/16`、`10/8`、`172.16/12`）、用户目录、盘符绝对路径、密钥文件名形状、隧道服务商字样、**当前运行者**的用户名（从环境变量取，不落字面） |
| **本部署专有词** | **不在仓里** —— 仓外 deny 文件 | 私有对端机名 / 本机主机名 / 机名简称 / 中转服务器地址 / 私有中转仓路径 / 中转侧账号与密钥名 / 生产树路径 …… 凡是"只对某一套部署成立"的词 |

**为什么这么分**：规则表本身是要发布的。一张写着具体机名的表，等于把机名一起发出去 ——
「规则不是数据」只在规则**真的通用**时才成立。所以仓里只留通用形状，具体词一律靠
`--deny-file` 从**仓外**注入（与业界同类扫描器同一个取舍：*the rule table can be published
without publishing anything private*）。

```bash
node test/redact-scan.mjs                          # 只用通用规则（会明确提示"词表未注入"）
node test/redact-scan.mjs <目录>                   # 扫指定目录
node test/redact-scan.mjs --deny-file <仓外路径>   # 追加本部署专有词表（必须在被扫目录之外）
node test/redact-scan.mjs --deny-file <路径> --json # 机器可读（stdout 只有 JSON）
```

> 也有 npm script：`npm run test:redact` = 上面第一条（**只跑通用规则**，会提示词表未注入）。
> 想连专有词一起扫，直接用 `node test/redact-scan.mjs --deny-file <仓外路径>`。

deny 文件三种写法都认（UTF-8；`#` 开头为注释、空行忽略）：

- `名字<TAB>正则<TAB>说明`（每行一条）
- 每行一个词（当成**字面词**，自动转义 + 词边界）
- 整份 JSON：`[{"name":"…","pattern":"…","why":"…"}]`（或二维数组 / `{"patterns":[…]}`）

现成的形状见 [`test/deny-terms.example.txt`](test/deny-terms.example.txt)（**只含占位词**）。

行为约定（这几条就是它存在的意义）：

- **不带** `--deny-file` ⇒ 照常跑通用规则、rc 仍可 `0`，但输出里一定打一行
  `⚠️ 具体部署词表未注入（--deny-file），本模式下只做通用规则` —— **不许静默通过**
  （`--json` 模式下这行走 stderr，同时在 JSON 里给 `"denyFileInjected": false` + `"warning"`）；
- **带** `--deny-file` 但文件不存在 / 只有注释（空词表）/ JSON 解析失败 / 正则编译不过 /
  **词表落在被扫目录里** ⇒ `rc=2` 并报错（防"以为扫了其实没扫"）；
- 退出码：`0` = 非白名单零命中 · `1` = 有命中 · `2` = 参数或词表错误。

白名单（每条都写理由，见文件里 `WHITELIST`）**不再整文件放行扫描器自身** ——
规则表里已经没有私有标识字面量了，唯一的重合是"隧道服务商"这类通用品牌词，
所以只对那一条排除自身。`test/07-redact-scan.test.mjs` 把上面这些行为逐条钉住。

---

## 5. 隧道这块要分两种主机（本仓的设计重心）

### 5.1 为什么这件事值得单开一节

多机协同最容易写错的地方不是"怎么连"，而是**假设对方能装什么**。
真实拓扑通常是**混合**的：一台是企业机（有 EDR、没有本机管理员、装 TUN 客户端会被拦），
另一台是自家机（什么都能装）。一条通道能不能通，由**两端里更保守的那端**决定。

⇒ 所以档位是 **每台机器各自声明**的，不是"整套部署一个值"。

### 5.2 三档

| 档 | 判据（以**人工声明**为主） | 允许的传输 | 禁止 |
|---|---|---|---|
| **`restricted`**（受限主机） | 公司机 / 有 EDR / 没有本机管理员 / 装 TUN 会被拦 | **用户态端口转发**：系统自带 `ssh -L`（本仓唯一的实现） | 🔴 装 TUN 驱动（Tailscale / ZeroTier / WireGuard）· 装第三方网络客户端 · 注册常驻服务 · 起守护进程 |
| **`free`**（自由主机） | 自家机 / 无 EDR / 有管理员 | 同上，**另外可选**对端跑常驻 sshd 或用 overlay 网络替代端口转发 | —（仍守"只许环回、不裸奔 0.0.0.0"） |
| **`auto`** | 不是一档设置，是**一次探测** | 只输出**建议**（`pinned:false`） | 🔴 **绝不自动落盘** |

### 5.3 怎么定档：声明为主，探测只做建议

```
node dsh-peer-tunnel.mjs profile --auto     # 探测本机 → 打印建议（不写盘）
node dsh-peer-tunnel.mjs profile --pin restricted --apply   # 人确认 → 落盘
```

`--auto` 探三件（**只读存在性，绝不安装任何东西**）：

| 信号 | 怎么探 | 说明 |
|---|---|---|
| 有没有本机管理员 | Windows：`whoami /groups` 里出现高完整性 SID；类 Unix：uid==0 | 探不到记 **null**（"不知道"），**不当 false 用** |
| TUN 驱动在不在 | Windows：`wintun.sys` / `tap0901.sys`；Linux：`/dev/net/tun` | 只看文件在不在 |
| ssh 客户端在不在 | `where ssh` / `command -v ssh` | 没有 ssh 就什么通道都别谈 |

规则：**三条同时满足才建议 `free`**，否则建议 `restricted`。
探测不到关键信号 ⇒ **从严建议受限档**（猜错方向永远是"以为对方能装 TUN"，代价是方案不可执行）。

🔴 **`auto` 不是一档设置。** 传 `--pin auto` 会被拒（`rc=2`）——它是探测，不是档位。

### 5.4 通道协商：取两端最保守档

```
本机 restricted  +  对端 free      ⇒ 有效档 restricted（不许 overlay）
本机 free        +  对端 free      ⇒ 有效档 free（允许 overlay，仍默认 lan/tunnel）
任一端还是 auto（= 未落盘）        ⇒ 按 restricted 计，并标 unconfirmed
```

**含义**：只要 `restricted` 能用的通道，就是**全场景可用的下界**。
所以本仓**只实现那一条**：用户态 `ssh -L`。

### 5.5 两端都自由时，你可以换成 overlay（本仓不实现，也不用改）

如果**两端**都是 `free`，并且你更喜欢 overlay 网络（免端口、能跨 NAT、连接更稳），
可以自己上 Tailscale / WireGuard 之类的方案。**本仓四件工具都不用改**，因为它们对外只认一件事：

> **"对端的服务，在我本机的一个环回端口上能访问到。"**

overlay 网络满足这个条件 —— 只要把客户端的监听地址限制在 `127.0.0.1`，把 `src` 地址指向
overlay 给对面那个地址即可。此时 `peer.tunnel.localPort` 改成 overlay 客户端提供的本地端口，
`dsh-peer-tunnel up/down` 就退化成"什么都不用做"（甚至可以让 `dsh-peer-arbiter` 永远判 lan）。

**判定表（该走哪条）**：

| 你的情况 | 建议 | 为什么 |
|---|---|---|
| 至少一端是受限主机 | **就用本仓的 `ssh -L`** | overlay 在那一端装不上；`ssh -L` 是唯一可用下界 |
| 两端都自由 + 只在同一内网 | **直连（lan）** | 最快，且不占 ssh 进程；`dsh-peer-arbiter` 会自动选它 |
| 两端都自由 + 经常换网络 / 跨 NAT | **可以换 overlay** | 端口转发要隧道常驻；overlay 的连接管理更省心 |
| 两端都自由 + 只是偶尔用一下 | **`ssh -L` + 按需起停** | 用完就 `down`，不留常驻进程；比装 overlay 干净 |
| 你不能接受"多一个常驻客户端" | **`ssh -L`** | 本仓不装任何常驻件 |

**换成 overlay 时的边界（不变的四条）**：
① 对外仍是"本机环回端口"；② 不许 `0.0.0.0` 裸奔；③ 不把 overlay 的密钥写进本仓配置；
④ 换回 `ssh -L` 只需改 `peer.tunnel.localPort`，其余三件不动。

### 5.6 一段诚实的边界说明

- 本仓**没有**"自动检测有没有 EDR"的能力，也不打算做（探不到，且做了也会误判）⇒ 所以是**人工声明**。
- `auto` 的探测里，"有没有管理员"在 Windows 上判的是**当前进程**的提权状态，不是"这个账户在不在管理员组"。
- 受限档下本仓**不会尝试**任何"自动装 TUN"的事 —— 那是本仓明确拒绝做的事。

---

## 6. 与 DSH 的集成点（以及为什么它不装服务）

| 集成点 | 说明 |
|---|---|
| 数据根 | 缺省 `~/.dsh-peer`，**不动** `~/.dsh`。想放一起就设 `DSH_PEER_HOME=~/.dsh` |
| 远端执行 | `ssh <对端> -- node <remoteRepoPath>/dsh-peer-sync.mjs <子命令>`（只允许固定入口 + 固定子命令） |
| known_hosts | 缺省 `~/.dsh-peer/state/known_hosts`，**不写用户的 `~/.ssh/known_hosts`** |
| 状态 / 日志 | `~/.dsh-peer/state/`（隧道 pid、ssh 日志、agent 日志、选路状态） |

**为什么不装服务**：本仓四件都是**一次性进程**。周期性的判断（"该不该开隧道"）交给
你系统自己的调度器；本仓只提供"一次判决 + 一次动作"。这样：
① 卸载 = 删目录，没有残留服务；② 出问题只影响一次运行，不会因为守护进程崩了而静默失效；
③ 受限主机上也能用（注册服务在很多公司机上直接被拦）。

---

## 7. 未包含的件（以及为什么）

| 未包含 | 它现在在哪 | 为什么不搬进来 |
|---|---|---|
| `peer-channel`（对等通道） | `dsh-board-toolkit/lib/peer-channel.mjs` | 它与**看板**有真实耦合（跨机取数直接喂看板面板）。搬走会同时打断两边 ⇒ **只留指针**。 |
| `dsh-session-mirror`（会话镜像） | `dsh-board-toolkit/` | 同上：它以会话列表为输入，跟看板是一件事的两面。 |
| `postcard`（明信片） | 未开源 | 它是**情感功能**，绑在一套"对面那个人格"的约定上；脱离那套约定单独发没有意义。 |
| `life-shared-push` / `life-say-collector` | 未开源 | 生活线的一部分，强绑私有部署的人格面。 |
| `hands-tunnel` | 未开源 | 属 relay 的内部实现细节，不是独立工具。 |
| WOL 唤醒件（局域网唤醒） | 已被 `dsh-net-toolkit` 的 `dsh-wol.mjs` 覆盖 | 重复件：同一个能力不该有两个入口。去 `dsh-net-toolkit` 用。 || `merge-memory` / `attrib-ledger` | 未开源 | 属记忆那条线，不属于多机协同。 |

> 判断口径：**按变更节奏拆包** —— 总是一起改的东西放一个包，各改各的该分开。
> `peer-channel` 与看板一起改，所以留在看板仓；信箱 / 选路 / 同步 / 隧道与看板毫无关系，所以在这里。

---

## 8. 许可

本仓代码以 **AGPL-3.0 + 商业授权**（双许可）发布，详见 [LICENSE](LICENSE)。
简言之：**要么按 AGPL-3.0 使用/修改并让衍生作品同样开源，要么取得商业授权**。
（AGPL 本身不禁止商用；「+ 商业授权」是双许可，不是禁商用条款。）

---

## 9. 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。首个公开版本 `v0.1.0`；当前 `v0.1.1`（脱敏修订：规则表去字面量化）。

---

## 10. 相关仓

本仓是**开源支线**同批发布的一员，另外几个仓与它同属一条线：

- **主文档仓** [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)：这套体系的方法论与设计稿（唯一权威叙述）。本仓的定位与登记见其中的 [`发布说明.md`](https://github.com/kira905/ops-handoff-design/blob/main/发布说明.md) **§4.5 组件索引表**（本仓是表里的一行）。镜像：[Gitee](https://gitee.com/kira905/ops-handoff-design)。
- **姊妹仓** [`dsh-life-toolkit`](https://github.com/kira905/dsh-life-toolkit)：人生记忆（`life.db` schema + 会话原文索引器 + 召回插件 + 假语料 fixture）。同一批首发、同样零第三方运行时依赖；它管"日子"，本仓管"机器与机器之间"。镜像：[Gitee](https://gitee.com/kira905/dsh-life-toolkit)。
- 本仓已在使用、但**不在这里**的周边件（`dsh-net-toolkit` 的 Wake-on-LAN、`dsh-board-toolkit` 里的 `peer-channel`）见上面 §7 的对照表，不重复列。

> 三个仓各自**独立打 tag、独立发版**；跨仓引用一律给链接，不复制对方的正文。
