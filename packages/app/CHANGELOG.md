# 2.16.0

_2026-11-16_

## English

### Alpine Linux and OpenRC

- **Runs on Alpine Linux (musl), x64 and arm64.** Install with `wget -qO- https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | sh`. The installer is now plain POSIX `sh`, works with busybox `wget` when `curl` is missing, and installs the musl build of Bun when needed. Prerequisites on Alpine: `apk add tmux libstdc++ libgcc unzip`.
- **OpenRC service.** On hosts without a systemd user session, `vibeterm init` registers `/etc/init.d/vibeterm` (supervise-daemon, restarts automatically, runs as your user). It asks for sudo once; to allow upgrades and restarts from the web UI it adds a sudoers rule limited to `rc-service vibeterm start|stop|restart|status`. Logs go to `vibeterm.log` in the install directory. On OpenRC, per-window memory limits are not available. Uninstall a non-root OpenRC node from a terminal on that node.
- **Direct connections on musl.** WebRTC direct connections now work on Alpine.

### Lower memory use

- **Idle memory down by about a quarter**, and by about 40% excluding the Bun runtime itself. Features you have not set up (agents, watch rules, tunnels, Telegram/WeChat bots, port mapping, SSH devices, ACME, direct connections) are no longer loaded at startup; they load the first time you use them. A node now fits on a 256 MB machine.
- **No more out-of-memory during install.** Setting up direct connections no longer needs ~270 MB of memory.
- Large terminal output and file transfers use less memory and CPU.

### Fixes

- Services started without `$USER` set (cron, containers) now run under the correct user name.

---

## 中文

### Alpine Linux 与 OpenRC

- **支持 Alpine Linux（musl），x64 与 arm64**：用 `wget -qO- https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | sh` 安装。安装脚本改为标准 POSIX `sh`，没有 `curl` 时使用 busybox `wget`，需要时自动安装 musl 版 Bun。Alpine 需先执行 `apk add tmux libstdc++ libgcc unzip`。
- **OpenRC 服务**：没有 systemd 用户会话的主机上，`vibeterm init` 会注册 `/etc/init.d/vibeterm`（supervise-daemon 守护，异常退出自动拉起，以当前用户身份运行）。安装时需输入一次 sudo 密码；为支持在网页上升级与重启，会写入一条仅允许 `rc-service vibeterm start|stop|restart|status` 的 sudoers 规则。日志位于安装目录下的 `vibeterm.log`。OpenRC 上不支持按窗口限制内存；非 root 安装的 OpenRC 节点需在该节点终端中卸载。
- **musl 支持直连**：Alpine 上可使用 WebRTC 直连。

### 内存占用降低

- **空闲内存降低约四分之一**（不计 Bun 运行时本身约 40%）：未配置的功能（Agent、监控规则、隧道、Telegram / 微信机器人、端口映射、SSH 设备、ACME、直连）不再在启动时加载，首次使用时才加载。节点可在 256 MB 内存的机器上运行。
- **安装不再因内存不足中断**：配置直连时不再需要约 270 MB 内存。
- 终端大量输出与文件传输占用的内存与 CPU 更少。

### 修复

- 在未设置 `$USER` 的环境（cron、容器）中启动时，服务使用正确的用户名运行。
