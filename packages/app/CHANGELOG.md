# 2.0.8

_2026-09-10_

## English

### New

- Terminal latency badge now measures the whole path from the machine that hosts the tmux session to your browser: the per-node connection round trip plus the gateway ↔ tmux hop (local or over SSH). The badge is shown for the local machine too, turns orange at 200 ms, and the details popover breaks the number down per hop. Nodes older than 2.0.8 only report the browser ↔ node part and are labelled accordingly.

### Improvements

- Much faster cold start when reopening the PWA (especially on iPhone): the app shell, scripts and default terminal fonts are cached by a service worker, so the UI paints immediately even offline; the device list and each device's last known window/pane list appear instantly from local cache and refresh in the background, while a terminal only connects when you open it. Sidebar tab, expanded nodes and the last used tab are remembered.
- On phones the sidebar drawer no longer reloads everything when you tap the terminal list: its contents stay mounted while the drawer is closed.
- The terminal font is no longer downloaded on pages that have no terminal, and the terminal engine loads its WebAssembly module in streaming mode.

### Fixes

- Remote nodes stuck on "connecting" when browsing through a relay-role entry: target nodes reported every dropped forwarded connection as "login required", which made the browser sign out and back in forever. Non-auth teardowns now carry their real reason and the entry fails over instead; the browser also verifies the session over HTTP before believing a "login required" close, backs off when a node is unreachable, and only shows the login button when the session is really gone. Direct-link negotiation through a relay entry no longer fails with a spurious 401. Note: the node-side fix takes effect once every node is upgraded.
- Session revocations that arrive via key-log sync (password reset or passkey removal done on another node) now close that user's forwarded terminal connections immediately; sessions are re-verified on a schedule tied to their expiry instead of on every keystroke.
- A slow tmux control channel can no longer desynchronise command replies or trigger a device reconnect because of the latency probe.
- Nodes that cannot reach their relay entry now retry with exponential backoff instead of every two minutes.

---

## 中文

### 新增

- 终端延迟徽标现在测的是「托管 tmux 的机器 → 你的浏览器」整条链路：每节点连接的往返时间加上网关 ↔ tmux 这一跳（本地或经 SSH）。本机也会显示，超过 200 ms 变橙色，展开明细可按跳查看。低于 2.0.8 的节点只上报浏览器 ↔ 节点这一段，并会标明。

### 改进

- 重新打开 PWA（尤其是 iPhone）快得多：应用壳、脚本与默认终端字体由 Service Worker 缓存，离线也能立刻画出界面；设备列表与每台设备上次的窗口/pane 列表先从本地缓存秒出、后台再刷新，终端只在点开时才真正连接。侧栏标签、展开的节点与上次所在标签会被记住。
- 手机上点终端列表不再整套重载：抽屉收起时内容保持挂载。
- 没有终端的页面不再下载终端字体；终端引擎以流式方式加载 WebAssembly 模块。

### 修复

- 通过中继型入口浏览时远端节点一直「连接中」：目标节点把每一次被拆掉的转发连接都报成「需要登录」，浏览器因此不停登出再登入。现在非鉴权原因的断开会带真实原因、由入口续流；浏览器收到「需要登录」也会先用 HTTP 核实会话，节点打不通时按退避重试，只有会话真的失效才显示登录按钮。经中继入口的直连协商不再报假 401。注意：节点侧的修复要在所有节点升级后生效。
- 通过 key-log 同步到达的会话撤销（在另一台节点改密或删除通行密钥）现在会立即关闭该用户的转发终端连接；会话复验改为按到期时刻安排，不再每次按键都查一次。
- tmux 控制通道变慢时，延迟探测不会再让命令回执错位或触发设备重连。
- 连不上中继入口的节点改为指数退避重试，不再每两分钟打一次。
