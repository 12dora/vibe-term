# 窗口内存（读数与 systemd 限额）

本文说明 VibeTerm 怎么按 tmux 窗口统计内存、怎么在 Linux 上给每个窗口加 systemd 限额、怎么在 GUI / CLI 里查看与远程管理，以及宿主条件不满足时会发生什么；面向 Linux 运维与初级工程师。协议帧见 [ws-borsh v1 规范「WINDOW_MEMORY」](../architecture/ws-borsh-v1-spec.md)；进程在 OOM 后会不会整窗消失，见 [tmux 进程存活](./tmux-process-survival.md)。

**两件事要分开看**：

| 能力 | 条件 | 不满足时 |
| --- | --- | --- |
| 看到窗口内存读数 | 宿主有可用的 `ps`（几乎总有） | 徽标不渲染 |
| 给窗口套内存限额 | Linux + cgroup v2 + 用户级 systemd + **tmux ≥ 3.6 且带 systemd 支持** | 限额写得进设置但不会生效，界面会明说 |

2.8.0 之前只有前一套判据的一半：宿主只要有 cgroup v2 与用户级 systemd 就被判为「支持」，却没检查 tmux 有没有真的把 pane 放进 scope。tmux < 3.6（Ubuntu 24.04 是 3.4、Debian 12 是 3.3a）下所有读数都是 0，徽标显示 `0 B`，限额也悄悄不生效。

## 背景

tmux ≥ 3.6（发行版带 systemd 支持）会给**每个 pane** 建独立的用户级 scope：`tmux-spawn-<uuid>.scope`。pane 里的 shell 及其子进程都在这个 cgroup 里。

过去没有 per-window 上限时，窗口内的 `tsgo` / `next-server` 一类进程可以吃到 10–12 GB，触发内核 OOM。即便安装程序已经把 `DefaultOOMPolicy=continue` 写进用户级 systemd（避免「杀一个进程就拆掉整个 scope」），失控进程仍然能把整机内存打满。

## 目标

在 **Linux + tmux ≥ 3.6 + 用户级 systemd + cgroup v2** 的宿主上：

1. 新窗口 / 分屏 / 拆窗之后立刻给对应 scope 套上 `MemoryHigh` / `MemoryMax` / `MemorySwapMax`；漏配的 scope 由采样器补套。
2. 关窗 / 关 pane 之前先 `systemctl --user stop` 该 scope，把失控子进程一起带走，再跑 tmux `kill-window` / `kill-pane`。
3. 按窗口聚合内存读数，经 WebSocket 推到客户端，并在 CLI 提供同一份快照。
4. 记录粘性 OOM 标记，方便事后看到「这个窗口曾经被内核杀过」。

没有 pane scope 的宿主（tmux < 3.6、tmux 未编 systemd 支持、macOS、没有 cgroup v2）：

5. 读数回退到「pane 进程树 RSS 合计」，徽标照常显示真实用量，但如实标明限额不可用；连 RSS 都取不到的窗口不发帧、不渲染。

## 设计

限额的粒度是 **pane 的 systemd scope**；窗口数字是各 pane 的合计。`current` / `oomKills` 按窗口求和；`high` / `max` / `swapMax` 取各 pane 里最小的非零值（同一窗口的 pane 共用一份配置；若不一致就显示更严的那档）。`0` 表示未设限（cgroup 文件为 `max`）。

### scope 解析

网关从 tmux 快照拿 `#{pane_pid}`，在宿主上读 `/proc/<pid>/cgroup`，取以 `0::` 开头的那一行路径 `P`：

- 最后一段匹配 `tmux-spawn-*.scope`，且该 cgroup 的 `memory.current` 读得到 → `source=cgroup`，scope 名就是这一段，cgroup 目录为 `/sys/fs/cgroup<P>`，限额与 OOM 计数都从这里读。
- 不在 `tmux-spawn-*.scope` 里（旧 tmux、无 systemd），或 `memory.current` 读不到（memory 控制器没下放、LSM 挡住）→ 该 pane 不管理，读数走下面的 RSS 兜底。

