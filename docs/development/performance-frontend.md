# 前端流畅度、浏览器链路韧性、设置页加载与静态资源缓存

本文记录前端侧的几项性能约定：路由 / 长列表流畅度、浏览器 WebSocket 重连策略、设置页各 tab 的加载优化，以及打包前端静态资源的缓存策略；面向改动 `apps/fe` 与 `packages/app/src/runtime/serve-frontend.ts` 的开发者。热路径（解析器、retention、渲染桥等）的优化见 [热路径性能](./performance-hot-paths.md)。

## 1. 前端流畅度

终端本身（自研 ghostty WASM + canvas、输出合帧、按键不 debounce）无可捡便宜，剩余卡顿来自路由切换与长列表：

- **页面模块缓存**：`use-page-module.ts` 模块级 `Map<loader, module>`，重访时 `useState` 惰性初始化直接 ready，`page-wrapper` 的 `key={state.status}` 不再翻转，入场动画只播一次；effect 命中缓存而状态仍 loading（首载被取消后完成）时校准为 ready。
- **路由 chunk 预热**：loader 提到 `page-modules.ts`；`NavLink` 的 `preload` 在 `onPointerEnter` / `onTouchStart` 调 `lib/chunk-preload.ts`；首帧后空闲预热 devices + settings（不拖 FilePage / hljs）。
- **content-visibility**：文件树单目录可见行 > 100 时子行加 `content-visibility: auto` + `contain-intrinsic-size: auto 26px`（可排序根行不加）；会话线程 > 40 行同理（`auto 64px`），滚动测量走 rAF 合帧，吸底前先结算同帧测量以免把上滚的人拽回底部。
- **vendor 分包**：`manualChunks` 只把 react / react-dom / scheduler / react-router / react-query / i18next / react-i18next / zustand 归 `vendor-react`（gzip 约 121 KB），懒加载边界不变；预算脚本按 `script + modulepreload` 合计口径。入口 gzip 281,501 B → `index` 160,558 + `vendor-react` 120,809 B。
- 不做：保活池跨路由存活（StrictMode / portal 风险）、lucide 深路径导入（tree-shake 已生效）。

文件树 bench（500 / 120 / 50 行）mean 18.67 / 6.84 / 2.26 ms（`packages/panels/src/files/files-tree-render.bench.tsx`）。

## 2. 浏览器 WebSocket 重连

- `packages/ws-client/src/reconnect-controller.ts` 退避加 ±50 % 抖动；`maxReconnectAttempts` 默认无上限，只有 `protocolFatal` / 4401 / 显式关闭才停。
- `network-wake.ts`：`online` 立即、`navigator.connection.change` 800 ms 去抖唤醒重连，与 `visibilitychange` 共用 `wakeReconnect()`；非浏览器宿主空转。
- 网关 `BunSocketCarrier.sendMany` 用 `socket.cork` 合批多帧，cork 结束后读一次 `getBufferedAmount()`，背压 / 丢帧判定顺序不变。
- 粘贴：`handleTermPaste` 整段交给连接，控制模式下按块连续写、只等最后一条回执；SSH 侧复用同一 helper。

mesh 事件 WS（`/mesh/ws`）的可见时退避与页面恢复唤醒见 [侧栏节点首屏](./sidebar-node-first-paint.md)。

## 3. 设置页各 tab 的加载

根因：远程访问 tab 的 `GET /api/tunnel/status` 曾同步等待外部隧道检测（`ps`、launchd/systemd 目录扫描、cloudflared 配置读取、多次串行 Cloudflare API 且无超时）；多节点互联 tab 整页等 `/api/auth/mode`（每次重算 TLS 信息、主用户扫描）；其余 tab 主要是懒加载 chunk 与短 staleTime 导致的重复请求。

后端：

- 外部隧道检测 stale-while-revalidate（`apps/gateway/src/tunnel/external-detect.ts`：过期先返旧值、单飞后台刷新、冷启动最多等 1.5s 返 `probing:true`，`force` 供 adopt/sync），启动预热不阻塞；Cloudflare 请求 3s 超时、`listApps` 6s 总预算（截断→unknown，绝不当「未覆盖」）。
- `/api/local/status` 并行取本机状态与 TLS；`TlsService.status()` 10s 投影缓存随写操作失效；`/api/auth/mode` 与请求无关的部分 5s 缓存（passkey 标志按 origin 实时），本机登录开关 / 引导、key-log apply、`setTlsInfo` / `setLocalAuthStore` 失效。`admit/revoke`、hub enrollment 等 `UserStore` 写路径未调用 `invalidateAuthModeCache()`，靠 5s TTL 兜底。

前端：悬停 / 空闲预取 tunnel / local / tls 状态（`status-queries.ts` 共享 key/fetcher）；只读设置数据 `SETTINGS_STALE_MS=30s`；终端预览 lazy + 等高骨架；节点页骨架屏；微信登录弹窗与 qrcode 按需加载。前端尚未消费 `external.probing`。

## 4. 打包前端静态资源的缓存策略

iOS PWA 冷启动时 Safari 会反复校验 / 重下 `public/fonts`（约 2.48 MB）与未带哈希的静态文件。`packages/app` 运行时 `serve-frontend.ts` 是唯一的 `fe-dist` 静态处理器（gateway 不直接 serve SPA）：

- Vite 默认 `assets/[name]-[hash].ext`（`vite.config.ts` 未覆盖 `rollupOptions.output`）：`Cache-Control: public, max-age=31536000, immutable`。
- 其余文件（`index.html`、图标、`/fonts/*.woff2` 等）：`Cache-Control: no-cache`，附 `ETag`（`W/"<size>-<mtimeMs>"`）与 `Last-Modified`，命中 `If-None-Match` / `If-Modified-Since` 返回 304。
- 不协商 `Accept-Encoding`，故不下发 `Vary`。`/manifest` 仍由 gateway `manifestJson` 设为 `no-store`。
