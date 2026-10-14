# 远程执行与主机快照

本文描述在设备上执行命令的两条路径：主路径 exec 通道（EC1，`GET /api/exec/ws`）与兼容路径 `POST /api/exec`，以及同属会话面的 `GET /api/system/facts`。面向改动 `packages/shared/src/exec-channel/`、`apps/gateway/src/exec/`、`apps/gateway/src/mesh/exec-*.ts`、`packages/cli/src/core/exec-channel*.ts` 的开发者。客户端命令见 [CLI 使用手册](../operations/cli-usage.md)，令牌模型见 [访问令牌](../security/access-tokens.md)。

## 1. 目标与路径

在设备上跑一条命令，行为对齐 `ssh host cmd`：stdin / stdout / stderr 原样透传（二进制安全、无大小上限、带背压），退出码透传，链路中断后按偏移续传，可选 PTY，命令由目标用户的登录 shell 执行。不往共享 tmux pane 打键；`term run` 仍是往已有窗格注入按键。

| 路径 | 入口 | 角色 |
| --- | --- | --- |
| exec 通道（EC1） | `GET /api/exec/ws`、`GET /n/<nodeId>/api/exec/ws`（WebSocket） | 主路径：`vibeterm exec` 与 `rsh` 使用；rsync、git、scp 经 `rsh` 复用它 |
| 兼容路径 | `POST /api/exec`、`POST /n/<nodeId>/api/exec`（NDJSON） | 仅为旧节点保留，见 §4 |

## 2. exec 通道（EC1）

### 2.1 传输

EC1 是传输无关的有序可靠字节管道，只依赖「二进制消息有序送达」。同一份编解码（`packages/shared/src/exec-channel/`，CLI 与网关共用）挂在两种传输上：

| 传输 | 路径 | 说明 |
| --- | --- | --- |
| 本机 WebSocket | `GET /api/exec/ws`，同义路径 `/n/self/api/exec/ws`、`/n/<selfNodeId>/api/exec/ws` | 升级时鉴权（§2.9），之后每条二进制消息承载若干帧或半帧，接收端用流式解码器 |
| mesh 流 | 入口 `GET /n/<nodeId>/api/exec/ws` → 目标节点的 mux 流类型 `exec` | 入口只做字节泵，不解析帧；会话终止于目标节点 |

mesh 转发的细节：

- 入口 `Forwarder` 在 `rest === '/api/exec/ws'` 时取目标节点的凭证：会话 cookie `vibeterm_s_<nodeId>`，没有会话才取令牌 cookie `vibeterm_t_<nodeId>` 并写成 `tok:<secret>`；都没有则 HTTP 401 `NODE_LOGIN_REQUIRED`。随后 `link.openStream` 发出 OPEN 载荷 `{"type":"exec","credential":"…","clientIp":"…"}`，`clientIp` 是入口看到的真实客户端地址（可缺省），仅用于令牌使用记录。
- **OPEN 载荷不带 `auth` 键。** 旧节点的 `classifyOpenPayload` 把「有字符串 `auth`、无 `method` / `to`」的载荷归为 Borsh `ws` 流；带了 `auth` 会被旧节点当成 WS 会话处理。不带时旧节点无法识别类型，以 `unknown-stream-type` 复位流，入口据此关 WS 并给出 4404（§2.8）。
- 上行（WS → 流）经有界队列顺序 `write`，流窗口即背压；流打开前至多缓存 1 MiB，之后上限 16 MiB，超出关 WS 1009。下行（流 → WS）在 WS 发送缓冲超过 1 MiB 时停止拉取，`drain` 后继续。客户端关 WS 时先写完已排队字节再半关闭流，目标侧才收得到末尾的 CLOSE / ACK。
- 目标节点 `classifyOpenPayload` 返回 `exec` 时，校验凭证（§2.9）后 `attachExecChannel`；失败 `stream.reset('auth:<reason>')`。纯 relay 角色不装配网关面，只放行 `/healthz`，不服务 `exec`；没有会话库的实例对 `exec` 流直接 `reset('exec-not-configured')`。
- 链路丢失或流被复位，入口按下表关 WS；EC1 会话在目标节点上继续存活，客户端重连后经新流 resume。

| 流结束方式 | 入口给 WS 的关闭码 |
| --- | --- |
| 目标 `END` | 1000 `exec_end` |
| `unknown-stream-type` | 4404 `exec_unsupported` |
| `auth:*` 或 `exec:4401` | 4401 `NODE_LOGIN_REQUIRED` |
| `exec:4400` / `4403` / `4408` / `4409` | 原码透传 |
| 其它（链路断开、拨号超时等） | 4502 `NODE_UNREACHABLE` |