### RSS 兜底

没有 scope 的 pane，`current` 取**该 pane 进程树的 RSS 合计**（`pane_pid` 及其全部后代），限额三个字段恒为 0，`source=rss`。
进程表来自 `ps -Ao pid=,ppid=,rss=`（依次回退 `ps -eo …`、`ps ax -o …`、`ps -o …`），每个 tick 最多取一次，且**只在真的需要兜底时才取**——
全是 cgroup 的宿主一次 `ps` 都不跑。每条候选的输出都先校验「至少有一行三列全是十进制整数」，避免 BusyBox 这类 `ps` 对未知选项
仍打印默认列表（`PID USER VSZ STAT COMMAND`）时把 VSZ 当成 RSS。子树求和在一次 awk 里完成。

取不到进程表、或 pane 进程已经退出（合计为 0）→ `source=none`，该 pane 没有读数；一个窗口里所有 pane 都是 `none` 时**整窗不发帧**，
客户端因此不渲染徽标，而不是显示 `0 B`。

RSS 与 cgroup 读数口径不同：RSS 把父子共享页重复计了一点，也不含 page cache，通常比同一窗口的 cgroup 读数略小。界面会标明来源。

本地设备用 `Bun.spawn(['sh','-c', script])`（环境与 tmux 命令相同）。到时限（默认 10 s）后对 `sh` 及其子进程发 `SIGTERM`，500 ms 后再 `SIGKILL`，立刻以 `exitCode: 124`、`stderr: timeout` 返回，不等管道 EOF。SSH 设备把同一段 POSIX sh 送到远端执行（超时走 SSH exec 自己的时限）。同一设备同一时刻只跑一份采样脚本，上一轮没结束就跳过本 tick。

### 应用限额

```bash
systemctl --user set-property --runtime <scope> MemoryHigh=<n>M MemoryMax=<n>M MemorySwapMax=<n>M
```

数值来自该节点的设置（整数 MB）。`0` 的意思是**写成 `infinity`**（清掉这一档已经套上的上限），不是「别动原来的属性」。只要三个字段不全为 0，三条属性每次都会写上：非 0 写成 `<n>M`，为 0 写成 `infinity`。比较观测值与配置时，`0` 与 cgroup 的 `max` 等价。

三个都是 0、或关掉 `enabled`：采样和推送**按原周期继续**（关开关不会把周期拉长）。读数以**下一次真实采样**为准——`set-property` 退出码 0 不会把内存里的 high/max 改成 0。只要样本仍是有限值，就再写一遍三条 `infinity`。`limitsSupported === false` 只跳过「套上有限限额」；scope 名还在时释放照样做。

同一轮还会清扫**本 tmux server** 留下的孤儿 scope（pane 已经不在快照里，但 `tmux-spawn-*.scope` 还挂着有限的 MemoryHigh/Max/SwapMax）。归属只认两件事：活着的 pane 的父进程是同一个 `comm=tmux` 的 server，且该 scope 的 cgroup 与这只 server 在同一个 slice；再加上 Description 里的 `launched by process <server pid>`，或 cgroup 里还有这只 server 的后代。别的 tmux、别的 slice 不动。限额仍然开着时不扫这些孤儿——活 pane 每 tick 会校正，死 pane 留着上一次的有限上限。

失败打：

```
[vibeterm][window-memory] set-property failed device=… pane=… scope=… : <stderr>
```

套有限限额：失败后再等 60 s 试第二次，然后打一行 `set-property giving up`（带 stderr）并不再试，直到目标命令变了或进程重启。释放：同样 60 s 退避，第二次失败时打一行 `release giving up …; retrying while the sample stays limited`（带 stderr），**之后只要样本还是有限值就继续试**，不再静默停掉。新 pane 出现后 300 ms 内会补一次 tick（跟在 `new-window` / `split-window` / `break-pane` 的 snapshot 后面）。

