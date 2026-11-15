# tmux 进程存活：服务 kill 策略、linger 与 systemd OOMPolicy

本文说明 VibeTerm 崩溃 / 重启 / 被 OOM 波及时，业务 tmux 会话为什么会（或不会）跟着消失，tmux server 与 pane 各自落在哪个 cgroup，以及安装程序做了什么、用户还要做什么；面向 Linux / macOS 运维。

VibeTerm 沿用 tmux 的哲学：只要业务 tmux 会话还在、用户随时能 attach，VibeTerm 进程本身的崩溃或重启就不应该带走这些会话。`tmux new-session -d` 已让会话以 daemon 形式脱离 VibeTerm 的控制终端，但进程是否真正存活最终由服务管理器的 kill 策略与 systemd 的 OOM 策略决定。

## 1. 服务单元的 kill 范围

服务定义模板按平台分别放宽 kill 范围，使其只针对 VibeTerm 主进程：

- **Linux（systemd 用户单元）**：`[Service]` 段 `KillMode=process`。systemd 在 stop/restart 以及进程异常退出（crash 触发 `Restart=always`）时，只向 MainPID 发送终止信号，不对整个 unit cgroup 广播。
- **macOS（launchd）**：plist `AbandonProcessGroup=true`。launchd 终止 job 时只终止主进程，放弃对进程组的连带处理。

覆盖 stop、restart 与 crash 重启，即由服务管理器主动终止 VibeTerm 主进程的所有路径。程序内自升级也依赖这一策略：detached 的升级子进程在服务被停时仍存活（见 [自更新](./self-update.md)）。

服务定义只在安装或升级时重新渲染落盘，已运行的实例不会热更新；**携带服务定义修复的那一次升级，其自身的 stop/restart 仍按旧策略执行**，会掉一次 tmux。Windows 不安装服务（`detectServiceManager` 返回 `none`），不适用。

## 2. linger（Linux）

`KillMode=process` 只约束 per-unit 的 kill 行为，约束不了 user slice 级别的清理。用户级 systemd 默认 `KillUserProcesses=yes`，用户 logout 或系统 reboot 时整个 user slice 被拆除，无视任何 per-unit 的 `KillMode`。要让会话跨 logout 存活，需启用 linger。这同时决定 VibeTerm 服务本身：未启用时，最后一个 SSH / 登录会话退出约 10 秒后用户管理器停止，服务随之下线，直到下次登录才恢复。

`vibeterm init` 与 `vibeterm upgrade` 在 systemd 用户服务且开启自启时默认为当前用户启用 linger：先 `loginctl show-user <user> -p Linger`，不是 `Linger=yes` 再执行 `loginctl enable-linger <user>`（标准 polkit 下用户可为自己启用，无需 root）。每次升级重装 unit 都会复查，所以存量节点升级一次即补齐。

失败（无 polkit 授权、没有 `loginctl`）只告警，不中断安装，按提示手工执行：

```
sudo loginctl enable-linger <user>
```

不希望改动账户级配置时在 `init` / `upgrade` 加 `--no-linger`，选择写入 `install-meta.json` 的 `linger: false`，后续升级不再检查。已启用的 linger 不会被自动撤销，需要时手工 `sudo loginctl disable-linger <user>`。`--autostart false` 与 macOS 同样跳过此步。

## 3. tmux 3.6 的 pane scope 与 systemd OOMPolicy（Linux）

现象：远端节点上跑着 claude / codex 的 tab「经常被自动关闭」，窗口连同进程一起消失，而 VibeTerm 未发送过 CLOSE_WINDOW / CLOSE_PANE，tmux 服务器也未重启。真因在节点操作系统层：

- tmux ≥ 3.6（Ubuntu 打包带 systemd 支持）为**每个 pane** 创建独立的 systemd 用户 scope：`app.slice/tmux-spawn-<uuid>.scope`，pane 内的 shell 及其全部子进程都在这个 scope 里。
- 内核 OOM killer 杀掉 scope 里的任意一个进程（例如 claude 启动的 `tsgo` / `tsc` / `next dev`，峰值 10–19 GB）时，systemd 按默认 `OOMPolicy=stop` 处理：**停止整个 scope**——向 pane 内所有进程发 SIGTERM，超时后 SIGKILL。日志形如：

  ```
  tmux-spawn-….scope: The kernel OOM killer killed some processes in this unit.
  tmux-spawn-….scope: Stopping timed out. Killing.
  tmux-spawn-….scope: Failed with result 'oom-kill'.
  ```

