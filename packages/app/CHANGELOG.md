# 2.10.0

_2026-09-26_

## English

### New

- Login limits: Settings → Account security now has a "Login limits" section with Relaxed / Standard / Strict presets or custom values. Repeated failed password logins lock the source IP for a while (the lock grows longer on repeat), and too many failures per hour pause password login for the account. Passkey login keeps working during a pause, and logins from this machine or the local network are not locked. The policy applies to every node; saving it requires all nodes to be on 2.10.0 or later.
- Login history: open it from the "This machine" card menu to see successful and failed logins on each node, with time, method, IP, browser and entry node. Background logins between nodes are hidden by default and can be shown. Retention (default 90 days) and clearing apply to all reachable nodes. The CLI adds `vibeterm auth history`.
- Remote access settings now link straight to login protection settings.

### Improvements

- Once an account exists, the setup endpoints require you to be signed in, the post-login redirect only goes to pages on this site, and pages can no longer be embedded by other sites.
- Window memory limits moved to Settings → Terminal.
- Clearer "Connection failed" messages.

### Fixes

- Fixed endless reconnects to a node after its direct connection dropped to the relay and then came back.
- Fixed the node list not updating after the relay restarted, and a previous primary relay not being re-attached after switching primary relays.
- Fixed browser direct connections running out of slots after failed attempts, and the browser retrying direct connections too often while a node was unreachable.
- When two-step verification setup fails, retrying keeps the same QR code until you finish or cancel.

---

## 中文

### 新增

- 登录限制：设置 → 账号安全新增「登录限制」，可选宽松 / 标准 / 严格预设或自定义。同一 IP 连续输错密码会被锁定一段时间（反复触发时逐级加长），账号每小时失败过多会暂停密码登录；暂停期间通行密钥照常可用，本机和局域网登录不受锁定。策略对所有节点生效，保存时要求所有节点已升级到 2.10.0 或以上。
- 登录历史：在「本机」卡片菜单里打开，按节点查看成功和失败的登录记录，含时间、方式、IP、浏览器与入口节点。节点间的后台登录默认隐藏，可展开查看。保留时间（默认 90 天）和清空会同步到所有可达节点。命令行新增 `vibeterm auth history`。
- 远程访问设置里新增「登录保护设置」入口。

### 改进

- 已有账号后，初始化接口需要先登录；登录后的跳转只允许本站页面，页面也不再允许被其他网站嵌入。
- 窗口内存限额移到了设置 → 终端。
- 「连接失败」相关提示更清晰。

### 修复

- 修复直连降级到中继后再恢复时，对该节点无限重连的问题。
- 修复中继重启后节点列表不更新，以及切换主中继后原主中继不再挂回的问题。
- 修复浏览器直连失败后名额被占满，以及节点不可达时浏览器过于频繁重试直连的问题。
- 两步验证设置失败后重试，二维码保持不变，直到完成或取消。
