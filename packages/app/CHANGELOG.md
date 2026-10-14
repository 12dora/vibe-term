# 2.13.0

_2026-10-14_

## English

### New

- `vibeterm exec` now works like `ssh host cmd`: output goes straight to your terminal or pipe (binary-safe, no size limit), stdin is forwarded automatically, the exit code passes through, and commands run in your login shell with your usual `PATH`. `vibeterm exec node 'cmd'` is enough — no more `--shell --`.
- Long-running commands survive network drops: the connection reconnects on its own and output continues exactly where it stopped. Use `--timeout` only when you want a limit.
- `vibeterm rsh`: an ssh-compatible entry point, so tools that expect ssh just work — `rsync -e 'vibeterm rsh'`, `GIT_SSH_COMMAND='vibeterm rsh'`, `scp -S vibeterm-rsh`. A `vibeterm-rsh` launcher is installed next to `vibeterm`.
- Interactive sessions: `vibeterm exec -t` (or no command at all) opens a real terminal on the remote side, for `sudo` prompts, `top`, `vim` and so on.
- `vibeterm forward -L / -R`: ssh-style port forwarding between this machine and a node. Forwards end when the command exits (and are cleaned up automatically if it is killed); `--persist` keeps them as permanent port mappings.
- Access tokens for scripts and agents: create one with `vibeterm token create` or under Account Security, limit it to remote commands, files or port forwarding, and revoke it at any time. Commands keep working without an interactive login.

### Improvements

- `vibeterm cp` follows scp rules: `node:/absolute/path` and `node:path` (relative to home) are remote, everything else is local, and existing files are overwritten by default.
- `vibeterm nodes ls` shows connection state, last seen time and whether this CLI is signed in to the node in separate columns.
- On Linux, installing or upgrading now keeps the service running after you log out (systemd linger). Use `--no-linger` to opt out.
- `exec` no longer prints "using device …" on every call; add `-v` to see it.

### Fixes

- Offline nodes no longer show "last seen: just now".
- Nodes that only run a relay no longer expose the terminal and remote-command interfaces.

---

## 中文

### 新增

- `vibeterm exec` 用法与 `ssh 主机 命令` 一致：输出原样写到终端或管道（支持二进制、不限大小），标准输入自动转发，退出码原样返回，命令在你的登录 shell 中运行，`PATH` 与平时一致。直接写 `vibeterm exec 节点 '命令'` 即可，不再需要 `--shell --`。
- 长时间运行的命令不再因网络中断而失败：连接自动重连，输出从中断处继续，不丢不重。需要限时时再加 `--timeout`。
- 新增 `vibeterm rsh`：与 ssh 兼容的入口，依赖 ssh 的工具可直接使用，如 `rsync -e 'vibeterm rsh'`、`GIT_SSH_COMMAND='vibeterm rsh'`、`scp -S vibeterm-rsh`。安装时会在 `vibeterm` 旁边一并放置 `vibeterm-rsh` 启动器。
- 交互式会话：`vibeterm exec -t`（或不带命令）在远端分配真实终端，可用于 `sudo` 密码提示、`top`、`vim` 等。
- `vibeterm forward -L / -R`：ssh 风格的端口转发。命令退出时转发随之结束（进程被强制结束也会自动回收）；加 `--persist` 则保留为常驻端口映射。
- 访问令牌：供脚本与代理使用。可用 `vibeterm token create` 或在「账号安全」中创建，按远程命令、文件、端口转发限定权限，随时可撤销。无需交互登录即可执行命令。

### 改进

- `vibeterm cp` 遵循 scp 规则：`节点:/绝对路径` 与 `节点:路径`（相对家目录）为远端，其余为本地；目标已存在时默认覆盖。
- `vibeterm nodes ls` 将连接状态、最后在线时间、本机 CLI 是否已登录该节点分列显示。
- Linux 上安装或升级后，退出登录也不会停止服务（systemd linger）。如不需要，可加 `--no-linger`。
- `exec` 不再每次输出「using device …」，加 `-v` 时显示。

### 修复

- 离线节点不再显示「刚刚在线」。
- 仅运行中继的节点不再对外提供终端与远程命令接口。