`set-property`、释放、`stop`、孤儿清扫在调用 `systemctl --user` 之前，用和采样脚本同一段逻辑补上 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`（缺省 `unix:path=$XDG_RUNTIME_DIR/bus`）。采样能读到限额、写入却连不上用户总线的情况因此对不齐。

`--runtime` **不落盘**：属性只活在这个瞬时 scope 上，pane 没了 scope 也就没了，下次新建会重新套。没有活着的 pane 时认不出「哪只 tmux server」，孤儿清扫会停手，不会去猜。

### 关窗前 stop

`closeWindowInternal` / `closePaneInternal` 在 `kill-window` / `kill-pane` 之前，对该窗口 / pane 已知的每个 scope 执行 `systemctl --user stop <scope>`（阻塞，超时 10 s）。超时只打日志，kill 照常进行。stop 会把 shell 一起杀掉，tmux 窗口可能已经先收到 `%window-close`，现有的 `allowTargetMissing=true` 会吞掉「找不到窗口」。远端节点由**那台节点自己的网关**执行，mesh 转发路径不必再做一遍。

### 采样脚本（每设备每 tick 一次往返）

网关把当前快照里的 `paneId<TAB>pid` 列表经 heredoc 喂给脚本（不在脚本里自己找 tmux socket）。脚本是 dash 兼容的 POSIX sh。

第一行：`VTMEM 2 <uid> <limitsSupported:0|1> <reason>`，`reason` 为 `ok` | `no-cgroup2` | `no-user-systemd`。
`/sys/fs/cgroup/cgroup.controllers` 不存在 → `0 no-cgroup2`；`systemctl --user show-environment` 失败 → `0 no-user-systemd`；都过 → `1 ok`。
**`limitsSupported=0` 不再提前退出，pane 行照常输出**（这时只有 RSS 兜底）。调用 `systemctl --user` 之前脚本会
`export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"`，若 `DBUS_SESSION_BUS_ADDRESS` 未设则写成
`unix:path=$XDG_RUNTIME_DIR/bus`（SSH 会话经常缺这两项）。

随后每 pane 一行，TAB 分隔：

```
paneId  pid  scope  current  high  max  swapMax  oomKill  managed  source
```

`scope` 不是 tmux-spawn 时为 `-`；数字是字节，cgroup `max` 写成 `0`；`oomKill` 来自 `memory.events` 的 `oom_kill`；
`managed=1` 表示 `memory.high` 已经不是 `max`；`source` 为 `cgroup` | `rss` | `none`（见上一节）。

默认周期 5 s（可配 2–60 s）。连续 6 个 tick「有 pane 但一个都量不到」时，采样退避到 60 s 并停止发帧；
任何一次又量到就立刻恢复到设置的周期。

### 实时数据：`WINDOW_MEMORY`（0x0107）

拥有该设备的网关在 HELLO 里播报能力 `window-memory-v1` 与 `window-memory-v2`。每个已订阅该设备的会话会收到 Borsh 帧 `KIND_WINDOW_MEMORY = 0x0107`：

`deviceId`、`windowId`、`current` / `high` / `max` / `swapMax`（`u64` 字节）、`oomKills`（`u32`）、`oomFlag`（bool）、`panes`（`u8`）、`sampledAt`（`u64` Unix ms）、`source`（`u8`：0 cgroup、1 rss）。

`source` 是 2.8.0 追加在 v1 载荷尾部的第十一个字段，kind 没变：老客户端按 v1 schema 解新帧仍然正确，新客户端解不出 v2 就退回 v1 并把来源当作 `cgroup`。

`current` 变化不到 1 MiB 且其它字段没变时抑制；来源变了一定发；每个窗口至少每 30 s 心跳一帧。窗口从 snapshot 消失后，客户端自己丢掉对应条目。老客户端忽略未知 kind。协议细节见 [ws-borsh v1](../architecture/ws-borsh-v1-spec.md)。

