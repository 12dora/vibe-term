# 窗口内存限额（Linux tmux pane scope）

本文说明 VibeTerm 如何在 Linux 上给每个 tmux 窗口加上 systemd 内存限额、如何在 GUI / CLI 里查看用量，以及宿主不支持时会发生什么；面向 Linux 运维与初级工程师。协议帧见 [ws-borsh v1 规范「WINDOW_MEMORY」](../architecture/ws-borsh-v1-spec.md)；进程在 OOM 后会不会整窗消失，见 [tmux 进程存活](./tmux-process-survival.md)。

## 背景

tmux ≥ 3.6（发行版带 systemd 支持）会给**每个 pane** 建独立的用户级 scope：`tmux-spawn-<uuid>.scope`。pane 里的 shell 及其子进程都在这个 cgroup 里。

过去没有 per-window 上限时，窗口内的 `tsgo` / `next-server` 一类进程可以吃到 10–12 GB，触发内核 OOM。即便安装程序已经把 `DefaultOOMPolicy=continue` 写进用户级 systemd（避免「杀一个进程就拆掉整个 scope」），失控进程仍然能把整机内存打满。

## 目标

在 **Linux + tmux ≥ 3.6 + 用户级 systemd + cgroup v2** 的宿主上：

1. 新窗口 / 分屏 / 拆窗之后立刻给对应 scope 套上 `MemoryHigh` / `MemoryMax` / `MemorySwapMax`；漏配的 scope 由采样器补套。
2. 关窗 / 关 pane 之前先 `systemctl --user stop` 该 scope，把失控子进程一起带走，再跑 tmux `kill-window` / `kill-pane`。
3. 按窗口聚合内存读数，经 WebSocket 推到客户端，并在 CLI 提供同一份快照。
4. 记录粘性 OOM 标记，方便事后看到「这个窗口曾经被内核杀过」。

macOS、没有 systemd、没有 cgroup v2 的宿主**静默不启用**，不影响其它功能。

## 设计

限额的粒度是 **pane 的 systemd scope**；窗口数字是各 pane 的合计。`current` / `oomKills` 按窗口求和；`high` / `max` / `swapMax` 取各 pane 里最小的非零值（同一窗口的 pane 共用一份配置；若不一致就显示更严的那档）。`0` 表示未设限（cgroup 文件为 `max`）。

### scope 解析

网关从 tmux 快照拿 `#{pane_pid}`，在宿主上读 `/proc/<pid>/cgroup`，取以 `0::` 开头的那一行路径 `P`：

- 最后一段匹配 `tmux-spawn-*.scope` → scope 名就是这一段，cgroup 目录为 `/sys/fs/cgroup<P>`。
- 不在 `tmux-spawn-*.scope` 里（旧 tmux、无 systemd）→ 该 pane 不管理。

本地设备用 `Bun.spawn(['sh','-c', script])`（环境与 tmux 命令相同）；SSH 设备把同一段 POSIX sh 送到远端执行。同一设备同一时刻只跑一份采样脚本，上一轮没结束就跳过本 tick。

### 应用限额

```bash
systemctl --user set-property --runtime <scope> MemoryHigh=<n>M MemoryMax=<n>M MemorySwapMax=<n>M
```

数值来自该节点的设置（整数 MB）。某个字段为 `0` 就不写那条属性；三个都是 `0` 等于「限额关、采样仍开」。`enabled: false` 则采样与套限额一起停。

失败打：

```
[vibeterm][window-memory] set-property failed device=… pane=… scope=… : <stderr>
```

每个 scope 最多再试一次，间隔 60 s。已套过的 scope 记在连接内的 `Map`，设备断开即清。新 pane 出现后 300 ms 内会补一次 tick（跟在 `new-window` / `split-window` / `break-pane` 的 snapshot 后面）。

`--runtime` **不落盘**：属性只活在这个瞬时 scope 上，pane 没了 scope 也就没了，下次新建会重新套。

### 关窗前 stop

`closeWindowInternal` / `closePaneInternal` 在 `kill-window` / `kill-pane` 之前，对该窗口 / pane 已知的每个 scope 执行 `systemctl --user stop <scope>`（阻塞，超时 10 s）。超时只打日志，kill 照常进行。stop 会把 shell 一起杀掉，tmux 窗口可能已经先收到 `%window-close`，现有的 `allowTargetMissing=true` 会吞掉「找不到窗口」。远端节点由**那台节点自己的网关**执行，mesh 转发路径不必再做一遍。

### 采样脚本（每设备每 tick 一次往返）

网关把当前快照里的 `paneId<TAB>pid` 列表经 heredoc 喂给脚本（不在脚本里自己找 tmux socket）。脚本是 dash 兼容的 POSIX sh。