目标侧 `LinkStreamTransport` 关闭时：1000 → `END`；4400、4403 先发 `ERROR` 帧，再 `END`（等对端读完，最长 10 s 后复位）；其它码直接复位 `exec:<code>`。

### 2.2 帧格式

```
frame := kind:u8 | len:u32 BE | payload[len]
```

头 5 字节。发送端数据帧载荷 ≤ 64 KiB（`EC_CHUNK_BYTES`），接收端拒收 > 1 MiB（`EC_MAX_FRAME_PAYLOAD`，按 `protocol_error` 处理）。JSON 载荷是 UTF-8 JSON 对象。第一帧必须是 HELLO，且只发一次。

| kind | 名称 | 方向 | 载荷 |
| --- | --- | --- | --- |
| 0x01 | HELLO | C→S | `{v:1, op:'open', spec}` 或 `{v:1, op:'resume', sessionId, out}` |
| 0x02 | READY | S→C | `ExecReady`：`sessionId`、`resumed`、`pid`、`device{id,name,type}`、`pty`、`stdin`（服务端已接收的 stdin 偏移）、`stdinClosed`、`out`（输出日志重发起点）、`window{stdin,out}`（均 4 MiB） |
| 0x10 | STDIN | C→S | 原始字节 |
| 0x11 | STDIN_EOF | C→S | 空 |
| 0x12 | RESIZE | C→S | `{cols, rows}` |
| 0x13 | SIGNAL | C→S | `{signal}`：`SIGINT/TERM/HUP/KILL/QUIT/USR1/USR2/WINCH` |
| 0x14 | ACK | C→S | `{out}`：客户端已写完到本地 fd 的输出日志累计偏移 |
| 0x15 | CLOSE | C→S | `{kill}`：客户端结束会话 |
| 0x20 | STDOUT | S→C | 原始字节（计入输出日志） |
| 0x21 | STDERR | S→C | 原始字节（计入输出日志） |
| 0x22 | EXIT | S→C | `{code, signal, reason:'exit'\|'timeout'\|'killed', durationMs}`（计入输出日志） |
| 0x23 | STDIN_ACK | S→C | `{stdin}`：子进程已接受的 stdin 累计字节 |
| 0x24 | ERROR | S→C | `{code, message}`；随后服务端关闭传输 |
| 0x30 / 0x31 | PING / PONG | 双向 | 空 |

### 2.3 打开会话（`spec`）

| 字段 | 规则 |
| --- | --- |
| `device` | 设备 id，或名称（精确匹配优先，其次忽略大小写）；缺省为 sortOrder 最小的 `local` 设备。找不到 `device_not_found`，非 `local` / `ssh` 类型 `exec_unsupported_device` |
| `command` | `shell{script, sh?}`：交给用户 shell `-c`，`sh:true` 改用 `/bin/sh -c`；`argv{argv[]}`：精确 argv，不经 shell；`login`：用户登录 shell（`-l`），有 PTY 时交互，无 PTY 时读 stdin 当脚本；`subsystem{name:'sftp'}`：`sftp-server`，供 `rsh -s`（scp / sftp）使用，不分配 PTY |
| `cwd` | 缺省为目标用户主目录；相对路径相对主目录解析，目录不存在 `exec_spawn_failed` |
| `env` | 键 `[A-Za-z_][A-Za-z0-9_]*`，至多 256 项，值 ≤ 32 KiB，叠加在子进程环境之上 |
| `pty` | `null` 不分配；`{cols, rows, term?}`，尺寸 1..1000，`term` 缺省 `xterm-256color` |
| `stdin` | `false` 时子进程 stdin 为 `/dev/null`，客户端不发 STDIN |
| `timeoutMs` | 子进程墙上时钟，0 / 缺省不限，上限 30 天 |
| `detachGraceMs` | 断线后会话保留时长，缺省 300000，范围 0..3600000 |

### 2.4 可靠性、流控与续传

**输出日志**是 STDOUT / STDERR / EXIT 帧按序拼成的字节序列，偏移按完整编码字节（含 5 字节头）计；READY、STDIN_ACK、ERROR、PING / PONG 不计。