### OOM 粘性标记

每个 scope 记一份 `oomKills` 基线。采样值上升时：

```
[vibeterm][window-memory] oom_kill device=<id> window=<@id> pane=<%id> scope=<scope> kills=<n> current=<bytes> high=<bytes> max=<bytes>
```

同时把标记写入 `gateway_kv` 键 `windowMemory.oomMarks`（JSON map，键 `"<deviceId>/<windowId>"`，值 `{ scope, oomKills, firstAt, lastAt }`）。窗口上有行则 `oomFlag = true`。行在三种情况下删除：VibeTerm 关窗路径（`systemctl --user stop` 该窗口的 scope 之后立刻清）；连续 2 个 tick 该窗口都不在 snapshot 里（功能关闭时的 tick 也跑这一步）；删除设备时整设备清掉。标记跨网关重启仍在，这是「粘性」的意义。没有单独的 SQL 表。

宿主判定为不支持时打一行 `console.info`：

```
[vibeterm][window-memory] unsupported device=<id>
```

`no-cgroup2` 视为永久不支持：停掉采样定时器，这条连接上不再试。`no-user-systemd`（以及其它非永久的 unsupported 头）继续按周期采样，连续 6 次 miss（默认 5 s 周期约 30 s）才把 `supported` 钉成 `false` 并打上面那行 info（只打一次）；定时器仍在，之后若收到 `supported=1` 会复位。

### 设置（每网关 / 节点一份）

存在 `gateway_kv` 键 `windowMemory.settings`，JSON：

| 字段 | 默认 | 含义 |
| --- | ---: | --- |
| `enabled` | `true` | 总开关；`false` 时把已套限额的 scope（含本 server 的孤儿 scope）释放成 `infinity`，采样与推送继续，直到 cgroup 读数变成无限 |
| `memoryHighMb` | `8192` | `MemoryHigh`，软限额 |
| `memoryMaxMb` | `12288` | `MemoryMax`，硬限额 |
| `memorySwapMaxMb` | `4096` | `MemorySwapMax` |
| `sampleIntervalSec` | `5` | 采样周期，2–60 |

校验：整数；MB 范围 `0…1048576`；`memoryHighMb` 与 `memoryMaxMb` 都非 0 时前者不得大于后者。无环境变量覆盖。

HTTP（与其它设置路由同一套管理会话鉴权；可走 `/n/<nodeId>/` 前缀）：

- `GET /api/settings/window-memory` → 整条记录。
- `PUT /api/settings/window-memory` → body 必须是完整五字段；失败 `400`，`{ code, error: { code, message } }`，`code` 为 `INVALID_WINDOW_MEMORY_SETTINGS`。成功后立刻 `tick` 一遍已连接设备。不广播 `SETTINGS_UPDATE`；采样器每个 tick 调 `getSettings()`，限额变了就对已管理的 scope 再 `set-property`。

CLI 快照（HTTP 不打宿主，读运行时缓存）：

- `GET /api/sessions/memory` → `{ devices: [{ deviceId, deviceName, connected, supported, limitsSupported, windows: [{ windowId, windowName, panes, scopes, current, high, max, swapMax, oomKills, oomFlag, sampledAt, source, stale? }] }] }`。`connected` 是这台网关的 tmux 会话是否还连着，不是「有没有浏览器开着」。设备未挂上或 tmux 连接未打开 → `connected: false, supported: false, windows: []`，**不会**把 tracker 里上一份限额交出去；tracker 也已 `stop`，断开期间不再采样、不再 `set-property`。已连接时窗口列表来自最近一份 snapshot。`sampledAt` 早于 `max(6 × 采样周期, 60s)` 时窗口带 `stale: true`，并把 `high` / `max` / `swapMax` 清成 0（`sampledAt` 与 `current` 保留）——旧客户端忽略 `stale` 也只会看到「无限」，不会把几天前的 8 GiB / 12 GiB 当成现在的限额。`supported` 仍是采样器判定。

