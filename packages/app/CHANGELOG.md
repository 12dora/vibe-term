# 2.4.3

_未发布_

## English

### New

- Share replay uses the same read-only terminal widget as a normal terminal (font, size, line height, theme, copy). You can select and copy text, and pan a large recording instead of clipping the left columns. The scrubber is a tick-marked timeline that shows the real wall-clock time.
- If system DNS is broken (for example leftover VPN split-DNS), hub and relay dials fall back to DNS-over-HTTPS and reconnect by IP while still verifying the certificate against the hostname. Turn off with `VIBETERM_DIAL_DNS_FALLBACK=off`.

### Fixes

- After a relay failover the old primary can come back as a secondary; health probes run before waiting for in-flight streams to drain.
- A site URL that is really a relay / Hub / tunnel / public-IP origin is no longer offered again as a “self-hosted domain” candidate.
- Concurrent upgrade pushes no longer pin a zero package size.

### Changes

- `vibeterm exec` keeps long-silent commands alive, reports why a stream died, and adds `--script` / `--tail` / `--max-bytes` / `--stdout-file` / `--stderr-file`. `whoami` prints one line when you are not logged in; `login` skips unreachable nodes; `--node` no longer falls back to this machine when the device is missing. Session file path: `VIBETERM_SESSION_FILE`.

### Docs

- Architecture and operations docs cover replay, origin candidates, multi-relay failback, DNS fallback, upgrade `.total` pinning, and the follow-up for a short-lived exec token (KI-16).

---

## 中文

### 新增

- 分享回放改用与普通终端同一套只读组件（字体 / 字号 / 行高 / 主题 / 复制方式），可选区复制，大尺寸录像可平移而不再裁掉左侧列。进度条改为带刻度的时间轴，显示真实操作墙钟。
- 系统 DNS 解析失败时（例如 VPN 残留分流 DNS），上联 / 中继拨号改走 DNS over HTTPS，按 IP + SNI 重拨，证书仍按主机名校验。`VIBETERM_DIAL_DNS_FALLBACK=off` 可关。

### 修复

- 故障转移后原主中继能按退避重新挂成副中继；failback 先做健康检查再等在途流排空。
- 站点 URL 若等于中继 / Hub / 隧道 / 公网 IP 的 origin，不再重复出现成「自建域名」候选。
- 并发 ranged 升级推包不会再把包大小钉成 0。

### 变更

- `vibeterm exec` 为长静默命令保活，并报出断流原因；新增 `--script` / `--tail` / `--max-bytes` / `--stdout-file` / `--stderr-file`。`whoami` 未登录只打一行；`login` 跳过不可达节点；给了 `--node` 却匹配不到设备不再回落到本机。会话文件可用 `VIBETERM_SESSION_FILE` 指定。

### 文档

- 架构与运维文档已同步回放、候选地址去重、多中继 failback、DNS 回退、升级 `.total` 钉死，以及尚未实现的短时 exec 令牌（KI-16）。

---

# 2.4.2

_2026-09-14_

## English

### New

- `vibeterm exec`: run a command on any device as an isolated process — argv, working directory, environment and stdin, separate stdout/stderr, real exit code, no shared terminal pane. Works through the mesh for remote nodes.
- `vibeterm system info [--node]`: host facts (OS, CPU, memory, disk, tmux, Docker, deployment, memory profile).
- `vibeterm term run` gains `--stdin` / `@file` (multi-line scripts pasted as one block), `--ephemeral` (runs in a detached tmux window that is closed afterwards), refuses to type into a pane that is busy with another program, and emits JSON automatically when stdout is not a terminal. A bare node name now targets the node's first local device.
- File transfer: local devices no longer need rsync; every node exposes a virtual `home` root (`$HOME`) so `vibeterm cp ./file node:home/path` works without configuring roots; `cp --json` progress includes rate and ETA.
- `whoami` shows a READY column and tells you which node still needs `vibeterm login --node`.

### Improvements

- Much lower idle memory: heavy modules (AI SDK, SSH, messaging bots, TLS/ACME, terminal emulator, hub/relay runtimes) are loaded on first use and the runtime is code-split; a relay-only process no longer starts agent/tunnel/push. Hosts with ≤ 2 GiB (or a cgroup limit) automatically use a `small` memory profile with tighter buffer limits (`VIBETERM_MEMORY_PROFILE` to override).
- Settings on phones: node, tenant and share tables become cards, the local-machine card keeps a two-column layout, long addresses no longer wrap into several lines, and the site URL picker shows selectable address pills instead of full links.
- Port labels read 「UDP 直连 / TURN 中继」; the two TURN port lines are merged into one.

### Fixes

- Pasting more than 64 KiB into a terminal is no longer rejected, and a full input queue no longer marks the device as disconnected.
- Multi-relay selection rows show offline / latency again.

---

## 中文

### 新增

- `vibeterm exec`：在任意设备上以独立进程运行命令——支持 argv、工作目录、环境变量与 stdin，stdout/stderr 分离，返回真实退出码，不占用共享终端窗格；远端节点经多节点互联转发。
- `vibeterm system info [--node]`：查看主机信息（系统、CPU、内存、磁盘、tmux、Docker、部署方式、内存档位）。
- `vibeterm term run` 新增 `--stdin` / `@file`（多行脚本整块粘贴）、`--ephemeral`（在临时的分离 tmux 窗口里运行，结束后关闭）、拒绝往正在运行其它程序的窗格里打字、非终端输出时自动输出 JSON；只写节点名时默认使用该节点的第一台本机设备。
- 文件传输：本机设备不再依赖 rsync；每个节点提供虚拟根 `home`（`$HOME`），`vibeterm cp ./file node:home/path` 无需预先配置根目录；`cp --json` 进度带速率与预计剩余时间。
- `whoami` 增加 READY 列，并提示哪台节点还需要 `vibeterm login --node`。

### 改进

- 空闲内存显著下降：AI SDK、SSH、消息机器人、TLS/ACME、终端模拟器、Hub / 中继运行时改为首次使用时加载，运行时按需分包；纯中继进程不再启动 agent / 隧道 / 推送。内存 ≤ 2 GiB（或受 cgroup 限制）的主机自动使用 `small` 档位收紧缓冲上限（可用 `VIBETERM_MEMORY_PROFILE` 覆盖）。
- 手机上的设置页：节点表、租户表、分享表改为卡片，本机卡保持两列，长地址不再折成多行，站点 URL 候选地址改为可选中的胶囊。
- 端口用途改为「UDP 直连 / TURN 中继」，两行 TURN 端口合并为一行。

### 修复

- 向终端粘贴超过 64 KiB 的内容不再被拒绝，输入队列满也不再把设备标记为断开。
- 多中继选择行重新显示离线 / 延迟。