- 服务端保留 `[acked, sent)` 的日志帧。`sent - acked ≥ 4 MiB`，或传输层缓冲 ≥ 1 MiB 时，停止读子进程 stdout / stderr（管道自然背压）。传输层缓冲回落到 256 KiB 以下触发 drain 继续发送。
- 客户端只有把一帧完整写进本地 fd（遵守 fd 背压）才计入偏移；累计未确认 ≥ 256 KiB，或距最后一帧 200 ms，发 ACK；收到 EXIT 后立即 ACK。
- stdin 反向对称：客户端保留已发未确认字节（≤ 4 MiB），满窗停止读本地 stdin；服务端按序写入子进程，写入后回 STDIN_ACK（累计 ≥ 64 KiB 或写队列排空时合并发送）。STDIN_EOF 在此前所有字节写完后才关闭子进程 stdin。
- 存活：一侧 15 s（`EC_PING_MS`）没发任何帧就发 PING，对端回 PONG；45 s（`EC_DEAD_MS`）没收到任何帧视为链路已死：客户端重连，服务端分离会话并以 4408 关闭传输。
- 断线与 resume：传输在未收到 CLOSE 时关闭，会话进入 **detached**，子进程继续跑（输出窗口满后阻塞）。客户端按 0.5、1、2、4、8、10、10… s 退避重连，发 `HELLO{op:'resume', sessionId, out}`。服务端要求同一鉴权主体（`uid`）；`out` 必须落在 `[acked, sent]` 且对齐帧边界，否则 `resume_gap`。通过后回 `READY{resumed:true, stdin, stdinClosed, out}` 并从 `out` 重放保留的日志帧。客户端丢弃 `≤ READY.stdin` 的 stdin，重发其余字节，必要时补 STDIN_EOF；PTY 会话重发一次 RESIZE。重连预算自首次丢失起计，到 `detachGraceMs` 为止，每次成功 READY 清零。
- 接管：同一会话在已有传输时又收到 resume，新传输接管，旧传输以 4409 关闭。
- detached 超过 `detachGraceMs`：向进程组发 SIGHUP，随即 SIGTERM，5 s 后 SIGKILL，会话销毁；之后 resume 得到 `session_not_found`。
- 结束：EXIT 入日志后，会话保留到客户端 ACK 越过 EXIT 或发 CLOSE，再销毁。运行中 `CLOSE{kill:true}`：SIGTERM 进程组，5 s 后 SIGKILL，销毁（不再发 EXIT）。运行中 `CLOSE{kill:false}` 等价于主动分离（进入 grace）。
- 信号：SIGNAL 投递给子进程所在**进程组**。超时：SIGTERM 进程组，5 s 后 SIGKILL，EXIT 的 `reason:'timeout'`；CLI 退出码 124。

### 2.5 进程模型

- **用户与 shell**：以网关服务用户运行。shell 取 `os.userInfo().shell`（须存在且可执行），否则回退到 tmux 同款默认 shell 解析，最后 `/bin/sh`。
- **环境**：继承服务进程环境，剔除 `VIBETERM_*` / `TMEX_*`、`DATABASE_URL`、`NODE_ENV` 等服务内部变量；`PATH` 用网关启动时探测的登录 shell PATH（与 tmux 会话一致，能找到 `~/.local/bin`）；`SHELL`、`HOME`、`USER`、`LOGNAME` 取自 passwd；补 UTF-8 locale；PTY 下设 `TERM`；最后叠加 `spec.env`。
- **进程组**：非 PTY 以 `detached: true` 起新进程组；信号、超时、grace 回收都作用于整组。
- **PTY**：Bun `terminal` 接口；stdout / stderr 合一（只有 STDOUT 帧），STDIN_EOF 写入 `^D`。Bun 的终端回调是推送式、不能暂停读取，所以输出队列越过 4 MiB 高水位时对整个会话发 SIGSTOP，消费到 1 MiB 以下发 SIGCONT；需要投递信号、kill 时先恢复；硬上限 64 MiB 兜底（超出终止子进程）。运行时不支持 PTY 返回 `pty_unsupported`。
- **ssh 设备**：复用旧路径的 OpenSSH 目标解析（`configRef` / 无口令密钥 / agent），要求 `BatchMode`，口令认证设备返回 `exec_unsupported_device`。argv：`ssh … -o ServerAliveInterval=15 -o ServerAliveCountMax=3`，非 PTY 加 `-T`，PTY 加 `-tt -e none`（ssh 本身跑在本机 PTY 下，RESIZE 才能传到远端），`subsystem` 为 `-T -s <dest> sftp`。远端命令：`shell` 的脚本原样交给 sshd（由远端用户 shell 解释），`sh:true` 与 `argv` 用单引号引用；`cwd` / `env` 以前置 `cd … && export …` 注入，要求远端 shell 是 POSIX 语法（csh 系用 `sh:true`）。
- 会话上限：每节点 64 个存活会话（`EC_MAX_SESSIONS`），超出 `session_limit`。

