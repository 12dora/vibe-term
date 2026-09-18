# 2.8.0

_2026-09-18_

## English

### Improvements

- The memory reading in the top-right corner of a terminal now works everywhere. It used to show `0 B` on many machines — not because the window was idle, but because VibeTerm could only read memory through a per-window systemd group that only tmux 3.6 and newer create. On hosts with an older tmux (Ubuntu 24.04 ships 3.4, Debian 12 ships 3.3a) and on macOS, it now adds up the memory of every process in the window instead, so you finally see a real number.
- Hovering the badge tells you which of the two readings you are looking at, and says plainly when the host cannot enforce a per-window memory limit at all — instead of showing an "unlimited" symbol that made it look like you simply had not set one.
- The memory-limit settings now warn you when the limit will not actually take effect, and name the machines it cannot apply to. Enforcing a limit still needs Linux with tmux 3.6 or newer; the reading works regardless.
- A window whose processes have all exited no longer shows a misleading `0 B` — the badge simply goes away.

### Features

- Memory limits can now be managed remotely. In Settings → Nodes, each node's ⋯ menu has a new "Memory limits" entry that edits that machine's limits directly, and the bulk menu in the card header can write one set of limits to every selected node at once, telling you node by node what succeeded and what was skipped (offline, not signed in, paused, or running a version older than 2.7.0).
- `vibeterm sessions --memory` gained a SOURCE column showing where each reading came from, and now says "limits unavailable" only when limits really are unavailable.

---

## 中文

### 改进

- 终端右上角的内存读数现在到处都能用了。过去它在不少机器上一直显示 `0 B`——不是窗口真没占内存，而是 VibeTerm 只会从一种「按窗口划分的 systemd 分组」里取数，而这种分组只有 tmux 3.6 及以上才会建。tmux 版本较老的机器（Ubuntu 24.04 自带 3.4、Debian 12 自带 3.3a）和 macOS 上，现在改成把窗口里所有进程占的内存加起来，终于能看到真实数字。
- 鼠标悬停会说明这个数字是哪种口径，宿主根本无法按窗口限额时也会直说，而不是显示一个「无限制」符号，让人以为只是自己没设。
- 内存限额的设置页会在限额其实不会生效时给出提示，并列出受影响的机器。真正限住内存仍然需要 Linux + tmux 3.6 及以上；读数则不受影响。
- 窗口里的进程全退出后，不会再显示一个容易误解的 `0 B`，徽标直接消失。

### 新增

- 内存限额可以远程管理了。设置 → 节点里，每个节点的 ⋯ 菜单新增「内存限额」，直接改那台机器的限额；卡片右上角的批量菜单可以把同一份限额一次写到所选的多台节点，并逐台告诉你哪台写成功、哪台被跳过（离线、未登录、已暂停，或版本低于 2.7.0）。
- `vibeterm sessions --memory` 新增「来源」列，说明每个读数是怎么来的；「限额不可用」也只在限额真的不可用时才出现。
