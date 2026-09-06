# tmux 窗口无故消失：systemd OOMPolicy 与 tmux 3.6 的 pane scope

> 本文写于产品名为 tmex 时期（2026-09 改名 VibeTerm），历史内容保持原样。

## 背景

用户反馈远端节点 demo-app 上跑着 claude / codex 的 tab「经常被自动关闭」，窗口连同进程一起消失。排查证明 VibeTerm 未发送过 CLOSE_WINDOW / CLOSE_PANE（节点 `[ws-metrics] inbound_kinds` 七天内无 `0204` / `0205`），tmux 服务器也未重启。真因在节点操作系统层。

## 机制

- tmux ≥ 3.6（Ubuntu 打包带 systemd 支持）为**每个 pane** 创建独立的 systemd 用户 scope：`app.slice/tmux-spawn-<uuid>.scope`，pane 内的 shell 及其全部子进程都在这个 scope 里。
- 当内核 OOM killer 杀掉 scope 里的任意一个进程（例如 claude 启动的 `tsgo` / `tsc` / `next dev`，峰值 10–19 GB），systemd 按默认 `OOMPolicy=stop` 处理：**停止整个 scope**——向 pane 内所有进程发 SIGTERM，超时后 SIGKILL。日志形如：

```
tmux-spawn-….scope: The kernel OOM killer killed some processes in this unit.
tmux-spawn-….scope: Stopping timed out. Killing.
tmux-spawn-….scope: Failed with result 'oom-kill'.
```

- shell 退出后 tmux 默认 `remain-on-exit off`，窗口被销毁。表现即「有人关掉了 tab」。VibeTerm 只是观察到 `%window-close`。

## 取证方法（节点上只读）

```bash
journalctl --user --since '7 days ago' -o short-iso | grep tmux-spawn      # 每个 pane 的启停、峰值内存、oom-kill
journalctl -k --since '7 days ago' | grep -E 'Out of memory|invoked oom-killer'
tmux list-panes -a -F '#{pane_id} #{pane_pid}'; cat /proc/<pane_pid>/cgroup  # 确认 pane 在 tmux-spawn scope 内
```

`free -m` 的即时值不能说明问题：OOM 由瞬时峰值触发，峰值过后内存立刻释放。

## 处置

### VibeTerm 自动处理（1.1.34 起）

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

1. 升级到 1.1.34 之前的机器手工写一次（新建的 pane 生效，`daemon-reexec` 后现存 scope 也会变为 `continue`）：

```bash
mkdir -p ~/.config/systemd/user.conf.d
printf '[Manager]\nDefaultOOMPolicy=continue\n' > ~/.config/systemd/user.conf.d/oom.conf
systemctl --user daemon-reexec
```

2. 限制大内存子进程：`NODE_OPTIONS=--max-old-space-size=4096` 之类，或减少并行任务 / 加内存。

排查辅助（1.1.34 起）：网关对每次 `%window-close` 与自身发出的 kill-window / kill-pane 打带原因的日志，便于区分「用户关闭」「进程退出」「VibeTerm 操作」。

验证：

```bash
systemctl --user show -p DefaultOOMPolicy          # DefaultOOMPolicy=continue
systemctl --user show 'tmux-spawn-*.scope' -p OOMPolicy
```

## 可选后续

VibeTerm 为自己创建的会话开启 `remain-on-exit on`，并在 UI 上把 `pane_dead` 的 pane 显示为「进程已退出」并提供重开 / 关闭，让窗口不再无声消失。属产品决策，未实施。
