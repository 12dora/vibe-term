# 1.1.22

_2026-09-03_

## English

### Fixes

- Fixed the Claude Code input box (and any other TUI region) getting stuck showing stale colours — the "text turns light green" bug. A round-21 optimisation reused unchanged rows when the view scrolled, but a full repaint triggered by switching back to the tab could clear the "there was output" flag; the rows an application had just redrawn in place were then dropped and never repainted. The two flags are now separate and the repaint path can no longer enable row reuse across a period with output.
- Faint text (SGR 2) is now actually rendered half-bright; it used to be drawn at full brightness, so hints and placeholders in TUIs looked like normal text.
- A multi-hub failover race: when a node's relay link was replaced while an HTTP request was still in flight over it, the old link could close before the response end arrived. The retiring link now re-arms its quiesce barrier after the last stream drains, and the WebRTC path no longer sends a wake before it knows the native module is available.
- Backpressure on a slow connection no longer terminates the socket when only terminal output was dropped; the client is asked to resync the screen instead. Dropped control or metadata frames still trigger a full reconnect.

### Performance

- Keystroke echo no longer pays a fixed ~20 ms of timer delay (16 ms on the server, 4 ms in the browser): output batching now emits immediately when nothing is buffered and only coalesces during sustained output.
- Encoding terminal frames on the server is ~140× faster (a 64 KiB frame: 437 µs → 3 µs) and decoding them in the browser ~90× faster (96 µs → 1 µs), fixing a regression introduced when the canonical state stream was switched on in 1.1.21. Mesh relays no longer fully decode every frame just to read its kind.
- The terminal render bridge reads all cell attributes in one call per row instead of ~12 calls per cell; a full-screen frame dropped from 1.18 ms to 0.64 ms.
- Hidden keep-alive panes no longer render at all (their state stays warm in WASM and they repaint fully when shown): with three panes producing output, terminal work per frame fell from ~8 ms to ~3 ms. Metadata patches (titles, cwd) no longer re-render the whole console.
- The server does far less work for panes nobody is watching: their output only drives the notification state machine (bell, titles, clipboard) and is not materialised, retained or broadcast. Parsing SGR-dense output is ~2× faster and allocates almost nothing per event.
- WebRTC direct links: single-fragment frames are delivered without copying (70 B keystroke 266 → 99 ns), and a node that has repeatedly failed to establish a direct link stops retrying every few minutes until the network changes. The native WebRTC module is loaded only when a direct link is actually attempted, removing ~100 timer wakeups per second from idle processes.
- The browser heartbeat now honours the interval the server advertises (15 s instead of 5 s): 3× fewer wakeups and bytes on an idle session.
- The file tree uses one shared context menu instead of one per row (500 rows: 62 → 17 ms), the code viewer highlights in a Web Worker and loads only the language it needs, a streaming Markdown code block that has not closed yet is no longer re-parsed every 40 ms (150 KB: 13 → 1.3 ms per flush), the settings page no longer re-renders every tab on each keystroke, and changing the terminal font size no longer rebuilds every terminal on every keypress.
- Split-pane dragging is coalesced per frame and touch scrolling has inertia.
- First download is ~18% smaller (346 KB → 284 KB compressed): overlay components, the WebRTC stack, toasts and per-language highlighters load on demand, and only the core of the language pack blocks first paint (34 KB → 10 KB). KaTeX fonts ship as woff2 only, and the KaTeX CSS/JS versions are aligned again.

### Housekeeping

- Removed unused HTTP routes (`/api/capabilities`, device tree-order, per-user Weixin routes), ~1,200 lines of dead code, 82 unused translation keys, 16 ghost theme tokens and 15 forwarding dependencies. Consolidated duplicated implementations of semver parsing, release checksum verification, IP classification, base32/TOTP re-wrapping, CRUD request templates and several UI primitives.
- The README security section now describes the actual authentication stack; the ws-borsh protocol spec lists all 57 message kinds and is checked against the code in CI.

---

## 中文

### 修复

- 修复 Claude Code 输入框（及其他 TUI 区域）卡在旧颜色、「文字变浅绿」的问题。1.1.21 的滚动优化会在视口平移时复用未变化的行，而切回标签页触发的强制全画会清掉「期间有输出」标记；应用刚原位重画的那几行被整批丢弃且永不重画。现在两个标记分开，全画路径不再可能跨着有输出的时段启用行复用。
- SGR 2（faint）此前被解析但按正常亮度绘制，TUI 的提示/占位文字与正文一样亮；现按半亮渲染。
- 多 hub 主备切换的竞态：节点的中继链路在 HTTP 请求进行中被替换时，旧链路可能在响应结尾到达前关闭。退役链路在最后一个流结束后重新发送 quiesce 屏障；WebRTC 路径在确认原生模块可用前不再发 wake。
- 慢链路背压只丢了终端输出时不再断开连接，改为让客户端重拉屏幕；丢了控制/元数据帧仍走完整重连。

