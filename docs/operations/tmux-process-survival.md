# tmux 进程存活：服务 kill 策略、linger 与 systemd OOMPolicy

本文说明 VibeTerm 崩溃 / 重启 / 被 OOM 波及时，业务 tmux 会话为什么会（或不会）跟着消失，以及安装程序做了什么、用户还要做什么；面向 Linux / macOS 运维。

VibeTerm 沿用 tmux 的哲学：只要业务 tmux 会话还在、用户随时能 attach，VibeTerm 进程本身的崩溃或重启就不应该带走这些会话。`tmux new-session -d` 已让会话以 daemon 形式脱离 VibeTerm 的控制终端，但进程是否真正存活最终由服务管理器的 kill 策略与 systemd 的 OOM 策略决定。

## 1. 服务单元的 kill 范围

服务定义模板按平台分别放宽 kill 范围，使其只针对 VibeTerm 主进程：

- **Linux（systemd 用户单元）**：`[Service]` 段 `KillMode=process`。systemd 在 stop/restart 以及进程异常退出（crash 触发 `Restart=always`）时，只向 MainPID 发送终止信号，不对整个 unit cgroup 广播。
- **macOS（launchd）**：plist `AbandonProcessGroup=true`。launchd 终止 job 时只终止主进程，放弃对进程组的连带处理。

覆盖 stop、restart 与 crash 重启，即由服务管理器主动终止 VibeTerm 主进程的所有路径。程序内自升级也依赖这一策略：detached 的升级子进程在服务被停时仍存活（见 [自更新](./self-update.md)）。

服务定义只在安装或升级时重新渲染落盘，已运行的实例不会热更新；**携带服务定义修复的那一次升级，其自身的 stop/restart 仍按旧策略执行**，会掉一次 tmux。Windows 不安装服务（`detectServiceManager` 返回 `none`），不适用。

## 2. linger（Linux）

`KillMode=process` 只约束 per-unit 的 kill 行为，约束不了 user slice 级别的清理。用户级 systemd 默认 `KillUserProcesses=yes`，用户 logout 或系统 reboot 时整个 user slice 被拆除，无视任何 per-unit 的 `KillMode`。要让会话跨 logout 存活，需用户手动开启 linger：

```
loginctl enable-linger <user>
```

VibeTerm 默认不代为启用 linger：这是账户级配置变更（用户的 systemd 实例常驻、不随登录会话退出而停止），应由用户知情后自行决定。

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
