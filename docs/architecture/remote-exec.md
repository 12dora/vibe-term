# 远程执行与主机快照

本文描述 `POST /api/exec` 的契约与安全边界，以及同属会话面的 `GET /api/system/facts`。面向改动 `apps/gateway/src/exec/`、`apps/gateway/src/api/exec-routes.ts`、`apps/gateway/src/api/system-facts.ts` 的开发者。客户端命令行见 [CLI 使用手册](../operations/cli-usage.md)。

## 1. 目标

在设备上跑一条非交互命令，拿到分路的 stdout/stderr 与真实退出码，不往共享 tmux pane 打键。`term run` 仍是往已有窗格注入按键；需要 argv / cwd / env / stdin / 超时杀进程时走本接口。

路径可经 mesh 转发：`POST /n/<nodeId>/api/exec`、`GET /n/<nodeId>/api/system/facts`。鉴权与其它 `/api/*` 相同（会话守卫，**没有**短时 scoped bearer；CLI 现用完整 node-session，可用 `$VIBETERM_SESSION_FILE` 把会话文件指到独立路径，见 [KI-16](../known-issues.md)）。

## 2. `POST /api/exec`

请求 JSON：

```json
{
  "deviceId": "…",
  "argv": ["make", "test"],
  "cwd": "/optional",
  "env": { "FOO": "bar" },
  "stdin": { "text": "…" },
  "timeoutMs": 600000,
  "shell": false,
  "maxBytes": 8388608
}
```

| 字段 | 规则 |
| --- | --- |
| `deviceId` | 必填 |
| `argv` | 非空字符串数组。`shell: true` 时必须恰好 1 个元素 |
| `cwd` | 可选，非空字符串 |
| `env` | 可选。键须为 `[A-Za-z_][A-Za-z0-9_]*`，值须为字符串。覆盖在**本节点服务用户环境**之上；网关不隐式注入 `DEBIAN_FRONTEND` 等 |
| `stdin` | `{ "text" }` 或 `{ "base64" }`，二选一。整个请求体受 `/api/*` JSON 体上限 1 MiB 约束，stdin 实际可用约 0.75 MiB；更大的输入请先 `cp` 到设备再以文件形式读取 |
| `timeoutMs` | 子进程墙上时钟。默认 600000，上限 3600000。**不是** HTTP 空闲超时 |
| `shell` | `true` 时把 `argv[0]` 交给 **`/bin/sh -c`**。不用 `bash -lc`，不跑 login shell |
| `maxBytes` | 可选。每路 stdout/stderr 的发送上限，范围 1024（1 KiB）.. 8388608（8 MiB）。缺省 8 MiB。超出后停止发送该路并在 `exit.truncated` 对应位置标 `true`，子进程继续跑 |

校验失败（缺字段、非法 body、设备不存在、密码认证 SSH）在开流前返回 **HTTP 400** JSON `{ "code", "message" }`。一旦开流，HTTP 状态为 200，`Content-Type: application/x-ndjson`。

### 事件

每行一个 JSON 对象，顺序为 `start` → 若干 `stdout`/`stderr`/`ping` → `exit`，超时再跟一条 `error`。`error` 也用于开流后的失败（尚未 `start` 也可以单独出现）。子进程存活期间每 10 秒一条 `{"type":"ping","t":<unix-ms>}`，用来重置入口 Bun.serve 与 CLI `fetch` 的空闲时钟；CLI 组装 JSON 时忽略，`--json --stream` 也不转发它。

```json
{"type":"start","pid":123,"device":{"id":"…","type":"local"}}
{"type":"ping","t":1710000000000}
{"type":"stdout","base64":"…"}
{"type":"stderr","base64":"…"}
{"type":"exit","code":0,"signal":null,"durationMs":12,"truncated":{"stdout":false,"stderr":false},"reason":"exit"}
{"type":"error","code":"exec_timeout","message":"exec timed out"}
```

- 每个流的分块 ≤ 64 KiB（编码前原始字节），同流保序。
- 单流累计 `maxBytes`（缺省 8 MiB）后丢弃后续字节，并在 `exit.truncated` 对应位置标 `true`；进程继续跑到退出。这不是终端 `error`（`exec_output_limit` 保留给将来的硬中止，当前 cap 不发该事件）。
- `stdout` / `stderr` 分 fd，互不混流。
- `exit.reason`：`exit`（正常结束）或 `exec_timeout`（墙上时钟到了）。超时仍追加 `error` 事件，`code` 仍为 `exec_timeout`（其它错误码不变）。

错误码：`invalid_body`、`device_not_found`、`exec_unsupported_device`、`exec_spawn_failed`、`exec_timeout`、`exec_output_limit`。

### 空闲与超时（谁杀什么）

