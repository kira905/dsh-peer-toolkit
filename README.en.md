# dsh-peer-toolkit · multi-host helpers for DSH

> ### What this is
> **A multi-host peer toolkit**: encrypted mailbox, path arbitration, text sync, and an on-demand tunnel — so two machines' assistants can talk to each other.
>
> ### What it solves
> The hard part of multi-host is not "how to connect", it is that **every host is different**: some are corporate machines where you cannot install a TUN client or run a resident service. So this only uses **user-space `ssh -L` forwarding**, and each host declares a transport profile (`restricted` / `free`); when two hosts negotiate, **the more conservative side wins**. Tunnels are raised on demand and torn down after, leaving no resident process.
>
> ### Run it in one command
> ```powershell
> npm i -g @kira905/dsh-peer-toolkit
> dsh-mailbox keygen        # both ends must use the same key
> dsh-mailbox send --text "hello"
> ```
>
> ### Real output
> ```text
> Usage
>   node dsh-mailbox.mjs <keygen|status|send|wait|results|inbox> [options]
>
> Deliver messages / dispatch commands across hosts and collect receipts (envelope encryption;
> how the spool directory reaches the other side is your choice)
> ```
>
> ⚠️ A cross-host tool is only worth something on the **second machine** — with one machine, run the two-instance closed loop in the README.

---

> **This repository is a set of command-line tools. It does not hook into the host UI, needs no
> `dsh.bundle`, and needs no `cordis.patch.yml`.** Install it with
> `npm i -g @kira905/dsh-peer-toolkit` (or run `npx -p @kira905/dsh-peer-toolkit dsh-peer-tunnel`).
> Installing it into a profile works too, but the `declares no dsh.bundle` warning is **expected**, not a failure.

## ⚠️ Read this first (more important than any usage)

1. **The biggest trap with cross-host tooling: you only have one machine.** All the value lives on
   the *second* host. Installed on a single box it does nothing — that is the nature of the problem,
   not a bug. This repo therefore ships a **two-instance drill on one machine** (§4): two data roots,
   two ports, and a spool directory both sides can see. **"It installed" is not "it works".**
2. **Only one tunnel implementation exists: user-space `ssh -L` port forwarding.** No TUN driver,
   no third-party network client, no registered service, no daemon. Why, and when you may switch to
   an overlay network instead, is **§5** — that section is the design centre of this repo.
3. **The local port binds loopback only (`127.0.0.1`).** This is hard-coded, not a default: a config
   that says `0.0.0.0` is rejected (`rc=2`), and a tunnel that comes up bound to anything else closes
   itself immediately. This repo never exposes a channel to the LAN.
4. **The mailbox agent does not execute commands by default.** Without `--allow-exec`,
   `dsh-peer-agent` refuses `exec` envelopes and returns a `refused` receipt. Execution must be
   enabled by the machine's owner, in that owner's own scheduled command.
5. **Nothing is written to `~/.dsh` by default.** This repo keeps its state in `~/.dsh-peer`
   (override with `DSH_PEER_HOME` / `--config`). DSH's own directory is not ours to touch.
6. **`--help` never executes anything.** All five CLIs share one argument gate: `--help` → `rc=0`,
   usage only; an unknown flag → `rc=2` and **nothing after it runs**.

---

## Post-install self-check (three read-only steps)

```powershell
# 1) Is the command there? (existence check only, nothing executed)
Test-Path "$env:APPDATA\npm\dsh-peer-tunnel.CMD"

# 2) Usage prints, and nothing runs (rc must be 0)
node .\dsh-peer-tunnel.mjs --help

# 3) Read-only self-check
node .\dsh-peer-tunnel.mjs status
node .\dsh-peer-tunnel.mjs doctor   # runs one ssh auth probe: `exit 0` only, no business traffic
```

## Provenance

Parts of this repository are **derived from a private production implementation** (the same
engineering effort maintained at a second location). It is a **distilled export** — neither a
verbatim copy nor a from-scratch rewrite. Everything tied to that private deployment (drive letters,
a private relay repository, fixed peer host names, LAN addresses, a specific tunnel provider) was
replaced with parameters or example values. The two tools that fetch data across hosts stayed in
their original repository — see §7.