## GUI

### 终端页右上角徽标

`data-testid="window-memory-badge"`，紧挨延迟徽标（`DevicePage` 的 `PageActions`，`DeviceNodeBadges` 后面）。文案是当前窗口的 `current`（`formatBytes`，如 `1.2 GB`）。没有该窗口的样本（量不到、功能关闭、超过 90 s 没收到帧）整块不渲染。

颜色（`data-tone`）：

| 条件 | tone |
| --- | --- |
| `source = rss`（没有限额可比），且没有 OOM 标记 | `ok` |
| `high == 0`，或 `current < 75% high`，且没有 OOM 标记 | `ok` |
| `current ≥ 75% high` | `warn`（琥珀） |
| `current ≥ high`，或 `oomFlag` | `blocked`（红，`border-destructive/40 text-destructive`） |

`oomFlag` 时再加红点 `window-memory-oom-dot`，即使当前用量已经掉下来也保持红色。

浮层内容按来源分两种：

- `source = cgroup`：当前用量 / 软限额 / 硬限额 / 交换限额（`0` 显示 `∞`），以及「OOM 已杀 N 次」。
- `source = rss`：当前用量，加两行——「窗口限额：此宿主不支持（需 tmux ≥ 3.6）」与「读数来源：进程树 RSS 合计」。
  不要把这里的 `0` 显示成 `∞`：那会把「限不了」说成「没限」。

### 设置 → 节点 →「内存限额」

本机卡片上，中继服务与网络两段之间，`data-testid="local-machine-memory"`。启用开关 + 三个 MB 输入 + 采样周期，保存时五字段整包 PUT。

| 控件 | `data-testid` |
| --- | --- |
| 启用 | `memory-limits-enabled` |
| 软限额 | `memory-memoryHighMb` |
| 硬限额 | `memory-memoryMaxMb` |
| 交换限额 | `memory-memorySwapMaxMb` |
| 采样周期 | `memory-sampleIntervalSec` |
| 保存 | `memory-limits-save` |

已连接的设备里只要有一台 `limitsSupported === false`，表单上方会多出一条警示（列出受影响的设备名），
说明这份限额在那些宿主上不会生效。读取 `/api/sessions/memory` 失败时不渲染警示，也不挡表单。

### 设置 → 节点 → 节点管理表（远程 / 批量）

同一份限额可以写到**别的节点**上，走 `/n/<nodeId>/api/settings/window-memory`：

| 入口 | `data-testid` | 说明 |
| --- | --- | --- |
| 行内「更多」→ 内存限额 | `nodes-memory-<rowId>` | 打开该节点的对话框（`nodes-memory-dialog-<rowId>`），进来先 GET 它当前的值 |
| 对话框字段 | `nodes-memory-<nodeId>-<字段名>` | 与本机卡同一套校验（`memory-limits-form.ts`） |
| 对话框保存 | `nodes-memory-save-<rowId>` | 写入中关不掉（Esc / 遮罩 / 关闭键都挡住） |
| 目标宿主限不了额的警示 | `nodes-memory-unsupported-<nodeId>` | 打开时并行拉该节点 `/api/sessions/memory`，失败静默 |
| 卡头批量「更多」→ 内存限额 | `nodes-bulk-memory` | 打开批量框 `nodes-memory-bulk-dialog` |
| 批量目标 / 跳过 | `nodes-memory-target-<rowId>` / `nodes-memory-skip-<rowId>` | 跳过原因见下 |
| 批量写入 | `nodes-memory-bulk-apply` | 并发 3，一台失败不影响其余；失败逐台列出（`nodes-memory-failed-<rowId>`） |

跳过规则（按顺序判定）：版本低于 2.7.0（没有这个 API）→ 本机放行 → 离线 → 未登录该节点 → 已暂停
（暂停节点的 `/api/settings/*` 被转发器按 `purpose: 'user'` 闸掉，这是有意为之，没有为它放宽转发语义）。