### 2.6 限制

| 项 | 值 |
| --- | --- |
| 单帧载荷（接收） | 1 MiB；发送分块 64 KiB |
| 输出 / stdin 窗口 | 各 4 MiB |
| 传输缓冲 | 服务端 1 MiB 停读、256 KiB 恢复 |
| 入口上行队列 | 流打开前 1 MiB，之后 16 MiB |
| PTY 队列 | 4 MiB 暂停、1 MiB 恢复、64 MiB 硬上限 |
| 存活会话 | 64 / 节点 |
| PING / 死链 | 15 s / 45 s |
| `timeoutMs` / `detachGraceMs` | ≤ 30 天 / ≤ 1 小时 |

不限制 stdout / stderr / stdin 总量。

### 2.7 关闭码与错误码

WebSocket 关闭码：

| 码 | 含义 |
| --- | --- |
| 1000 | 正常结束 |
| 1009 | 入口上行队列溢出 |
| 4400 | 协议错误或请求非法 |
| 4401 | 未认证，或依附的会话 / 令牌已失效（登出、撤销、过期） |
| 4403 | 禁止（令牌无 `exec` 作用域等） |
| 4404 | 入口判定目标不支持 exec 通道 |
| 4408 | 45 s 无任何帧 |
| 4409 | 被同一会话的新传输接管 |
| 4502 | 目标节点不可达 |

`ERROR` 帧的 `code`：`invalid_request`、`protocol_error`、`device_not_found`、`exec_unsupported_device`、`exec_spawn_failed`、`pty_unsupported`、`session_not_found`、`resume_gap`、`session_limit`、`forbidden`。

CLI 的退出码映射见 [CLI 使用手册](../operations/cli-usage.md)：远端退出码透传，信号为 `128+n`，超时 124；`exec` 的本地失败沿用 2 / 3 / 4 / 5，`rsh` 一律 255。

### 2.8 兼容与回退

- 旧目标节点没有 `/api/exec/ws`（本机升级请求得到 404）或没有 `exec` 流类型（`unknown-stream-type`），CLI 收到 4404 / 404，抛 `ExecChannelUnsupportedError`。
- **回退只发生在 READY 之前。** `runRemote` 在 `legacyFallback` 打开时改走 `POST /api/exec`（§4）：整体缓冲 stdin（≤ 740 KiB）、输出 8 MiB 封顶、无 PTY、无 `login` / `subsystem`，并打一次兼容告警；这些场景直接报「目标节点版本过旧」。会话建立之后出现的 4404 / 404 只是暂时的链路故障，一律按断线重连处理，绝不回退——回退会重跑已经在执行的命令。
- 会话尚未建立（READY 之前）的链路丢失不重试：重发 `open` 可能让命令执行两次。

### 2.9 安全

- **认证**：本机升级与 `/api/*` 同一套：`authenticateRequest` 取有效节点会话；standalone 开放部署无认证面，按无主身份放行。没有会话才认访问令牌（`Authorization: Bearer` 或 cookie `vibeterm_t_self`），且令牌必须含 `exec` 作用域，否则 403 `TOKEN_SCOPE`；无凭证 401 `UNAUTHORIZED`。会话优先，令牌不遮蔽也不补充会话。分享凭证不能开 shell。
- **mesh 流**：目标节点按 `verifyStreamAuth` 同口径校验会话 sid（`viaNodeId` 取握手对端），或 `tok:<secret>` 令牌（须含 `exec`）；分享凭证被拒绝。失败原因对外只分「无效」「作用域不足」。
- **Origin 检查**：浏览器发起的升级会带 `Origin`，必须与访问主机（含 `X-Forwarded-Host`）一致，否则 403 `FORBIDDEN_ORIGIN`，防止其它站点借已登录会话拉起 shell；CLI 等非浏览器客户端不带或带同主机 origin。
- **会话复核**：握手时校验一次后，网关每 30 s 复核依附的节点会话与令牌，并在撤销时立即复核：会话过期 / 被撤销 / 行被删除，或令牌撤销 / 过期，对应 exec 会话以 4401 终止并杀进程组；用户登出终止其名下全部 exec 会话。复核读库失败时不误杀。令牌撤销（`DELETE /api/auth/tokens/:id`）即时终止该令牌的所有会话。
- **resume 绑定主体**：只有创建会话的 `uid` 才能 resume，会话 id 是 128 位随机数，不能当凭证。
- **权限等价于账号**：命令以网关服务用户运行，权限就是该账号的权限；`exec` 作用域的令牌等同于该账号在节点上的 shell，签发要按最小范围与有效期。
- **纯 relay 节点不服务 exec**（§2.1）。
- 输出有背压、会话数有上限、PTY 队列有硬上限，单个会话不会拖垮网关；SSH 设备强制 `BatchMode`，不会在网关进程里卡口令询问。