Two features tell them apart: every CLI here runs through `lib/cli-args.mjs` (the production versions
have no argument gate), and every default is an RFC 5737 documentation address (`192.0.2.x`) or a
placeholder host name.

## 1. Environment and install

```powershell
node --version                      # Node 18+; no npm install needed (zero third-party deps)
node .\dsh-peer-tunnel.mjs profile  # run from the repo root
npm i -g @kira905/dsh-peer-toolkit  # or install the bin names
dsh-peer-tunnel profile
```

You need an **ssh client** on the machine (`System32\OpenSSH\ssh.exe` ships with Windows 10+;
Linux/macOS have one). This repo does not implement SSH; it drives the system's own client.

| Variable | Used by | Meaning | Default |
|---|---|---|---|
| `DSH_PEER_HOME` | all | data root (config / state / known_hosts) | `~/.dsh-peer` |
| `DSH_PEER_CONFIG` | all | explicit config file path | `$DSH_PEER_HOME/peer-config.json` |

## 2. Layout

```
dsh-peer-toolkit/
├── dsh-mailbox.mjs      # tool 1, control side: send a message / command, wait for a receipt
├── dsh-peer-agent.mjs   # tool 1, executing side: take envelopes, (optionally) run, write receipts
├── dsh-peer-arbiter.mjs # tool 2, route arbitration: LAN or tunnel
├── dsh-peer-sync.mjs    # tool 3, text sync: compare first, transfer only the delta, never delete
├── dsh-peer-tunnel.mjs  # tool 4, tunnel lifecycle + transport profile (restricted/free/auto)
├── lib/                 # cli-args, config, net, ssh, runner, profile, decide, envelope,
│                        # sync-rules, packfile, files
├── test/                # 8 fixtures; 99-dual-instance.test.mjs is the end-to-end drill;
│                        # redact-scan.mjs is the pre-release redaction scan (generic rules
│                        # in the repo, deployment-specific terms injected via --deny-file);
│                        # deny-terms.example.txt shows the deny-file shape (placeholders only)
├── README.md · README.en.md · CHANGELOG.md · LICENSE · package.json
```

## 3. The four tools

### 3.1 Mailbox — `dsh-mailbox` + `dsh-peer-agent`

Both hosts do **not** need to be online at the same time. The control side drops an encrypted
envelope into a spool directory; the peer's agent picks it up, acts, and optionally writes a receipt.

Envelopes are **AES-256-GCM**. The transport medium is usually the part you do not control
(a shared drive, a repository someone else can read): encryption means no plaintext in the medium,
and GCM authentication means a tampered byte cannot be decrypted — so nobody without the key can
forge an executable instruction.

| Command | What it does |
|---|---|
| `dsh-mailbox keygen` | create the 32-byte symmetric key (**both sides need the same one**) |
| `dsh-mailbox send --text "…"` | send a **plain message** (the peer executes nothing) |
| `dsh-mailbox send --cmd "…" [--wait]` | send a **command** (the peer needs `--allow-exec`) |
| `dsh-mailbox wait <id>` | wait for one receipt |
| `dsh-mailbox results [--take]` | list receipts (`--take` moves them into `done/`) |
| `dsh-peer-agent --once` | one round: take → handle → receipt (**no execution by default**) |
| `dsh-peer-agent --once --allow-exec` | same, but `exec` envelopes are allowed to run |

How the spool reaches the peer is up to you: a shared/synced drive, an orphan branch of a private
git repository, or this repo's own `dsh-peer-sync` over a tunnel.

Exit codes: `0` ok · `1` receipt `ok=false` / execution failed · `2` bad argument or config · `4` receipt timed out.

### 3.2 Route arbitration — `dsh-peer-arbiter`

It answers one question: is the direct LAN path (`peer.lanHost:lanPort`) reachable? If yes, use it;
if not, bring up the tunnel. The decision itself is a **pure function** (`lib/decide.mjs`, zero I/O);
this CLI is a thin "observe → decide → act" shell.

| Command | What it does |
|---|---|
| `dsh-peer-arbiter decide` | **dry run (default)**: show observation and decision, touch nothing |
| `dsh-peer-arbiter decide --apply` | really start / stop the tunnel |
| `dsh-peer-arbiter status` | read-only: profiles, observation, last decision |