批量是「把同一份限额写上去」，**不会**先读各节点当前值再合并。批量框里常驻一句提醒：写入的是设置，
宿主没有 pane scope 时不会真的限住。

## CLI

```bash
vibeterm sessions [--node <node>] [--memory] [--json]
vibeterm settings memory get
vibeterm settings memory set [--enabled on|off] [--high <MB>] [--max <MB>] [--swap-max <MB>] [--interval <sec>]
```

- `sessions`：先 `GET /api/sessions/memory`。`connected: true` 的设备直接用 HTTP 行；`connected: false` 的设备会再开一条设备 WS（与 `tmux ls` 同类）补窗口列表。带 `--memory` 时这条会话会等到每个窗口都有 `window-memory` 样本，或 `2 × sampleIntervalSec + 3 s` 耗尽（间隔取 `GET /api/settings/window-memory`）；HELLO 没有 `window-memory-v1` 或等不到样本则 `supported: false`、内存列为 `-`。同时最多 4 台设备开 WS。人读表列为 `DEVICE`、`WINDOW`（`@id name`）、`PANES`；`--memory` 再加 `SCOPE`（第一个 scope，多个时 `+N`，没有为 `-`）、`SOURCE`（`cgroup` / `RSS`）、`MEM`（当前用量）、`HIGH` / `MAX`（`0` 为 `∞`）、`OOM`（次数；`oomFlag` 时后缀 `!`）。未采样窗口（`sampledAt === 0`）以及 `stale: true` 的窗口，`SOURCE` / `MEM` / `HIGH` / `MAX` / `OOM` 一律为 `-`（不把过期的 high/max 印成 `∞` 或具体 GiB）。`limitsSupported: false` 的设备在 `--memory` 模式下于其行后打印 `(limits unavailable)`；能限额但采不到读数（`supported: false`）则打印 `(cannot sample memory)`，两条不会叠印。非 TTY 默认 JSON（与 `exec` 相同）。`--json` 打填过 WS 之后的 payload（不是裸 HTTP 响应；未采样窗口不带 `source`）。
- `settings memory`：`GET/PUT /api/settings/window-memory`。`set` 先 GET 再按旗标合并后整包 PUT；非法整数 / 越界 / `high > max` 为用法错误（退出码 2）。尊重全局 `--node`。人读为 `key  value` 行。

用法细节见 [命令行使用手册](./cli-usage.md)。

## 宿主条件不满足时

两件事分开判，都是**按设备**判的（同一网关下其它设备不受影响）。

### 限不了额（`limitsSupported = false`）

下列任一成立：

- 非 Linux（含 macOS / Windows），或没有 cgroup v2（`/sys/fs/cgroup/cgroup.controllers` 不存在）
- `systemctl --user show-environment` 失败（没有用户级 systemd 会话）
- **有 pane 读数、却一个 `tmux-spawn-*.scope` 都没有**（tmux 低于 3.6 或未编 systemd 支持）

前两条由采样脚本的头判定（`no-cgroup2` 在这次连接内永久，`no-user-systemd` 连续 6 次才钉死，中途恢复就复位）；
第三条由 tracker 按样本每 tick 重算，换上新 tmux 之后会自己恢复。判为 false 时不再把**有限**限额 `set-property` 上去（省掉每 tick 的无用往返）；
已经点了名的 scope 在「关掉或三项都是 0」时仍会释放。`no-cgroup2` 不再去列用户 scope（宿主上不可能有 `tmux-spawn-*.scope`）。
徽标提示写明限额不可用，设置页与远程限额对话框给出警示，`sessions --memory` 在设备行下打 `(limits unavailable)`。
**读数照常**，走 RSS 兜底。

### 量不到（`supported = false`）