- shell 退出后 tmux 默认 `remain-on-exit off`，窗口被销毁。VibeTerm 只是观察到 `%window-close`。

### 取证（节点上只读）

```bash
journalctl --user --since '7 days ago' -o short-iso | grep tmux-spawn      # 每个 pane 的启停、峰值内存、oom-kill
journalctl -k --since '7 days ago' | grep -E 'Out of memory|invoked oom-killer'
tmux list-panes -a -F '#{pane_id} #{pane_pid}'; cat /proc/<pane_pid>/cgroup  # 确认 pane 在 tmux-spawn scope 内
```

`free -m` 的即时值不能说明问题：OOM 由瞬时峰值触发，峰值过后内存立刻释放。网关对每次 `%window-close` 与自身发出的 kill-window / kill-pane 打带原因的日志，便于区分「用户关闭」「进程退出」「VibeTerm 操作」。

### VibeTerm 的自动处理

Linux 上安装/升级托管服务（渲染 `~/.config/systemd/user/<服务名>.service` 的那条路径）时，VibeTerm 会一并写入：

```
~/.config/systemd/user.conf.d/vibeterm-oom.conf
[Manager]
DefaultOOMPolicy=continue
```

随后执行 `systemctl --user daemon-reexec`（失败退回 `daemon-reload`）。规则：

- **幂等**：内容逐字节相同就跳过，不重写、不重载。
- **尊重用户配置**：`~/.config/systemd/user.conf` 或 `user.conf.d/` 下任一 drop-in 已显式写过 `DefaultOOMPolicy=`（注释行不算）时完全跳过，只打一行日志。
- **不阻断安装**：写文件或重载失败一律降级为告警日志，安装/升级照常完成。
- **卸载**：`vibeterm uninstall` 只在该文件与 VibeTerm 写出的内容逐字节相同时删除；用户改过就保留。

实现见 `packages/app/src/lib/systemd-oom-policy.ts`，接入点在 `packages/app/src/lib/service.ts` 的 systemd 分支（macOS/launchd 不涉及）。

网关启动时另有只读自检（`packages/app/src/runtime/service-selfcheck.ts`）：Linux 上 `systemctl --user show -p DefaultOOMPolicy` 为 `stop` 且 `tmux -V` ≥ 3.6（解析不出版本时按可能受影响处理）就打一行告警，提示跑 `vibeterm upgrade`。覆盖未升级或手工部署的机器。

### 需要用户自己做的

1. 手工部署或未升级的机器手工写一次（新建的 pane 生效，`daemon-reexec` 后现存 scope 也会变为 `continue`）：

   ```bash
   mkdir -p ~/.config/systemd/user.conf.d
   printf '[Manager]\nDefaultOOMPolicy=continue\n' > ~/.config/systemd/user.conf.d/oom.conf
   systemctl --user daemon-reexec
   ```

2. 限制大内存子进程：`NODE_OPTIONS=--max-old-space-size=4096` 之类，或减少并行任务 / 加内存。

验证：

```bash
systemctl --user show -p DefaultOOMPolicy          # DefaultOOMPolicy=continue
systemctl --user show 'tmux-spawn-*.scope' -p OOMPolicy
```

### 可选后续

VibeTerm 为自己创建的会话开启 `remain-on-exit on`，并在 UI 上把 `pane_dead` 的 pane 显示为「进程已退出」并提供重开 / 关闭，让窗口不再无声消失。属产品决策，未实施。

### 与窗口内存限额的关系

`DefaultOOMPolicy=continue` 只决定「内核杀了 cgroup 里某个进程之后，systemd 要不要把整个 pane scope（`tmux-spawn-*.scope`，或被归位后的 `vibeterm-pane-*.scope`，见第 5 节）停掉」。它不限制进程能吃多少内存。VibeTerm 另外通过 `systemctl --user set-property --runtime … MemoryHigh/MemoryMax/MemorySwapMax` 给每个 pane scope 套上限：软限额触发回收 / 限速，硬限额才由内核 OOM 杀超限进程。关窗前会先 `systemctl --user stop` 该 scope。宿主没有 pane scope（tmux < 3.6 等）时限额不生效，读数改按进程树 RSS 统计。完整说明（设置项、GUI 徽标、远程/批量设限、`vibeterm sessions --memory` 与排障命令）见 [窗口内存](./window-memory-limits.md)。

## 4. 套接字不可达：server 还活着，新命令却连不上