Three rules, each pinned by a fixture: **hysteresis** (two consecutive "not needed" rounds before
tearing a tunnel down), **idempotence** (if the tunnel is already listening, do nothing — a second
`ssh -L` would fight for the same local port), and **never act on an unknown probe** (neither up nor down).

This repo registers **no scheduled task and starts no daemon**. Run it from your own scheduler and
add `--apply` there.

### 3.3 Text sync — `dsh-peer-sync`

Pushing everything would mean **overwriting the peer with this side's copy**, while the peer is also
producing documents. So it compares first, transfers only the delta, and **never deletes**.

Three stages: **A** build a local manifest → **B** compare on the peer (read-only) → **C** transfer in
batches and place them.

| Situation | Outcome |
|---|---|
| peer does not have it | **new** (send) |
| same name, local newer, content differs | **update** (send; write `<name>.bak-<stamp>` before overwriting) |
| same name, peer newer, content differs | **skip** (never overwrite the newer side) |
| content differs, mtime cannot decide | **conflict**: original untouched, drop `<name>.conflict-<tag>-<stamp>` |
| matches a dual-write blacklist entry | **never overwrite** (config `sync.dualWrite`), conflict copy only |
| identical content | **skip** |

🔴 No target file is ever deleted; there is no `--delete` / `--purge`. Backups accumulate and are
**not** cleaned up automatically.

Exit codes: `0` done (including "no changes") · `2` bad argument/config · `3` **yield** (peer
unreachable — a normal physical condition, not a failure) · `1` real failure.

### 3.4 Tunnel — `dsh-peer-tunnel`

`profile` · `profile --auto` (suggestion only) · `profile --pin <restricted|free> --apply`
(the only command that writes config) · `up` · `down` · `status` · `doctor`.

Exit codes: `0` ok · `2` bad config · `5` started but not listening · `6` stopped but port still held
· `7` doctor found a failing item · `10` tunnel not up.

## 4. Running it (two instances on one machine)

This is exactly what `test/99-dual-instance.test.mjs` does: two data roots, two ports, one spool
directory both sides can see, and the real system `ssh` client (`ssh -L`) connecting to the local
sshd on `127.0.0.1`.

```powershell
$A = "$env:TEMP\peer-a"; $B = "$env:TEMP\peer-b"
New-Item -ItemType Directory $A, $B -Force | Out-Null

# configs: bind MUST be 127.0.0.1; sshHost 127.0.0.1 means "the peer is this machine"
#   A: tunnel.localPort 19080, peer.lanPort / tunnel.remotePort 19081
#   B: mailbox.spoolDir = the shared spool, mailbox.keyPath = the same key file

$env:DSH_PEER_HOME = $A; node .\dsh-mailbox.mjs keygen
node .\dsh-mailbox.mjs send --text "ping" --wait    # waits; run the next line in another shell
$env:DSH_PEER_HOME = $B; node .\dsh-peer-agent.mjs --once

$env:DSH_PEER_HOME = $A; node .\dsh-peer-arbiter.mjs decide
node .\dsh-peer-tunnel.mjs up
node .\dsh-peer-tunnel.mjs down
node .\dsh-peer-tunnel.mjs status                    # rc=10 means "not up"
```

Proof criteria (identical to the fixture asserts): `netstat` shows **only** `127.0.0.1:<port>`
LISTENING while the tunnel is up and **zero** LISTENING lines after `down`; the recorded pid is gone;
and no service or scheduled task is created (the source contains no `schtasks` / `New-Service` /
`Register-ScheduledTask` calls at all).

`node test/run.mjs` runs everything (~20–25 s, starts one real ssh tunnel);
`node test/run.mjs --fast` skips the e2e (~4 s). The e2e needs a running local sshd and a key that
logs into it without a password (`PEER_E2E_KEY` / `PEER_E2E_SSHUSER` override the defaults). A missing
prerequisite makes it **fail loudly** rather than skip silently.

### 4.1 Pre-release redaction scan: generic rules in the repo, deployment-specific terms from outside

`test/redact-scan.mjs` is the repo's own pre-release gate (zero dependencies, read-only). It has
**two layers** of rules:

