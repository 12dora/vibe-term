# 前端流畅度与浏览器链路韧性（1.1.31）

## 背景

round 28 探索（`prompt-archives/2026090502-round28-net-perf-smell/sub/EX4、EX3`）确认终端本身（自研 ghostty WASM + canvas、输出合帧、按键不 debounce）无可捡便宜，剩余卡顿来自路由切换与长列表；浏览器 WebSocket 5 次重连后永久放弃且只靠 `visibilitychange` 自愈。

## 前端

- **页面模块缓存**：`use-page-module.ts` 模块级 `Map<loader, module>`，重访时 `useState` 惰性初始化直接 ready，`page-wrapper` 的 `key={state.status}` 不再翻转，入场动画只播一次；effect 命中缓存而状态仍 loading（首载被取消后完成）时校准为 ready。
- **路由 chunk 预热**：loader 提到 `page-modules.ts`；`NavLink` 的 `preload` 在 `onPointerEnter` / `onTouchStart` 调 `lib/chunk-preload.ts`；首帧后空闲预热 devices + settings（不拖 FilePage / hljs）。
- **content-visibility**：文件树单目录可见行 > 100 时子行加 `content-visibility: auto` + `contain-intrinsic-size: auto 26px`（可排序根行不加）；会话线程 > 40 行同理（`auto 64px`），滚动测量走 rAF 合帧，吸底前先结算同帧测量以免把上滚的人拽回底部。
- **ScrollArea**：删恒为 null 的 `<Corner />`；未把 ScrollArea 换成 div（未实测）。
- **vendor 分包**：`manualChunks` 只把 react / react-dom / scheduler / react-router / react-query / i18next / react-i18next / zustand 归 `vendor-react`（gzip 约 121 KB），懒加载边界不变；预算脚本改为 `script + modulepreload` 合计口径。
- 不做：保活池跨路由存活（StrictMode / portal 风险）、lucide 深路径导入（tree-shake 已生效）。

## 浏览器 WebSocket

- `reconnect-controller.ts` 退避加 ±50 % 抖动；`maxReconnectAttempts` 默认无上限，只有 `protocolFatal` / 4401 / 显式关闭才停。
- `network-wake.ts`：`online` 立即、`navigator.connection.change` 800 ms 去抖唤醒重连，与 `visibilitychange` 共用 `wakeReconnect()`；非浏览器宿主空转。
- 网关 `BunSocketCarrier.sendMany` 用 `socket.cork` 合批多帧，cork 结束后读一次 `getBufferedAmount()`，背压 / 丢帧判定顺序不变。
- 粘贴：`handleTermPaste` 整段交给连接，控制模式下按块连续写、只等最后一条回执；SSH 侧复用同一 helper。

## 度量

文件树 bench（500 / 120 / 50 行）mean 18.67 / 6.84 / 2.26 ms；入口 gzip 281,501 B → `index` 160,558 + `vendor-react` 120,809 B。