### 性能

- 击键回显不再固定多等约 20 ms（网关 16 ms + 浏览器 4 ms 的定时器）：合帧改为缓冲为空即发、持续输出时才合并。
- 网关终端帧编码快约 140 倍（64 KiB：437 µs → 3 µs），浏览器解码快约 90 倍（96 µs → 1 µs），修正 1.1.21 接通 canonical 状态流时引入的回归；mesh 中继不再为读一个 kind 全量解码每帧。
- 渲染桥改为每行一次批量读取而非每 cell 约 12 次调用，整屏帧 1.18 ms → 0.64 ms。
- 保活池里看不见的 pane 完全不再渲染（状态留在 WASM，显示时强制全画）：三个 pane 同时输出时终端每帧成本约 8 ms → 3 ms；标题/目录补丁不再重渲染整个控制台。
- 无人观看的 pane 在服务端只驱动通知状态机（bell、标题、剪贴板），不再物化、保留或广播输出；SGR 密集输出解析快约 2 倍且几乎不分配。
- WebRTC 直连：单片帧零拷贝交付（70 B 击键 266 → 99 ns）；反复失败的节点不再每几分钟重拨，直到网络变化；原生模块只在真正尝试直连时加载，空闲进程少约 100 次/秒定时器唤醒。
- 浏览器心跳采纳服务端播报的 15 s（原 5 s）：空闲会话唤醒与字节数减少 3 倍。
- 文件树共用一个右键菜单（500 行：62 → 17 ms）；代码查看器在 Web Worker 里高亮并只加载所需语言；流式 Markdown 未封口的代码块不再每 40 ms 重解析（150 KB：13 → 1.3 ms）；设置页不再每键重渲染所有标签；调终端字号不再每键重建所有终端。
- 分屏拖拽按帧合并，触摸滚动有惯性。
- 首次下载小约 18%（346 KB → 284 KB 压缩后）：弹层组件、WebRTC 栈、吐司与按语言的高亮器按需加载，首绘只等语言包核心（34 KB → 10 KB）。KaTeX 字体只带 woff2，CSS/JS 版本重新对齐。

### 整理

- 删除无调用方的路由（`/api/capabilities`、设备 tree-order、微信 per-user 路由）、约 1,200 行死代码、82 条未用翻译键、16 个幽灵主题 token 与 15 条转发依赖；合并 semver 解析、发布包校验、IP 判定、base32/TOTP 重封装、CRUD 请求模板与多处 UI 原语的重复实现。
- README 安全章节改为描述真实的鉴权栈；ws-borsh 协议规范补齐全部 57 种消息并在 CI 中与代码比对。

# 1.1.21

_2026-09-03_

## English

### Performance

- Terminal scrolling is much smoother. Scrolling used to run a full re-render synchronously inside every wheel and touch event — 4–8 ms of work at up to 120 events per second, blocking the browser from painting. Rendering is now coalesced onto animation frames, and a scrolled frame reuses the rows that merely moved instead of re-reading all of them: the render bridge went from ~1.1 ms to ~0.04 ms per scrolled line, and a frame now redraws only the newly exposed rows rather than the whole screen.
- Terminal drawing batches runs of same-coloured text into single canvas calls instead of one call per character: a full-screen redraw went from ~5.0 ms to ~1.6 ms.
- Typing is no longer slowed by disk writes. Every keystroke used to serialize all saved settings and drafts and write them to browser storage synchronously; drafts are now coalesced and written at most every 300 ms, and are still flushed when you leave or hide the page.
- Dragging the sidebar divider no longer writes to browser storage on every pointer move, and switching panes or files no longer re-renders the whole file and device trees.
- The web app's first download is about 9% smaller (376 KB → 346 KB compressed): the watch-rule dialog and the drag-and-drop engine now load on demand, and the syntax highlighter is no longer bundled twice.

### Battery and idle cost