现象：某台节点上终端一切正常（输出、输入、历史都在），但每次进入该节点都弹「连接失败：error connecting to /tmp/tmux-1000/default (No such file or directory)」，节点日志里同一条 `[local] tmux command failed … argv=resize-window/select-window` 反复出现。

真因在节点的挂载或 `/tmp` 清理，不在 VibeTerm：tmux server 启动时在 `/tmp/tmux-<uid>/default` 建套接字，之后 `/tmp` 被新的挂载遮蔽（如把 `/data/tmp/system` bind 到 `/tmp`）或该目录被清理，套接字文件就留在了被遮蔽的旧文件系统上。此时：

- **已挂上的控制模式 client 照常工作**——它握的是打开着的 fd，与路径无关，所以终端看起来完全正常；
- **新起的一次性 tmux 命令**（`resize-window`、`select-window` 等）按路径去连，连不到，逐条失败。

`ss -xlp | grep tmux` 仍能看到 server 在原路径 LISTEN，但 `ls /tmp/tmux-1000/` 里没有它——这正是判据。

### VibeTerm 的自动处理

网关把这类失败与「server 真的没了」分开（`isTmuxSocketMissingMessage`，见 `apps/gateway/src/tmux-client/external/helpers.ts`），并按 tmux(1) 的规定恢复（`socket-recovery.ts`）：

1. 经**已挂着的控制模式通道**取 server pid（此刻起不了新 tmux，只能走这条路）；
2. 按 0700 补出套接字的父目录——tmux(1) 明说父目录缺失时 SIGUSR1 会失败；
3. 向 server 发 `SIGUSR1`，tmux 据此重建套接字；
4. 轮询确认可连（100 ms 一次，最多 1.5 s），成功则把失败的那条命令原样重试一次。

限制：每条连接 30 s 内至多尝试一次；恢复不了就退回原来的失败上报。socket 不可达**绝不**会被当成 server gone 去拆会话。

命令重新跑通后，网关清掉设备上滞留的 `lastError` 并广播 `reconnected`，前端据此撤下错误提示——此前 `lastError` 只在重连成功时才清，而这类故障下连接从不断开，错误会一直挂着。

控制通道「慢」与「死」分开处理（`control-mode-capture.ts`、`control-stall-detector.ts`）：

- 单条命令超时从它到达 FIFO 队头（tmux 开始处理）起算，基准本机 10 s / SSH 30 s，并随宿主一跳 EWMA 放大为 `clamp(max(基准, 8 × EWMA), 基准, 60 s)`；另有自入队起 4 倍的硬上限。超时只拒绝该命令的调用方，迟到的 `%end` 按 orphan / command-number 对齐丢弃，不毒化队列。
- 只有「有命令在途且控制流（任何 stdout 字节、命令块、`%output`、通知）整窗无进展」才判卡死：本机 45 s、SSH 60 s。本机还会读 `/proc/<tmux server pid>/stat`（pid 在首次超时时学习）：进程仍在运行 / 睡眠 / D 态视为慢，再宽限一窗，最多 3 次；已停止（`T`/`t`）、僵尸或不存在视为死，立即拆通道。非 Linux 不做这一检查。
- 心跳（30 s 无任何控制流活动才发，不毒化队列）同样只在整窗无进展时杀控制进程 / 关 SSH 通道。
- 状态跃迁经 `onControlHealth` 上报 `slow` / `stalled` / `recovered`，每次事故日志各一条：`[tmux] control channel slow device=… head_age_ms=… last_activity_ms=…`、`[tmux] control channel recovered device=… slow_ms=…`。

控制通道在宿主过载下变慢（`tmux control command timed out` 等）时，网关把错误归为 `tmux_busy`，而不是 SSH 的 `timeout` / `unknown`。单次慢命令不告警；慢状态持续 ≥15 s 或通道 `stalled` 才落库并广播。控制通道 `recovered`、控制客户端重挂成功、或随后快照/命令成功时，只清 `tmux_busy`（及历史上被标成 `unknown` 的同类控制通道文案），并广播 `reconnected`；不会用控制通道恢复掩盖 SSH / 认证失败。

### 需要用户自己做的

自动恢复只治标。挂载被换掉是运维动作，要么在起 tmux 前把 `/tmp` 的挂载定下来（fstab 里的 bind 在 `local-fs.target` 前完成，重启后即正常），要么别在 tmux server 运行期间重挂 `/tmp`。排查用：

```bash
findmnt /tmp                      # 同一挂载点上是否叠了两层
ss -xlp | grep tmux               # server 仍在哪个路径 LISTEN
ls -la /tmp/tmux-$(id -u)/        # 当前可见的 /tmp 里有没有那个套接字
```

