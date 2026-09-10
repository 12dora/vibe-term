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

iOS 主屏 PWA 在后台会被系统回收，每次回到前台都是一次冷启动：壳、chunk、字体全部重新走网络（`index.html` 是 `no-cache`，`public/fonts` 约 2.48 MB 至少一次条件请求）。这一层由「服务端下发口径 + 应用壳 Service Worker」共同解决。

### 4.1 服务端下发口径

`packages/app` 运行时 `serve-frontend.ts` 是唯一的 `fe-dist` 静态处理器（gateway 不直接 serve SPA）：

- Vite 默认 `assets/[name]-[hash].ext`（`vite.config.ts` 未覆盖 `rollupOptions.output`）：`Cache-Control: public, max-age=31536000, immutable`。
- 其余文件（`index.html`、`/sw.js`、图标、`/fonts/*.woff2` 等）：`Cache-Control: no-cache`，附 `ETag`（`W/"<size>-<mtimeMs>"`）与 `Last-Modified`，命中 `If-None-Match` / `If-Modified-Since` 返回 304。`/sw.js` 必须保持 `no-cache` 且位于站点根，否则 SW 更新检查会被缓存卡死、作用域也覆盖不到全站。
- MIME：`.wasm` → `application/wasm`（`WebAssembly.instantiateStreaming` 只认这个 MIME，不对就静默退回整包编译）、`.woff2` → `font/woff2`。
- 不协商 `Accept-Encoding`，故不下发 `Vary`。`/api/manifest.webmanifest` 仍由 gateway `manifestJson` 设为 `no-store`。

### 4.2 应用壳 Service Worker

源码 `apps/fe/src/sw/`：`sw.ts` 主体、`sw-routes.ts` 路由分类、`sw-policy.ts` 各项取舍的纯函数、`precache-manifest.ts` 清单口径、`register.ts` 注册策略、`sw-reload.ts` chunk 刷新逃生通道、`access-gate-recovery.ts` 访问门兜底；换代握手（消息名 + `activateWaitingWorker`）在 `packages/ui/src/sw-activation.ts`，SW、`apps/fe` 与 `packages/ui` 的弹层逃生通道共用同一份。手写，不依赖 workbox。产物由 `vite.config.ts` 的 `serviceWorkerPlugin` 在主构建落盘后单独打一遍 lib 构建，输出**不带哈希**的 `dist/sw.js`（约 11.5 KB），并把预缓存清单与构建 id（`<monorepo 版本>-<清单 sha256 前 12 位>`）`define` 进去。

预缓存分三档，一次构建一代：

| 档位 | 内容 | 安装策略 |
| --- | --- | --- |
| core | `index.html` + `index.html` 直接引用的入口 js/css 与 modulepreload 依赖（当前 4 项） | `cache.addAll`，缺一即放弃本代安装 |
| lazy | 其余 `assets/**` 的 js/css/wasm（当前 214 项，约 7.5 MB） | 逐个 `cache.add`，并发 6，失败的整体重试一轮 |
| fonts | 产物 CSS 里静态声明的默认 woff2（当前 3 个，约 2.48 MB） | 同 lazy |

字体 URL 从**产物** `assets/*.css` 里扫（`src/index.css` 还 `@import` 了主题 CSS，只读源文件会漏），并显式剔掉 `/fonts/generated/**` 那 16 MB 可选家族（选用时才运行时缓存）。字体桶扫出来是空的直接让构建失败——CSS 管线一改就静默少缓存 2.48 MB，只能等线上冷启动才发现。

运行时策略（`sw-routes.ts` 的分类结果）：