- The cursor now blinks via a CSS animation instead of a JavaScript timer, so it costs nothing in a background tab and does not run at all for panes you cannot see. On a typical tab this removes about 180 wakeups per minute.
- On phones, the keyboard-follow loop used to run at 60 fps for as long as the terminal was focused — even with the keyboard closed — forcing a layout every frame. It now stops once the position settles and wakes on real events.
- WebRTC diagnostics polling stops while the page is hidden, and no longer republishes just because the measured round-trip jittered.
- The node list on the settings page stops polling across the network while the tab is hidden.
- The server does much less while idle: metric lines are not written when every counter is zero (about 8,600 fewer log lines a day), reading metrics no longer triggers a full sweep of every pane, network-interface lookups and key-log reads are cached, and cross-node sessions renew once per half-life instead of every five minutes.
- Server logs now have levels (`TMEX_LOG_LEVEL`) and, on macOS, are finally rotated (16 MiB × 3 generations). The log file had been growing without limit — 81 MB on a normal install — because launchd appends to it forever.

### Fixes

- Fixed a rendering bug that could leave the screen permanently showing stale content: if a program used synchronized output and you scrolled before it finished, the changed rows could be discarded and never repainted.
- Scrolling at the very top or bottom of the scrollback now hands the gesture back to the page, so page scrolling and pull-to-refresh work again.
- Copying a selection longer than 2,000 lines no longer loses the beginning of it, and a link that wraps across the top of the viewport keeps its underline and stays clickable.
- After a primary/standby hub switch, the newly promoted hub can redeem enrollment tokens again instead of pointing at the old, crashed one.
- Switching to a single-pane window resizes it to your viewport again.
- A dialog whose code fails to download (typically right after an update) no longer replaces the whole page with an error, and retries instead.

---

## 中文

### 性能

- 终端滚动明显更跟手。此前每个滚轮/触摸事件都会**同步**跑完整渲染——一次 4–8 ms，而事件率高达 120 次/秒，浏览器只能等它跑完才能出下一帧。现在渲染按帧合并；滚动帧只是整行平移，因此复用移动过的行而不是重读全部：渲染桥从每滚一行约 1.1 ms 降到约 0.04 ms，画面也只补画新露出的行而不是整屏重画。
- 终端绘制把同色连续文字合并成一次 canvas 调用，不再逐字符调用：整屏重画从约 5.0 ms 降到约 1.6 ms。
- 打字不再被磁盘写拖慢。此前每敲一个字符都会把全部设置与草稿序列化并同步写入浏览器存储；现在草稿合并到最多每 300 ms 写一次，离开或切到后台时仍会立即落盘。
- 拖动侧栏分隔条不再每次指针移动都写一次浏览器存储；切换 pane 或文件也不再重渲染整棵文件树与设备树。
- 网页首次下载体积减少约 9%（压缩后 376 KB → 346 KB）：监视规则对话框与拖拽引擎改为按需加载，语法高亮库不再被打包两份。

### 待机与耗电

- 光标闪烁从 JavaScript 定时器改为 CSS 动画，后台标签页里不再有开销，看不见的 pane 也完全不跑。常见情况下每分钟少约 180 次唤醒。
- 手机上，只要终端处于聚焦状态，键盘跟随循环就会以 60 fps 一直跑（即使键盘已收起）并每帧强制布局。现在位置稳定后即退出，靠真实事件唤醒。
- WebRTC 诊断轮询在页面隐藏时停止，也不再因为往返时延的微小抖动就重新发布。
- 设置页的节点列表在标签页隐藏时不再跨网络轮询。
- 服务端空闲时的活儿少了很多：计数全为零时不再写指标行（每天约少 8600 行日志），读指标不再顺带全量清扫所有 pane，网卡枚举与密钥日志读取加了缓存，跨节点会话从每 5 分钟续期一次改为寿命过半才续。
- 服务端日志有了分级（`TMEX_LOG_LEVEL`），macOS 上终于会轮转（16 MiB × 3 代）。此前日志文件无上限增长——正常使用下已达 81 MB——因为 launchd 会一直往里追加。

### 修复

- 修复一个会让屏幕**永久停在旧内容**的渲染问题：程序使用同步输出期间，如果你在它结束前滚动，变化的行可能被丢弃且再也不会重画。
- 滚到历史顶部或底部后继续滚动，手势会交还给页面，页面滚动与下拉刷新恢复正常。
- 复制超过 2000 行的选区不再丢开头；跨视口顶部换行的链接保留下划线且仍可点击。
- 主备 Hub 切换后，新提升的 Hub 可以正常兑换入网令牌，不再指向已经崩掉的旧 Hub。
- 切换到单 pane 窗口会重新按你的视口调整大小。
- 对话框代码下载失败时（通常发生在刚更新后）不再让整个页面变成错误界面，而是自动重试。
