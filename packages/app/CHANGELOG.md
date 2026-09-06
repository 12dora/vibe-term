# 1.1.36

_2026-09-06_

## English

### New

- **Mesh notifications.** Turn on "Receive Notifications from Other Nodes" under Settings → Notifications and events from every node (bells, watch rules, device alerts) are delivered through this machine's webhooks, Telegram and WeChat bots, and shown as browser toasts on the entry page with the node name and a link to the terminal. Nodes keep a small queue (20 events / 3 minutes, merged per pane) while the sink is unreachable. The Notifications tab now states which machine's channels are being edited, and each node's detail dialog links to its own notification settings.
- **Share password management.** Settings → Share → active shares can show the password, change it (optionally disconnecting all current viewers), and copy a link that carries the password. The share dialog has an "Include the password in the link" option; opening such a link pre-fills the password and removes it from the address bar.

### Fixes

- Password changes on a share can no longer be bypassed by a login that was already in progress.

---

## 中文

### 新增

- **多节点通知。** 在「设置 → 通知」打开「接收其它节点的通知」后，所有节点的事件（响铃、watch 规则、设备告警）都会通过本机的 webhook、Telegram 与微信 bot 发送，并在入口页面弹出带节点名与终端链接的通知。汇聚机不可达时节点最多缓存 20 条 / 3 分钟（按窗格合并）。通知页会说明当前编辑的是哪台机器的通道，节点详情增加「通知设置」入口。
- **分享密码管理。** 「设置 → 分享」的进行中分享可查看密码、修改密码（可选同时断开当前所有观看者）、复制带密码的链接。分享对话框新增「链接中包含密码」选项；打开此类链接会自动填入密码并从地址栏移除。

### 修复

- 修改分享密码时，正在进行中的登录不再能绕过新密码。