- `/assets/**`、`/fonts/**`、`/vibeterm.png`、`/vibeterm-maskable.png`、`/logo.png`：cache-first，未命中则取网络并写回本代缓存。
- 同源导航（`request.mode === 'navigate'`）：**网络优先但只给 600 ms 预算**（本代有缺口时放宽到 4 s）。网络在预算内返回 `status < 500` 或 `opaqueredirect` 就直接用它——Cloudflare Access 的 302、`guardEntryAccess` 的 403、域名访问关闭的 403 文本页都必须能接管，否则会被缓存壳整个遮住；**5xx 挡回去**（`vibeterm upgrade` 期间反代会短暂回 502/504，用它替换一个能用的缓存壳是纯粹的倒退）。超时、失败或 5xx 才回放本代缓存的 `index.html`，并顺带触发一次 `registration.update()`；超时会 `abort` 掉在途请求。**不**把新 `index.html` 写回本代缓存：新壳配旧 chunk 哈希正是要避免的组合。
- **一律不拦截**：非 GET、带 `Range` 的请求、跨源请求，同源的 `/api/`、`/ws`、`/mesh/`、`/healthz`、`/sw.js`，以及 `/n/<id>/` 下的传输层三段 `ws`、`api`、`mesh`（`/n/<id>/ws`、`/n/<id>/api/**`、`/n/<id>/mesh/**`）。`/n/<id>/devices` 这类是本应用的路由，导航时照常拿应用壳。这些请求连 `respondWith` 都不调用，由浏览器原样发出。其余未知同源 GET（非导航）同样直通，不做兜底缓存。

### 4.3 更新、逃生通道与降级

默认**没有 `skipWaiting`，也没有 `clients.claim`**：新版本发布后，浏览器在下次导航时发现 `/sw.js` 变了 → 新 SW 安装自己那一代缓存 → 等旧客户端全部退出（iOS PWA 下次冷启动）才激活 → 激活时删掉其它 `vibeterm-shell-*` 代。正在运行的页面始终拿到同一代的壳与 chunk。

「等旧客户端退出」本身必须有逃生通道，否则节点升级换掉 `resources/fe-dist` 之后会卡死在旧代（旧壳指向的 chunk 已 404，而新 SW 一直停在 `waiting`）。三条同时生效：

1. **页面侧握手**：`lazy-chunk.tsx` 的 `retryChunkLoad` 与 `packages/ui/src/lazy-overlay.tsx` 的 `recoverFromOverlayLoadFailure` 在整页刷新前，先给 `registration.waiting` 发 `{type:'vibeterm:sw-skip-waiting'}`，等一次 `controllerchange`（上限 2 s，等不到照常刷新）。两处都有 sessionStorage 的每会话一次守卫（新版本也 404 时无限刷新比停在重试卡片上糟得多），握手期间重试按钮禁用。
2. **SW 自毁**：`cacheFirst` 里某个**本代预缓存清单里收录过**的 `/assets/**` 缓存未命中且网络回 404，说明这一代指向的产物在服务端已经没了 → `caches.delete(CACHE_NAME)` + `registration.unregister()`，并置 `destructed` 让本实例余下的请求全部直通网络（否则 `caches.open` 会把刚删掉的那一代又建回来）。清单外的 404（例如强制门户返回的 404）不触发自毁。
3. **缺口降级**：lazy/fonts 失败的会整体重试一轮；重试后仍缺**任一字体**或超过 3 个 chunk 才判定这一代不可靠，把缺口清单写进 `/__vibeterm-sw__/partial-generation`。该代的导航预算放宽到 4 s（不是无限等，弱网离线不能因此白屏）；之后任何一次运行时 cache-first 写回补上清单里的条目就把它划掉，清空即删除标记、恢复 600 ms 预算。

**代的修剪**：`activate` 会把除当前代以外的同前缀缓存全删掉，因此 `caches.keys()`（按创建顺序）里剩下的**最旧**那个才是活动代。安装期（`precacheGeneration` 末尾）保留最旧的活动代与正在装的这一代，删中间那些「装完还没激活就被新版本顶掉」的残留——每代约 10 MB，只在 `activate` 里清等于永远清不到（iOS 上 activate 极少跑到）。取舍逻辑在 `sw-policy.ts` 的 `planGenerationPrune` / `planGenerationSweep`，有单测。