| Layer | Where it lives | What it covers |
|---|---|---|
| **Generic rules** | in the repo (that file) | the three private ranges (`192.168/16`, `10/8`, `172.16/12`), user directories, drive-letter absolute paths, the shape of key file names, tunnel-provider wording, and the **current runner's** user name (read from the environment, never spelled out) |
| **Deployment-specific terms** | **not in the repo** — an external deny file | private peer host names, this machine's host name, short host aliases, relay server addresses, private relay-repo paths, relay-side account/key names, production-tree paths … anything that is true only of *one* deployment |

**Why the split:** the rule table itself gets published. A table that spells out a host name
publishes that host name — "the rule is not the data" only holds when the rule really is generic.
So the repo keeps the generic shapes and the specific words arrive from **outside** through
`--deny-file` (the same trade-off as comparable scanners: *the rule table can be published without
publishing anything private*).

```bash
node test/redact-scan.mjs                            # generic rules only (says "deny list not injected")
node test/redact-scan.mjs <dir>                      # scan another directory
node test/redact-scan.mjs --deny-file <outside path> # add this deployment's deny list (must be outside the scanned dir)
node test/redact-scan.mjs --deny-file <path> --json  # machine readable (stdout is JSON only)
```

> There is also an npm script: `npm run test:redact` = the first line above (**generic rules only**;
> it tells you the deny list was not injected). To include this deployment's terms, call
> `node test/redact-scan.mjs --deny-file <outside path>` directly.

The deny file accepts three shapes (UTF-8; `#` comments and blank lines ignored):

- `name<TAB>regex<TAB>why`, one per line
- one word per line (treated as a **literal**, escaped, with word boundaries)
- a JSON array: `[{"name":"…","pattern":"…","why":"…"}]` (or a 2-D array / `{"patterns":[…]}`)

See [`test/deny-terms.example.txt`](test/deny-terms.example.txt) for the shape (**placeholders only**).

Guaranteed behaviour (this is the point of the tool):

- **without** `--deny-file` it still runs the generic rules and may still exit `0`, but it always
  prints `⚠️ 具体部署词表未注入（--deny-file），本模式下只做通用规则` — **it never passes silently**
  (with `--json` that line goes to stderr, and the JSON carries `"denyFileInjected": false` plus `"warning"`);
- **with** `--deny-file` but a missing file / a comments-only file (empty list) / unparsable JSON /
  a regex that does not compile / a deny file **inside** the scanned directory ⇒ `rc=2` and an error
  (so you can never "think you scanned when you did not");
- exit codes: `0` = no non-whitelisted hit · `1` = hits · `2` = bad argument or deny file.

The whitelist (every entry carries a reason, see `WHITELIST`) **no longer excludes the scanner as a
whole** — the rule table holds no private literal any more; the only overlap left is generic brand
wording, so just that one pattern excludes the file itself.
`test/07-redact-scan.test.mjs` pins all of the above.

## 5. Two classes of host (the design centre of this repo)

The hard part of cross-host tooling is not "how to connect" — it is **assuming what the other side is
allowed to install**. Real topologies are mixed: one corporate machine (EDR, no local admin, TUN
clients blocked) and one personal machine (anything goes). Whether a channel works is decided by
**the more conservative end**.

| Profile | Criteria (mostly a human declaration) | Allowed transports | Forbidden |
|---|---|---|---|
| **`restricted`** | corporate machine / EDR present / no local admin / TUN blocked | **user-space port forwarding**: the system `ssh -L` (the only implementation here) | 🔴 TUN drivers (Tailscale / ZeroTier / WireGuard) · third-party network clients · registered services · daemons |
| **`free`** | own machine / no EDR / admin available | the same, **plus optionally** a resident sshd on the peer or an overlay network instead of port forwarding | — (still loopback-only, never `0.0.0.0`) |
| **`auto`** | not a setting but a **probe** | prints a **suggestion** (`pinned:false`) | 🔴 never writes itself to disk |

`--auto` probes three things, read-only: local admin (Windows: high-integrity SID in `whoami /groups`;
Unix: uid 0 — unreadable means `null`, which is *not* `false`), TUN driver presence
(`wintun.sys` / `tap0901.sys` / `/dev/net/tun`), and the ssh client. **All three** must hold before it
suggests `free`; otherwise it suggests `restricted` — the expensive way to be wrong is always
"assumed the peer could install a TUN client".

