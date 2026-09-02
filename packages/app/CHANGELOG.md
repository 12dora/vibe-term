# 1.1.19

_2026-09-03_

## English

### New

- Site name and access URL now follow the mesh: renaming the site in Settings → General renames this node everywhere, and in hub or node mode the access URL is shown read-only from the hub's public address.
- Per-node "Allow domain access" switch (local machine card → General, and the node detail dialog): turn it off to stop serving the web UI and API to the public internet while hub/node mesh services keep working; access from your LAN and this machine is unaffected. A confirmation warns you before you lock yourself out.
- Node management: the row actions are now Upgrade / More / Remove. "More" opens a node detail dialog with the name and the domain-access switch; nothing is submitted unless you actually changed it.
- Connect devices → Mobile: pick one address, then scan a QR code to open tmex on the phone before adding it to the home screen.
- HTTPS settings: Let's Encrypt DNS-01 now supports DNSPod in addition to Cloudflare, so a hub behind another web server on ports 80/443 can still get its own certificate on the built-in listener.

### Improvements

- Local machine card: the three confusing address rows are now "Local address" and "Current hub" (with the join address shown only when it differs); the direct-connect plug-in shows one status pill with the Enable switch on the same row.
- HTTPS settings were retitled and rewritten: a compact status block shows external access, configured mode and the built-in listener without contradictory wording.
- Primary/standby hub chips no longer carry the extra "writes" label.
- The latency badge now shows the median of recent heartbeat samples and explains on hover what it measures (browser ↔ entry node WebSocket round trip). Heartbeat replies bypass terminal-output backpressure, so bursty terminal output no longer inflates the number.
- Direct LAN connection attempts remember unreachable addresses (Docker bridge and carrier-NAT subnets are no longer advertised), back off exponentially and stop hammering peers.
- The WebRTC direct-connect circuit breaker now really trips: three consecutive failures, exponential cooldown, and a reset only after the channel stays healthy.
- Errors inside the app show a friendly page with retry, reload and copy-details actions instead of the framework's default error screen.

### Fixes

- Changing the password no longer kicks you back to the login page, and the success message now appears.
- Domain-access enforcement is decided by the client's source address, so it cannot be bypassed with a forged Host header.
- Standby hubs and remote nodes get an access URL that actually reaches them.

---

## 中文

### 新增

- 站点名称与访问地址跟随多节点互联：在「设置 → 通用」修改站点名称等于修改本节点名称；hub 或节点模式下访问地址改为只读，来自 Hub 的公开地址。
- 按节点的「允许域名访问」开关（本机卡片 → 通用设置，以及节点详情弹窗）：关闭后不再向公网提供网页与 API，Hub / 节点互联服务照常；局域网与本机访问不受影响。关闭前会弹出确认，避免把自己锁在门外。
- 节点管理：行操作改为「升级 / 更多 / 移除」，「更多」打开节点详情弹窗（名称、允许域名访问），未改动的项不会重复提交。
- 接入设备 → 移动设备：先选一个访问地址，再用手机扫码打开 tmex，然后添加到主屏幕。
- HTTPS 设置：Let's Encrypt DNS-01 验证在 Cloudflare 之外新增 DNSPod，80/443 被其它 Web 服务占用的 hub 也能用内置监听器拿到自己的证书。

### 改进

- 本机卡片：原先三行让人困惑的地址精简为「本机地址」与「当前 Hub」（加入地址只在不同时显示）；直连插件只保留一个状态标签，「启用」开关移到同一行。
- HTTPS 设置改名并重写文案：用「对外访问 / 配置模式 / 内置监听器」三行状态块替代前后矛盾的表述。
- 主 / 备 Hub 标签不再附带「写入」字样。
- 左上角延迟改为最近几次心跳的中位数，悬停可查看含义（浏览器与入口节点之间的 WebSocket 往返）；心跳回复不再排在终端输出的背压队列后面，大量输出时数字不再虚高。
- 局域网直连会记住不可达地址（不再广播 Docker 网桥与运营商 NAT 网段），按指数退避，不再反复冲撞对端。
- WebRTC 直连熔断真正生效：连续三次失败即冷却、指数延长，通道持续健康后才重置。
- 应用内部出错时显示友好的错误页（重试 / 重新加载 / 复制详情），不再是框架默认错误页。

### 修复

- 修改密码后不再被踢回登录页，成功提示正常显示。
- 域名访问限制按客户端来源地址判定，伪造 Host 无法绕过。
- 备 Hub 与远端节点得到的访问地址现在真正指向自身。
