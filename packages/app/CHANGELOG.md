# 1.1.34

_2026-09-06_

## English

### New

- Terminal sharing: share a terminal tab with a link. Click the share icon on the terminal toolbar, pick a duration (1 h / 24 h / 7 days / permanent / custom) and a password (an 8-character one is generated, or set your own), and copy the link. Whoever opens it enters the password and sees only that tab — no node names, other tabs, files or settings — and can type into it. Splits inside the shared tab stay in sync. Sharing works whether you reach the node directly or through a hub.
- Settings › Share: see active shares with live viewer counts, stop a share at any time (viewers are disconnected immediately), review the history, and replay what happened in a shared tab on a timeline. Recording can be turned off, and the retention period, size cap and default share address are configurable.
- Upgrades now show download progress in bytes, and a slow-but-progressing download is no longer reported as unconfirmed.

### Improvements

- Nodes appear in the sidebar immediately when the app opens: the node list is cached for the first frame, node headers no longer wait for each node's device list, sessions are restored silently, and a flaky first request is retried instead of leaving the sidebar empty for minutes.
- Remote nodes connect faster: the app no longer waits up to 15 seconds for a direct link before trying the secure or relayed path, and a brief hub outage no longer marks every node offline.
- Connection details: the "why not direct" reasons, ICE states and candidate types are now translated instead of showing raw English diagnostics.

### Fixes

- Linux nodes: a tmux window could vanish together with everything running in it when the kernel OOM killer hit one process inside the pane — systemd then stopped the whole pane. Installing or upgrading now sets the user manager's OOM policy to `continue`, so only the offending process is killed and the tab stays. The gateway also logs every window close with its cause.
- Keystrokes typed while a terminal was disconnected are no longer replayed minutes later once the link recovers; input older than 10 seconds is discarded and a short notice is shown.
- The focus-shield window tmex briefly creates when attaching to tmux no longer flashes in the sidebar or steals the active window.
- A listener leak in the hub uplink that grew with every reconnect attempt.

---

## 中文

### 新增

- 终端分享：用链接把一个终端 tab 分享给他人。点击终端工具栏的分享图标，选择期限（1 小时 / 24 小时 / 7 天 / 永久 / 自定义）与口令（默认生成 8 位，也可自定），复制链接即可。对方输入口令后只能看到这一个 tab——看不到节点名、其他 tab、文件与设置——并可以直接操作；tab 内的分屏同步可见。直连节点或经 Hub 访问均可分享。
- 设置 › 分享：查看进行中的分享与实时在线人数，随时终止（对方连接立即断开），浏览分享历史，并在模拟终端里按时间轴回放被分享 tab 里发生的一切。可关闭记录，保留期限、大小上限与默认分享地址均可配置。
- 升级时显示下载字节进度，慢但仍在下载的过程不再被误判为未确认。

### 改进

- 打开应用即显示节点：节点列表首帧走本地缓存，节点标题不再等待各节点的设备列表，会话静默恢复，首次请求失败会自动重试，不再出现侧栏空白数分钟的情况。
- 远端节点连接更快：不再为等待直连白等最多 15 秒才回落到安全通道或中继，Hub 短暂掉线也不再把所有节点标记为离线。
- 连接详情：「未直连原因」、ICE 状态与候选类型已翻译，不再显示英文原始诊断信息。

### 修复

- Linux 节点：pane 内某个进程被内核 OOM 杀掉时，systemd 会把整个 pane 一起停掉，导致 tmux 窗口连同里面的程序一起消失。安装或升级时现在会把用户管理器的 OOM 策略设为 `continue`，只终止超限的那个进程，tab 得以保留；网关也会记录每次窗口关闭及其原因。
- 终端断线期间输入的按键不再在链路恢复后迟到重放；超过 10 秒的输入会被丢弃并给出提示。
- tmex 附加到 tmux 时短暂创建的焦点盾窗口不再在侧栏闪现或抢占活动窗口。
- Hub 上行链路每次重连尝试都会累积一个监听器的泄漏。

---