**访问门兜底**（`access-gate-recovery.ts`，两条路径共用一个 sessionStorage once 守卫）：

- Cloudflare Access 的 302 跳到别的源，跨源重定向根本到不了响应钩子。所以被 SW 控制时启动阶段单独探一次 `fetch('/api/auth/mode', { redirect: 'manual', credentials: 'include' })`，拿到 `opaqueredirect` / `type === 'error'` / `status === 0` 就注销 SW 并整页刷新一次。fetch 直接 reject **不**处置——那更可能是离线，而离线恰恰是缓存壳该发挥作用的时候。
- 网络慢到超预算时用户会先拿到缓存壳，随后应用第一批 API 才撞上 403。经 api-client 的 `addResponseHook` 盯住启动期第一个 `/api/**` 403：按错误信封精确比对 `error.code`（`access_denied` / `DOMAIN_ACCESS_DISABLED`），body 不是 JSON（域名访问关闭的纯文本页）才退回子串匹配；命中就注销 + 刷新。看到第一个非 403 的 `/api` 响应立即自卸，正常启动零开销。

**注册**：首帧之后经 `scheduleIdle`（`requestIdleCallback`，3 s 兜底）排进空闲，仅 `import.meta.env.PROD`；分享页（`isSharePathname`）不注册——匿名一次性入口没有复访收益，不该往陌生访客的配额里塞 10 MB。非生产反过来 `getRegistrations()` → `unregister()`，避免旧 SW 把同源的 `vite dev` 页面拦成过期打包壳（这一分支在分享页也照常执行）。

### 4.4 字体不再进冷启动关键路径

`useAppMonoFont` 过去在应用根对默认字体强制 `document.fonts.load()`，设备列表 / 设置页也要为 2.3 MB 的 woff2 等一轮网络。现在它只注入 `@font-face`（`ensureFontFaceInjected`）并写 `--font-mono`，下载交给 `font-display: swap`。真正需要精确字形度量的终端各自在挂载前强制加载：`terminal-ui` 的 `ensureTerminalFonts`（`loadTerminalResources` 内，带进程内缓存）、`TerminalPreview`、分享回放 `use-replay-terminal`。

为了不把这份等待原样搬到「首次进终端页」，`main.tsx` 在首帧后的空闲里调一次 `warmTerminalFonts`（`lib/fonts/warm-terminal-fonts.ts` → `ensureTerminalFonts`，幂等）：预热走的就是终端启动时那个缓存，进终端页时多半已经就绪，且任何非终端路由都不会因此阻塞渲染。

### 4.5 怎么验证

- Safari（iOS 需连 Mac）Web Inspector → Storage → Service Workers / Cache Storage：应看到一个 `vibeterm-shell-<版本>-<hash>` 缓存，条目数 = core + 成功的 lazy + fonts（外加有缺口时的 `/__vibeterm-sw__/partial-generation` 条目）。
- 控制台 `navigator.serviceWorker.getRegistrations()` 看注册与 `active`/`waiting` 状态；`caches.keys()` 看是否残留旧代（激活后应只剩一代，安装期最多两代）。
- Network 面板确认导航请求标记为 “Service Worker”，而 `/api/**`、`/ws`、`/n/<id>/ws` 仍是普通网络请求。
- 构建期看 vite 日志的 `[vite] service worker: dist/sw.js build=... precache core=N lazy=N fonts=N`。回归覆盖：路由分类 `sw-routes.test.ts`、代/缺口/网络采信的取舍 `sw-policy.test.ts`、清单口径 `precache-manifest.test.ts`、逃生通道 `sw-reload.test.ts` 与 `packages/ui/src/sw-activation.test.ts`、访问门 `access-gate-recovery.test.ts`。