**Negotiation takes the more conservative end**: restricted + free ⇒ restricted;
free + free ⇒ free (overlay allowed, `lan`/`tunnel` still default); either end still `auto`
⇒ treated as restricted and flagged `unconfirmed`. Therefore the channel set usable under
`restricted` is the floor for every scenario — and that is exactly the one thing this repo implements.

**If both ends are free**, you may switch to an overlay (Tailscale, WireGuard, …). **None of the four
tools change**, because all they require is: *"the peer's service is reachable on a loopback port of my
machine."* Point `peer.tunnel.localPort` at the overlay client's local listener and `dsh-peer-tunnel
up/down` becomes a no-op. Boundaries that never change: loopback-only exposure, no plaintext
`0.0.0.0`, no overlay keys in this repo's config, and switching back is a one-line config change.

Honest limits: this repo **cannot** detect EDR and will not try (undetectable, and a heuristic would
misjudge); `auto`'s admin check is about the *current process*'s elevation, not group membership; and
under `restricted` the code will never attempt to install a TUN driver.

## 6. Integration points, and why nothing is installed as a service

Data root defaults to `~/.dsh-peer` (never `~/.dsh`). Remote execution is limited to
`ssh <peer> -- node <remoteRepoPath>/dsh-peer-sync.mjs <subcommand>` — a fixed entry point with fixed
subcommands, never an arbitrary command string. `known_hosts` lives in `~/.dsh-peer/state/`, not in
`~/.ssh/`.

Every tool here is a **one-shot process**; periodic decisions belong to your own scheduler. That means
uninstalling is "delete the directory", a crash affects one run instead of failing silently forever,
and it works on restricted hosts where registering a service is blocked outright.

## 7. Not included (and why)

| Not included | Where it lives | Why not here |
|---|---|---|
| `peer-channel` | `dsh-board-toolkit/lib/` | genuinely coupled to the task board (cross-host fetch feeds the board UI) — pointer only |
| `dsh-session-mirror` | `dsh-board-toolkit/` | same reason: it takes the session list as input |
| `postcard` | not open-sourced | an emotional feature bound to one deployment's persona conventions |
| `life-shared-push` / `life-say-collector` | not open-sourced | part of a private personal-life channel |
| `hands-tunnel` | not open-sourced | an internal implementation detail of the relay, not a standalone tool |
| Wake-on-LAN sender | superseded by `dsh-wol.mjs` in `dsh-net-toolkit` | duplicate: one capability, one entry point |
| `merge-memory` / `attrib-ledger` | not open-sourced | memory-line tools, not multi-host coordination |

Rule of thumb: **package by change cadence** — things that change together go together. `peer-channel`
changes with the board, so it stays there; mailbox / arbiter / sync / tunnel have nothing to do with
the board, so they live here.

## 8. License

**AGPL-3.0 + commercial licensing** (dual license), see [LICENSE](LICENSE). In short: either use and
modify it under AGPL-3.0 and keep derived works open, or obtain a commercial license. (AGPL does not
forbid commercial use; "+ commercial licensing" is a dual license, not a non-commercial clause.)

## 9. Changelog

See [CHANGELOG.md](CHANGELOG.md). First public version: `v0.1.0`; current: `v0.1.1` (redaction fix — the rule table carries no private literal any more).

---

## 10. Related repositories

This repo is one member of an **open-source release batch**. The others on the same line:

- **Main documentation repo** [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design) — the methodology and design record behind this system (the single authoritative narrative). This repo's position is registered in [`发布说明.md`](https://github.com/kira905/ops-handoff-design/blob/main/发布说明.md) **§4.5 component index** (one row of that table). Mirror: [Gitee](https://gitee.com/kira905/ops-handoff-design).
- **Sibling repo** [`dsh-life-toolkit`](https://github.com/kira905/dsh-life-toolkit) — life memory (`life.db` schema, session-text indexer, recall plugin, fixture corpora). Released in the same batch, also with zero third-party runtime dependencies; it covers "days", this one covers "machine to machine". Mirror: [Gitee](https://gitee.com/kira905/dsh-life-toolkit).
- Neighbouring pieces this repo uses but does **not** ship (`dsh-net-toolkit`'s Wake-on-LAN, `peer-channel` in `dsh-board-toolkit`) are listed in §7 above and not repeated here.

> Each of the three repos tags and releases **independently**; cross-repo references give links rather than copying the other side's prose.
