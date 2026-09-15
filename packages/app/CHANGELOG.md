# 2.7.0

_2026-09-15_

## English

### New

- Per-window memory limits (Linux): on hosts where tmux 3.6+ runs each pane in its own systemd scope, VibeTerm now applies `MemoryHigh` / `MemoryMax` / `MemorySwapMax` to every new window (defaults 8 GB / 12 GB / 4 GB swap, adjustable under Settings → Nodes → This machine → Memory limits, or with `vibeterm settings memory set`). A runaway build or dev server can no longer take the whole machine down; the kernel throttles it at the soft limit and kills only that process at the hard limit. Closing a window now stops its whole scope first, so nothing survives in the background. macOS and hosts without systemd are unaffected.
- Memory badge: the top-right corner of the terminal page (next to the latency badge) shows the current window's memory use — amber above 75 % of the soft limit, red above it or after an out-of-memory kill. The tooltip lists the limits; the OOM marker is remembered until the window is closed and every kill is written to the service log.
- `vibeterm sessions [--memory]`: lists every device's windows and, with `--memory`, the systemd scope, current usage, limits and OOM count per window.
- CLI parity with the web UI: `vibeterm nodes relay password` (view / change the relay join password), quota lines in `vibeterm nodes relay ls`, `vibeterm share log --all` and `vibeterm share replay` (play a recording in your terminal), `vibeterm tmux style` and `vibeterm tmux stack`.

### Improvements

- Terminal toolbar: Refresh page, Switch input mode, Share and Watch rules now live in a single "More" (⋯) menu, freeing space on narrow screens; an indicator on the button shows when a share or watch rule is active.
- Closing the window you are looking at (from the sidebar) now switches to the next window instead of jumping to the device list, and on phones the sidebar stays open.

---

## 中文

### 新增

- 按窗口限制内存（Linux）：在 tmux 3.6+ 把每个 pane 放进独立 systemd scope 的主机上，VibeTerm 会给每个新窗口设置 `MemoryHigh` / `MemoryMax` / `MemorySwapMax`（默认 8 GB / 12 GB / 4 GB 交换，可在「设置 → 节点 → 本机 → 内存限额」或用 `vibeterm settings memory set` 调整）。失控的构建或开发服务器不会再拖垮整机：到软限内核限速，到硬限只杀该进程。关闭窗口前会先停止整个 scope，不再有进程残留在后台。macOS 与没有 systemd 的主机不受影响。
- 内存徽标：终端页右上角（延迟徽标旁）显示当前窗口的内存用量，超过软限 75 % 变黄，超过软限或发生过 OOM 击杀变红；悬停可见各项限额。OOM 标记会一直保留到窗口关闭，每次击杀都会写入服务日志。
- `vibeterm sessions [--memory]`：列出各设备的窗口，加 `--memory` 时显示每个窗口的 systemd scope、当前用量、限额与 OOM 次数。
- CLI 补齐网页已有的能力：`vibeterm nodes relay password`（查看 / 修改中继接入密码）、`vibeterm nodes relay ls` 显示配额、`vibeterm share log --all` 与 `vibeterm share replay`（在终端里回放录像）、`vibeterm tmux style` / `vibeterm tmux stack`。

### 改进

- 终端工具栏：刷新页面、切换输入方式、分享、监控规则折叠进右上角的「更多」（⋯）菜单，窄屏更省空间；有分享或监控规则生效时按钮上会有指示点。
- 在侧栏关闭正在查看的窗口时，现在会切到下一个窗口而不是跳回设备列表；手机上侧栏保持打开。