| 计时器 | 默认 | 作用对象 | 静默 exec 怎么办 |
| --- | --- | --- | --- |
| Bun.serve `idleTimeout` | 255 s（未设置时 Bun 默认 10 s） | CLI → **本机入口** HTTP 连接 | `/api/exec` 对该请求 `server.timeout(req, 0)` 关掉上限；mesh 转发则靠 `ping` 字节重置入口空闲时钟 |
| CLI `fetch` 空闲（`timeout` / `BUN_CONFIG_HTTP_IDLE_TIMEOUT`） | 5 min | CLI → 入口的 NDJSON body | `ndjson` 传 `timeout: false`；`ping` 也会重置 |
| 子进程 `timeoutMs` | 600000 ms，上限 3600000 | 远端子进程墙上时钟 | `--timeout` 只写这个。到点 `SIGTERM`，5 s 后 `SIGKILL`，`exit.reason=exec_timeout` |
| 客户端断开 | — | 远端子进程 | Request abort 或 NDJSON `cancel` → `SIGTERM`（再 5 s `SIGKILL`） |

`timeoutMs` **不是** HTTP 空闲超时。完全静默的命令只要子进程还活着，就会持续发 `ping`。

### 设备实现

| `device.type` | 行为 |
| --- | --- |
| `local` | `Bun.spawn(argv, { cwd, env, stdin, stdout: "pipe", stderr: "pipe" })`。`shell: true` 时 argv 为 `["/bin/sh", "-c", script]` |
| `ssh` | OpenSSH 子进程：`ssh -o BatchMode=yes -T <port/user/-i/configRef> -- <remote>`。远端命令为 shell 引用后的 `cd <cwd> && env K=V … exec <argv>`（有 `env` 时由 `env` 进程替换，不再套一层 builtin `exec`；`shell: true` 时为 `/bin/sh -c`）。stdin 经 ssh 管道转发 |

密码认证、以及必须走 SSH_ASKPASS 的口令/passphrase 私钥（`BatchMode` 无法工作）→ `exec_unsupported_device`。`configRef` / 无口令密钥 / ssh-agent 可用。

超时：先 `SIGTERM`，5 秒后再 `SIGKILL`。`exit.signal` 固定报 `"SIGTERM"`，并追加 `error exec_timeout`。客户端断开（`Request` abort 或 NDJSON 流 `cancel`）同样杀子进程。

## 3. 安全注意

- 只对已通过 `/api/*` 会话守卫的调用者开放。被转发到 peer 时沿用 mesh 入站策略，不在本路由再鉴一次。
- 不分配 PTY（`-T` / 本地 pipe），避免把共享窗格或交互提示当成命令通道。
- SSH 强制 `BatchMode=yes`，拒绝会提示密码的设备，避免网关进程卡在口令询问或把口令写进 askpass。
- 远端 argv / cwd / env 一律单引号引用（`quoteShellArg`），调用方仍应把 `shell: true` 当作显式的远程 shell 执行面。
- 输出有界（8 MiB/流）且有墙上时钟超时，防止 `yes` 或挂起进程拖死网关。
- `env` 覆盖的是服务用户环境，密钥类变量若已在服务进程里，子进程默认继承；调用方写入的键值会覆盖同名项。
- 不在本接口转储监听套接字或其它主机侦察面。
- 没有短时、作用域收窄的 exec 令牌；CLI 仍走完整 node-session（`$VIBETERM_SESSION_FILE` 只换路径，不缩小权限）。见 [KI-16](../known-issues.md)。

## 4. `GET /api/system/facts`

与 `GET /api/system/info` 一样走 `handleSystemApiRequest`，需会话。返回本节点主机快照，供 `vibeterm system info` 合并展示。不含 `ss`/`listenTcp` 全量套接字。

| 字段 | 来源 |
| --- | --- |
| `hostname` / `os` / `arch` / `kernel` / `uptimeSec` | `os.hostname()`、`process.platform`、`process.arch`、`os.release()`、`os.uptime()` |
| `cpu` | `os.cpus().length`、`os.loadavg()` |
| `mem` | `os.totalmem()` / `os.freemem()`；Linux 另读 `/proc/meminfo` 的 `MemAvailable` 填 `availableBytes` |
| `disk.root` / `disk.home` | `fs.statfsSync("/")` 与 `$HOME`；失败为 `null` |
| `tmux` | 复用 `getTmuxHealth()`（`healthy`、可选版本、`reason`） |
| `docker` | `Bun.which("docker")` 或存在 `/var/run/docker.sock` → `present`；`socket` 只表示该路径是否存在 |
| `install` | `getInstallInfo()` 的 `deployment` / `installDir` / `cliVersion` |
| `memoryProfile` | `getMemoryProfile()`：`"standard"` \| `"small"` |
| `ports` | 角色端口计划映射为 MeshNode 风格 `{ purpose, proto, port\|range, status:"unknown", code:"not_probed" }`。不探测、不扫监听口；构造失败则省略该字段 |

## 5. 与 `term run` 的边界

| | `POST /api/exec` | `term run` |
| --- | --- | --- |
| 通道 | HTTP NDJSON | Borsh WS `terminal-input` |
| 目标 | 新子进程 / `ssh … cmd` | 已有 pane 的 PTY |
| stdout/stderr | 分路 | 混在 pane 字节流里 |
| 退出码 | 子进程 `exit` | 可选哨兵，不可靠 |
| 适用 | agent / 脚本 / 非交互 | 对着用户正在看的窗格打一行 |