连续 6 个 tick「快照里有 pane，却一个 pane 都拿不到读数」（`ps` 不可用、pid 全都不在进程表里）：停止发帧，
采样退避到 60 s，打一行 `[vibeterm][window-memory] unsupported device=<id>`（只打一次）。这**不是**永久判定——
任何一次又量到就立刻恢复正常周期与推送。GUI 徽标在读数过期（90 s 无新帧）后消失；`sessions --memory` 打 `(cannot sample memory)`。

SSH 设备上若用户级 systemd 其实可用，但会话缺 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`，脚本会按上面的默认值补上再测。

## 注意事项

- `set-property --runtime` 不持久，scope 随 pane 消亡；不要指望重启后属性还在 unit 文件里。把某一档改成 `0`、三个都改成 `0`、或关掉功能，已经套过的 scope（含不再出现在 pane 列表里、但仍属于这只 tmux server 的 `tmux-spawn-*.scope`）会收到 `infinity`，`systemctl --user show` 应回到无限。退出码 0 不算数，下一次采样读到的 cgroup 文件才算。
- 本地宿主脚本硬超时默认 10 s，超时 `exit 124`；不要把挂死的 `systemctl` 当成采样成功。
- **`MemoryHigh`（软限额）**：内核开始回收 / 限速该 cgroup 的内存页，**不杀进程**。徽标在 ≥ 75% 时变黄，就是在逼近这一档。
- **`MemoryMax`（硬限额）**：用量越过上限后由内核 OOM 杀掉 pane 内进程。配合 [tmux 进程存活](./tmux-process-survival.md) 里的 `DefaultOOMPolicy=continue`：被杀的是超限进程，systemd **不会**因此拆掉整个 scope、把还活着的 shell 一起停掉。没有 `continue` 时，一次 OOM 仍可能让整窗消失。
- SSH 设备上的脚本在**远端**跑，限额套的是远端 pane 的 scope，不是跑网关的那台机器。
- 需要用户级 systemd 会话：该 Unix 用户得能 `systemctl --user`。未登录且未 `loginctl enable-linger` 时，采样脚本会把该设备判为限不了额（读数仍走 RSS）。
- **RSS 兜底只是读数，不是限额**：它不会阻止任何进程吃内存。要真正限住，宿主得升到 tmux ≥ 3.6（带 systemd 支持）。
- RSS 合计会把父子进程共享的页重复计一点，也不含 page cache，与同一窗口的 cgroup 读数不完全可比；跨机器对比数字前先看徽标提示里的来源。
- 关窗前 `stop` 的是 VibeTerm 已知的 scope；从未被采样到的失控进程（例如在 VibeTerm 连上之前就建好、又读不到 pid 的 pane）不在此列。

## 只读排查

在 **tmux 所在的那台宿主**上（SSH 设备请先登到远端）：

```bash
# 找到 pane 的 scope
tmux list-panes -a -F '#{pane_id} #{pane_pid} #{window_id}'
cat /proc/<pane_pid>/cgroup          # 0::/user.slice/…/tmux-spawn-<uuid>.scope

# 当前限额与用量
systemctl --user show tmux-spawn-<uuid>.scope -p MemoryCurrent,MemoryHigh,MemoryMax,MemorySwapMax,OOMPolicy

# 内核是否已经 OOM 过这个 cgroup
cat /sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/app.slice/tmux-spawn-<uuid>.scope/memory.events

# pane 启停与 oom-kill
journalctl --user | grep tmux-spawn
journalctl -k | grep -E 'Out of memory|invoked oom-killer'