## 5. 进程归属与 cgroup（Linux）

背景：宿主常在 `app.slice` 上设 `memory.high`。tmux 3.6 把每个 pane 放进 `tmux-spawn-<uuid>.scope`，且与 tmux server **同一个 slice**。server 若也在 `app.slice`，就会和编译、agent 等重负载一起被限速，控制命令超时，网页终端卡顿，而 SSH 登录（`session-N.scope`）照常流畅。

目标：网关与 tmux server 在受保护的 slice，pane 负载留在 workload slice，宿主限额只压负载。

| 进程 | 位置 |
|---|---|
| 网关 `vibeterm.service` | 单元写 `Slice=session.slice`（安装 / 升级时渲染；未改 CPUWeight / IOWeight / Nice） |
| tmux server | 原在 workload slice 的某个 `.scope` 里时，搬进受保护 slice 的 `vibeterm-tmux-<socket 路径哈希>.scope` |
| pane 进程树 | 落在受保护 slice 的 `tmux-spawn-*.scope` 时，整组 pid 搬进 workload slice 的 `vibeterm-pane-<uuid>.scope` |

实现见 `apps/gateway/src/tmux/cgroup-placement.ts`：经用户管理器 D-Bus（`busctl --user call … StartTransientUnit`，`PIDs` 属性，`CollectMode=inactive-or-failed`，`Delegate=true`）搬迁现有进程，不重启进程，`pane_pid`、子进程与进程树不变；被搬空的 `tmux-spawn` scope 由 systemd 回收。`StartTransientUnit` 只是排队一个 job，网关每 50 ms 查一次 `/proc/<pid>/cgroup`，最多 1.5 s，确认进程已进新 unit 后再读一次旧 scope 的 `cgroup.procs`，把仍留在旧 scope 的进程（期间新 fork 的）用 `AttachProcessesToUnit` 补进去。`AttachProcessesToUnit` 只接受 delegated unit，所以两类 scope 都带 `Delegate=true`；对 pane scope 的 `set-property MemoryHigh/MemoryMax` 不受影响。只搬当前 uid 的进程。

时机：本机设备每次连上会话后保护 server 并把该 server 上已有的 pane（`list-panes -a`）归位一次；之后网关新建窗口 / 分屏、以及快照里出现新 pane 时逐个归位。其他客户端在**别的会话**里新建的 pane 要等下次连接才归位。归位后窗口内存采样改读 `vibeterm-pane-*.scope`，限额、stop 与孤儿清扫都跟着新 scope 走（scope 的 Description 沿用 tmux 的 `launched by process <server pid>` 格式）。

环境变量（写进 `app.env`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIBETERM_CGROUP_PLACEMENT` | `auto` | `off` 关闭；`NODE_ENV=test` 时默认 `off` |
| `VIBETERM_PROTECTED_SLICE` | `session.slice` | tmux server 的目标 slice |
| `VIBETERM_WORKLOAD_SLICE` | `app.slice` | pane 的目标 slice，也是「需要保护」的判据 |

slice 名必须以 `.slice` 结尾且不含 `/`，否则回退默认值并打 warn。

注意：

- **已在运行的 server**：升级后网关重启（`KillMode=process` 不杀 tmux），下次连接时按上表搬迁，无需重启 tmux。
- **server 在别人的 `.service` 里**（例如旧版单元下由网关拉起、仍挂在 `app.slice/vibeterm.service`）：不搬，否则 systemd 会认为该服务的进程变动；只打一行 info，建议让该服务以 `Slice=session.slice` 运行。VibeTerm 自己的单元升级后即满足，重启 tmux server 后生效。
- **不生效的平台**：SSH 设备、macOS、Windows、无 cgroup v2、无 `busctl`、用户管理器不可达、网关不在 `user@<uid>.service` 下（如从 SSH 会话直接起的开发实例），全部 no-op。
- 宿主若把 `memory.high` 设在 `user.slice` 上，`session.slice` 一样受限，不在本机制范围内。

排查：每次连接打一行 `[tmux] placement server_cgroup=… panes_slice=… mode=auto|off|unsupported:<原因>`；`/healthz` 的 `tmux.placement` 给出模式与已搬迁的 server / pane 计数（不含路径）。

```bash
cat /proc/$(tmux display-message -p '#{pid}')/cgroup     # server 所在 cgroup
systemctl --user list-units 'vibeterm-*.scope' --all       # 归位产生的 scope
```