第一行：`VTMEM 1 <uid> <supported:0|1>`。`/sys/fs/cgroup/cgroup.controllers` 不存在，或 `systemctl --user show-environment` 失败 → `supported=0`，只打这一行。

随后每 pane 一行，TAB 分隔：

```
paneId  pid  scope  current  high  max  swapMax  oomKill  managed
```

`scope` 不是 tmux-spawn 时为 `-`；数字是字节，cgroup `max` 写成 `0`；`oomKill` 来自 `memory.events` 的 `oom_kill`；`managed=1` 表示 `memory.high` 已经不是 `max`。

默认周期 5 s（可配 2–60 s）。

### 实时数据：`WINDOW_MEMORY`（0x0107）

拥有该设备的网关在 HELLO 里播报能力 `window-memory-v1`。每个已订阅该设备的会话会收到 Borsh 帧 `KIND_WINDOW_MEMORY = 0x0107`：

`deviceId`、`windowId`、`current` / `high` / `max` / `swapMax`（`u64` 字节）、`oomKills`（`u32`）、`oomFlag`（bool）、`panes`（`u8`）、`sampledAt`（`u64` Unix ms）。

`current` 变化不到 1 MiB 且其它字段没变时抑制；每个窗口至少每 30 s 心跳一帧。窗口从 snapshot 消失后，客户端自己丢掉对应条目。老客户端忽略未知 kind。协议细节见 [ws-borsh v1](../architecture/ws-borsh-v1-spec.md)。

### OOM 粘性标记

每个 scope 记一份 `oomKills` 基线。采样值上升时：

```
[vibeterm][window-memory] oom_kill device=<id> window=<@id> pane=<%id> scope=<scope> kills=<n> current=<bytes> high=<bytes> max=<bytes>
```

同时把标记写入 `gateway_kv` 键 `windowMemory.oomMarks`（JSON map，键 `"<deviceId>/<windowId>"`，值 `{ scope, oomKills, firstAt, lastAt }`）。窗口上有行则 `oomFlag = true`。采样发现窗口已不在 snapshot 里时删掉该行（关窗后的下一次 tick 会走到这里）。标记跨网关重启仍在，这是「粘性」的意义。没有单独的 SQL 表。

宿主判定为不支持时打一行 `console.info`：

```
[vibeterm][window-memory] unsupported device=<id>
```

结果缓存到这次连接结束。

### 设置（每网关 / 节点一份）

存在 `gateway_kv` 键 `windowMemory.settings`，JSON：

| 字段 | 默认 | 含义 |
| --- | ---: | --- |
| `enabled` | `true` | 总开关；`false` 时不采样、不套限额 |
| `memoryHighMb` | `8192` | `MemoryHigh`，软限额 |
| `memoryMaxMb` | `12288` | `MemoryMax`，硬限额 |
| `memorySwapMaxMb` | `4096` | `MemorySwapMax` |
| `sampleIntervalSec` | `5` | 采样周期，2–60 |

校验：整数；MB 范围 `0…1048576`；`memoryHighMb` 与 `memoryMaxMb` 都非 0 时前者不得大于后者。无环境变量覆盖。

HTTP（与其它设置路由同一套管理会话鉴权；可走 `/n/<nodeId>/` 前缀）：

- `GET /api/settings/window-memory` → 整条记录。
- `PUT /api/settings/window-memory` → body 必须是完整五字段；失败 `400`，`{ code, error: { code, message } }`，`code` 为 `INVALID_WINDOW_MEMORY_SETTINGS`。成功后立刻 `tick` 一遍已连接设备。不广播 `SETTINGS_UPDATE`；采样器每个 tick 调 `getSettings()`，限额变了就对已管理的 scope 再 `set-property`。

CLI 快照（不打宿主，读采样缓存）：

- `GET /api/sessions/memory` → `{ devices: [{ deviceId, deviceName, supported, windows: [{ windowId, windowName, panes, scopes, current, high, max, swapMax, oomKills, oomFlag, sampledAt }] }] }`。未打开的设备连接为 `supported: false, windows: []`。

## GUI

### 终端页右上角徽标

`data-testid="window-memory-badge"`，紧挨延迟徽标（`DevicePage` 的 `PageActions`，`DeviceNodeBadges` 后面）。文案是当前窗口的 `current`（`formatBytes`，如 `1.2 GB`）。没有该窗口的样本（宿主不支持、功能关闭、超过 90 s 没收到帧）整块不渲染。

颜色（`data-tone`）：

| 条件 | tone |
| --- | --- |
| `high == 0`，或 `current < 75% high`，且没有 OOM 标记 | `ok` |
| `current ≥ 75% high` | `warn`（琥珀） |
| `current ≥ high`，或 `oomFlag` | `blocked`（红，`border-destructive/40 text-destructive`） |

