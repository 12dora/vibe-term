# 2.15.1

_2026-11-15_

## English

### Responsiveness under heavy load

- **No more false "connection failed".** When the host is busy, a slow tmux is no longer treated as a lost connection. The device shows **Host busy** instead and the badge clears by itself once the host catches up. The connection is only rebuilt when tmux has stopped responding entirely.
- **The web terminal stays responsive when the host is loaded.** On Linux with a systemd user session, VibeTerm moves the tmux server into the protected `session.slice` and keeps the programs running in your panes in `app.slice`, so memory or CPU limits on your workloads no longer stall the terminal itself. The service unit now runs in `session.slice` too. Set `VIBETERM_CGROUP_PLACEMENT=off` to disable.
- Fewer tmux processes per screen refresh, and keystrokes queued during a slowdown are sent together.

### Terminal

- **No more stray text such as `35;1;2M` in the shell.** Mouse reports are only sent to programs that asked for them, including after a program exits or crashes without turning mouse tracking off, and while the terminal is reconnecting.

### Security

- **Session keys protect sign-ins.** New sign-ins from the browser and from `vibeterm login` sign every request with a key that never leaves the device, so a copied session cookie or `session.json` entry is not enough to use the session. Existing sessions keep working until they expire. Treat `~/.config/vibeterm/session.json` like a private key.
- **Shared terminal passwords:** wrong guesses now slow down only the address that made them; visitors who have not failed are not affected by other people's guesses.
- **Reverse proxies on public addresses:** list them in `VIBETERM_TRUSTED_PROXY_CIDRS` to trust their forwarded headers.
- **Join codes** created before a node was removed now report that the code is no longer valid and ask you to generate a new one.
- **cloudflared** is installed at a fixed version and verified before every start.

---

## 中文

### 高负载下的响应

- **不再误报「连接失败」**：主机繁忙时，tmux 响应变慢不再被当成断线，设备显示「主机繁忙」，主机恢复后自动消失；只有 tmux 完全停止响应时才会重建连接。
- **主机负载高时网页终端保持流畅**：在使用 systemd 用户会话的 Linux 上，VibeTerm 会把 tmux 服务端移入受保护的 `session.slice`，窗格里运行的程序留在 `app.slice`，针对工作负载的内存或 CPU 限制不再拖慢终端本身；服务单元也改为运行在 `session.slice`。设置 `VIBETERM_CGROUP_PLACEMENT=off` 可关闭。
- 每次界面刷新调用的 tmux 进程更少，变慢期间排队的按键合并发送。

### 终端

- **shell 里不再出现 `35;1;2M` 之类的残留字符**：鼠标事件只发给请求了鼠标模式的程序；程序退出或崩溃后未关闭鼠标模式、以及终端重连期间同样适用。

### 安全

- **会话密钥保护登录**：浏览器与 `vibeterm login` 的新登录会用不离开本机的密钥为每个请求签名，仅复制会话 cookie 或 `session.json` 中的会话无法使用。已有会话在到期前照常可用。请像对待私钥一样保管 `~/.config/vibeterm/session.json`。
- **终端分享口令**：猜错只会让该来源变慢，没有猜错记录的访客不受他人影响。
- **公网地址上的反向代理**：在 `VIBETERM_TRUSTED_PROXY_CIDRS` 中列出后，才会信任其转发头。
- **加入码**：在移除节点之前生成的加入码，现在会提示已失效并要求重新生成。
- **cloudflared** 安装固定版本，每次启动前校验完整性。