# 用户级 OOM 策略（应为 continue）
systemctl --user show -p DefaultOOMPolicy
```

没有 pane scope 的宿主（tmux < 3.6、macOS）上改看 RSS 这条路：

```bash
tmux -V                                   # < 3.6 就不会有 tmux-spawn-*.scope
tmux list-panes -a -F '#{pane_id} #{pane_pid}'
ps -Ao pid=,ppid=,rss= | head             # 三列都得是数字，否则采样器会拒掉这张表
# 某个 pane 的进程树 RSS（KB）
ps -Ao pid=,ppid=,rss= | awk -v t=<pane_pid> '{kb[$1]=$3;ch[$2]=ch[$2]" "$1} END{n=1;s[1]=t;seen[t]=1;while(n>0){p=s[n];n--;if(p in kb)tot+=kb[p];if(p in ch){m=split(ch[p],k," ");for(i=1;i<=m;i++)if(k[i]!=""&&!(k[i] in seen)){seen[k[i]]=1;s[++n]=k[i]}}}print tot}'
```

这个数字乘 1024 就该与徽标 / `sessions --memory` 的 `MEM` 对得上。

网关侧搜 `[vibeterm][window-memory]`（套限额失败、oom_kill、unsupported）和 `[tmux] stop-scope`（关窗前 stop）。

## 验收清单

- [ ] Linux + tmux ≥ 3.6 + 用户级 systemd 的本地设备：新建窗口后 `systemctl --user show <scope> -p MemoryHigh,MemoryMax` 与设置一致。
- [ ] 三个 MB 都填 `0`：采样仍在（CLI `sessions --memory` 有读数）；已管理的 scope 收到三条 `infinity`，未管理的不动。
- [ ] 限额改为 `0` 后，`systemctl --user show <scope> -p MemoryHigh,MemoryMax,MemorySwapMax` 应回到 `infinity`。
- [ ] `enabled` 关掉或三项都是 0：采样仍按原周期走；已管理的 scope 和本 server 的孤儿 scope 被写成 `infinity`，下一次 cgroup 读数（以及 `sessions --memory`）里的 high/max 为 0 / `∞`，而不是几天前的数字。样本超过 `max(6 × 周期, 60s)` 时 HTTP 带 `stale: true` 且不再展示旧限额。
- [ ] 关窗后对应 `tmux-spawn-*.scope` 消失，失控子进程不再留在后台。
- [ ] 终端页当前窗口有样本时出现 `window-memory-badge`；用量过软限额 75% 变黄，过软限额或有 OOM 标记变红。
- [ ] 设置页 `local-machine-memory` 保存后 `GET /api/settings/window-memory` 与表单一致；非法输入（`high > max`、非整数）拒绝且不写库。
- [ ] `vibeterm sessions --memory` 与 GUI 徽标同一窗口的 `MEM` / `HIGH` / `MAX` / `OOM` 对得上；未连接的设备能列出窗口（`--memory` 会等样本）；`--json` 为填过 WS 之后的 payload。
- [ ] macOS 或无 cgroup v2 的设备：徽标**有**读数（进程树 RSS），提示里写明限额不可用；`sessions --memory` 的 `SOURCE` 为 `RSS`、设备行下有 `(limits unavailable)`。
- [ ] tmux < 3.6 的 Linux 设备（如 Ubuntu 24.04 的 3.4）：同上——读数非 0、`limitsSupported` 为 `false`、设置页出现「不会生效」警示。
- [ ] 在 pane 里跑一个吃几百 MB 的进程：徽标读数跟着涨（RSS 与 cgroup 两条路径都要看一遍）。
- [ ] 窗口里所有 pane 的进程都退出后：不再发帧，徽标在 90 s 内消失，不会出现 `0 B`。
- [ ] 节点管理表：行内「更多」→ 内存限额能读到目标节点当前值，保存后目标节点 `GET /api/settings/window-memory` 同步变化；写入过程中关不掉对话框。
- [ ] 节点管理表批量：勾选多台后写入，逐台成败有交代；离线 / 未登录 / 已暂停 / 版本 < 2.7.0 的节点出现在跳过清单里并注明原因。
- [ ] 目标节点是老 tmux 时，远程对话框里出现「限额不会生效」的警示。
- [ ] SSH 设备：限额出现在远端 `systemctl --user show`，不出现在跑网关的那台机器上。