## 3. 路径与鉴权汇总

| 调用 | 会话 | `exec` 令牌 |
| --- | --- | --- |
| `GET /api/exec/ws`、`/n/self/...`、`/n/<selfId>/...` | 通过 | 通过 |
| `GET /n/<otherId>/api/exec/ws` | 需要目标节点的会话 cookie | 目标节点的令牌 cookie |
| `POST /api/exec`（兼容） | 通过 | 通过 |

## 4. 兼容路径：`POST /api/exec`

仅为不支持 EC1 的旧节点保留，新功能不再加到这里。可经 mesh 转发：`POST /n/<nodeId>/api/exec`。鉴权同其它 `/api/*`，也接受带 `exec` 作用域的访问令牌。

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
| `argv` | 非空字符串数组；`shell: true` 时恰好 1 个元素 |
| `cwd` / `env` | 可选；`env` 键须为 `[A-Za-z_][A-Za-z0-9_]*`，覆盖在服务用户环境之上 |
| `stdin` | `{ "text" }` 或 `{ "base64" }`；整个请求体受 1 MiB JSON 上限约束，实际约 0.75 MiB |
| `timeoutMs` | 子进程墙上时钟，默认 600000，上限 3600000；不是 HTTP 空闲超时 |
| `shell` | `true` 时 `argv[0]` 交给 `/bin/sh -c`，不用用户登录 shell |
| `maxBytes` | 每路 stdout / stderr 上限，1 KiB..8 MiB，缺省 8 MiB；超出后丢弃并在 `exit.truncated` 标 `true`，子进程继续跑 |

校验失败（缺字段、设备不存在、口令认证 SSH）在开流前返回 HTTP 400 `{code, message}`；开流后 `200 application/x-ndjson`，每行一个事件：`start` → 若干 `stdout` / `stderr`（base64，≤ 64 KiB，同流保序）/ `ping`（子进程存活期间每 10 s 一条，重置入口与 CLI 的空闲时钟）→ `exit`（`code`、`signal`、`durationMs`、`truncated`、`reason: exit|exec_timeout`），超时再跟 `error`。错误码：`invalid_body`、`device_not_found`、`exec_unsupported_device`、`exec_spawn_failed`、`exec_timeout`、`exec_output_limit`。

实现差异：不分配 PTY（本地 pipe / ssh `-T`）；`local` 设备 argv 直接 `Bun.spawn`；`ssh` 设备强制 `BatchMode=yes`，远端命令为 `cd <cwd> && env K=V … exec <argv>`，口令认证返回 `exec_unsupported_device`；超时与客户端断开（请求 abort 或 NDJSON `cancel`）都是 SIGTERM，5 s 后 SIGKILL。子进程环境与 EC1 共用 `scrubbedBaseEnv` 的服务内部变量剔除规则。

## 5. `GET /api/system/facts`

与 `GET /api/system/info` 一样走 `handleSystemApiRequest`，需会话。返回本节点主机快照，供 `vibeterm system info` 合并展示。不含 `ss` / `listenTcp` 全量套接字。

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

## 6. 与 `term run` 的边界

| | exec 通道 | `term run` |
| --- | --- | --- |
| 通道 | 专用 WebSocket / mesh 流（EC1） | Borsh WS `terminal-input` |
| 目标 | 新子进程 / `ssh … cmd` | 已有 pane 的 PTY |
| stdout / stderr | 分路（PTY 下合一） | 混在 pane 字节流里 |
| 退出码 | 子进程 `EXIT` | 可选哨兵，不可靠 |
| 适用 | agent / 脚本 / 管道 / 长任务 | 对着用户正在看的窗格打一行 |
