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