`oomFlag` 时再加红点 `window-memory-oom-dot`，即使当前用量已经掉下来也保持红色。浮层列出当前用量 / 软限额 / 硬限额 / 交换限额（`0` 显示 `∞`）以及「OOM 已杀 N 次」。

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

## CLI

```bash
vibeterm sessions [--node <node>] [--memory] [--json]
vibeterm settings memory get
vibeterm settings memory set [--enabled on|off] [--high <MB>] [--max <MB>] [--swap-max <MB>] [--interval <sec>]
```

- `sessions`：`GET /api/sessions/memory`。人读表列为 `DEVICE`、`WINDOW`（`@id name`）、`PANES`；`--memory` 再加 `SCOPE`（第一个 scope，多个时 `+N`，没有为 `-`）、`MEM`（当前用量）、`HIGH` / `MAX`（`0` 为 `∞`）、`OOM`（次数；`oomFlag` 时后缀 `!`）。`supported: false` 的设备在 `--memory` 模式下于其行后打印 `(memory limits unsupported on this host)`。非 TTY 默认 JSON（与 `exec` 相同）。`--json` 原样打网关 payload。
- `settings memory`：`GET/PUT /api/settings/window-memory`。`set` 先 GET 再按旗标合并后整包 PUT；非法整数 / 越界 / `high > max` 为用法错误（退出码 2）。尊重全局 `--node`。人读为 `key  value` 行。

用法细节见 [命令行使用手册](./cli-usage.md)。

## 宿主不支持时

下列任一成立，该**设备**静默不启用（其它设备不受影响）：

- 非 Linux（含 macOS / Windows）
- 没有 cgroup v2（`/sys/fs/cgroup/cgroup.controllers` 不存在）
- `systemctl --user show-environment` 失败（没有用户级 systemd 会话）
- pane 不在 `tmux-spawn-*.scope` 里（tmux 低于 3.6 或未编 systemd 支持）

判定结果缓存到这次设备连接结束。GUI 徽标不出现；`sessions --memory` 打出 unsupported 提示。连接时打一行 info 日志，见上文。

## 注意事项

- `set-property --runtime` 不持久，scope 随 pane 消亡；不要指望重启后属性还在 unit 文件里。
- **`MemoryHigh`（软限额）**：内核开始回收 / 限速该 cgroup 的内存页，**不杀进程**。徽标在 ≥ 75% 时变黄，就是在逼近这一档。
- **`MemoryMax`（硬限额）**：用量越过上限后由内核 OOM 杀掉 pane 内进程。配合 [tmux 进程存活](./tmux-process-survival.md) 里的 `DefaultOOMPolicy=continue`：被杀的是超限进程，systemd **不会**因此拆掉整个 scope、把还活着的 shell 一起停掉。没有 `continue` 时，一次 OOM 仍可能让整窗消失。
- SSH 设备上的脚本在**远端**跑，限额套的是远端 pane 的 scope，不是跑网关的那台机器。
- 需要用户级 systemd 会话：该 Unix 用户得能 `systemctl --user`。未登录且未 `loginctl enable-linger` 时，采样脚本会把该设备判为不支持。
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

网关侧搜 `[vibeterm][window-memory]`（套限额失败、oom_kill、unsupported）和 `[tmux] stop-scope`（关窗前 stop）。

## 验收清单

- [ ] Linux + tmux ≥ 3.6 + 用户级 systemd 的本地设备：新建窗口后 `systemctl --user show <scope> -p MemoryHigh,MemoryMax` 与设置一致。
- [ ] 三个 MB 都填 `0`：采样仍在（CLI `sessions --memory` 有读数），`MemoryHigh`/`MemoryMax` 不再被写入。
- [ ] `enabled` 关掉：不再套限额、徽标消失、`sessions --memory` 无新样本。
- [ ] 关窗后对应 `tmux-spawn-*.scope` 消失，失控子进程不再留在后台。
- [ ] 终端页当前窗口有样本时出现 `window-memory-badge`；用量过软限额 75% 变黄，过软限额或有 OOM 标记变红。
- [ ] 设置页 `local-machine-memory` 保存后 `GET /api/settings/window-memory` 与表单一致；非法输入（`high > max`、非整数）拒绝且不写库。
- [ ] `vibeterm sessions --memory` 与 GUI 徽标同一窗口的 `MEM` / `HIGH` / `MAX` / `OOM` 对得上；`--json` 为网关原样。
- [ ] macOS 或无 systemd 的设备：无徽标、连接日志一行 `unsupported`、CLI 提示 unsupported，其它功能不受影响。
- [ ] SSH 设备：限额出现在远端 `systemctl --user show`，不出现在跑网关的那台机器上。
