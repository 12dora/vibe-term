# 2.20.1

_2026-11-27_

## English

### Bug Fixes

- **Desktop no longer stuck at phone size**: after viewing a terminal on a phone, locking the phone or leaving the browser could keep the desktop at the phone's narrow size, sometimes even after a reload, and occasionally garbled. The server now drops a client that has gone silent: within about 45 seconds the remaining devices get their full size back, and a session silent for 3 minutes is closed. A phone that wakes up reconnects and reclaims its size as usual. For terminals reached through another node, both nodes should run 2.20.1.
- **Reload restores the correct size**: reloading or reconnecting always re-applies the terminal size, even when the server believed it was already set.
- **Faster hand-off when a page goes to the background**: mobile browsers that close or freeze the page without a visibility change now release the terminal size immediately and claim it again when the page comes back. Size changes made while the page is in the background are applied once it is active again.

---

## 中文

### 问题修复

- **电脑端不再卡在手机尺寸**：用手机看过终端后锁屏或离开浏览器，电脑端可能一直保持手机的窄尺寸，刷新也不一定恢复，偶尔还会显示错乱。现在服务器会剔除已无响应的客户端：约 45 秒内其余设备恢复完整尺寸，无响应满 3 分钟的会话会被关闭。手机唤醒后照常重连并重新取得尺寸。经其他节点访问的终端，两端节点都需升级到 2.20.1。
- **刷新后恢复正确尺寸**：刷新或重连时总会重新下发终端尺寸，即使服务器认为尺寸已经一致。
- **页面切到后台时更快交还尺寸**：移动端浏览器关闭或冻结页面而未触发可见性变化时，现在也会立即交还终端尺寸，页面回到前台后重新声明；后台期间的尺寸变化在页面恢复后补发。
