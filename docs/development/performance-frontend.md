# 前端流畅度、浏览器链路韧性、设置页加载与静态资源缓存

本文记录前端侧的几项性能约定：路由 / 长列表流畅度、浏览器 WebSocket 重连策略、设置页各 tab 的加载优化，以及打包前端静态资源的缓存策略；面向改动 `apps/fe` 与 `packages/app/src/runtime/serve-frontend.ts` 的开发者。热路径（解析器、retention、渲染桥等）的优化见 [热路径性能](./performance-hot-paths.md)。

## 1. 前端流畅度

终端本身（自研 ghostty WASM + canvas、输出合帧、按键不 debounce）无可捡便宜，剩余卡顿来自路由切换与长列表：

- **页面模块缓存**：`use-page-module.ts` 模块级 `Map<loader, module>`，重访时 `useState` 惰性初始化直接 ready，`page-wrapper` 的 `key={state.status}` 不再翻转，入场动画只播一次；effect 命中缓存而状态仍 loading（首载被取消后完成）时校准为 ready。
- **路由 chunk 预热**：loader 提到 `page-modules.ts`；`NavLink` 的 `preload` 在 `onPointerEnter` / `onTouchStart` 调 `lib/chunk-preload.ts`；空闲预热 devices + settings（不拖 FilePage / hljs）。
- **冷启动预热闸门**（`startupPreloadGate`）：预热、i18n rest、终端字体预热三件事整体排在闸门之后。`saveData === true` 一票否决（本次启动什么都不预热，懒面板各自按需拉）；`effectiveType` 只放行 `4g` 与 undefined（桌面 Safari / Firefox 没有这套 API，行为不变）。终端路由（`/devices/<id>`，可带 `/n/<nodeId>` 前缀）还要等**首个终端内容绘制**信号，`FIRST_PAINT_FALLBACK_MS = 15 s` 兜底（设备离线时首帧永远不来）；非终端路由立即放行。
- **content-visibility**：文件树单目录可见行 > 100 时子行加 `content-visibility: auto` + `contain-intrinsic-size: auto 26px`（可排序根行不加）；会话线程 > 40 行同理（`auto 64px`），滚动测量走 rAF 合帧，吸底前先结算同帧测量以免把上滚的人拽回底部。
- **vendor 分包**：`manualChunks` 只把 react / react-dom / scheduler / react-router / react-query / i18next / react-i18next / zustand 归 `vendor-react`（gzip 约 121 KB），懒加载边界不变；预算脚本按 `script + modulepreload` 合计口径。入口 gzip 281,501 B → `index` 160,558 + `vendor-react` 120,809 B。
- 不做：保活池跨路由存活（StrictMode / portal 风险）、lucide 深路径导入（tree-shake 已生效）。

文件树 bench（500 / 120 / 50 行）mean 18.67 / 6.84 / 2.26 ms（`packages/panels/src/files/files-tree-render.bench.tsx`）。

## 2. 浏览器 WebSocket 重连

- `packages/ws-client/src/reconnect-controller.ts` 退避加 ±50 % 抖动；`maxReconnectAttempts` 默认无上限，只有 `protocolFatal` / 4401 / 显式关闭才停。
- **恢复探测**（`client-resume.ts`）：`visibilitychange → visible`、`pageshow{persisted:true}`（bfcache 恢复）、`online`、`navigator.connection.change` 四条信号统一走 `handleResumeSignal()`，`ResumeProbeGate` 把 1 s 内连到的多条收敛成一次。连接**已 READY** 时发一次短期限 PING：`resolveResumeProbeTimeoutMs = min(常规 PONG 超时, clamp(4 × 中位 RTT, 2 s, 6 s))`，在途探测一律作废重发，收到 PONG 后下一拍回到常规节奏；**超时直接 `reconnect()`**（摘旧 socket 回调 → close → 立即建连），不是 `close()` 等握手。未 READY 时仍是原来的 `wakeReconnect()`。服务端播报的心跳节奏不变。
  - 为什么必须强制重连：iOS 回前台的僵尸 socket 上 `close()` 等不到对端的关闭握手，实测「页面可见但只靠常规心跳」要 **94.5 s** 才换出新连接；改后回前台 **2.0 s**（本机 RTT≈0 取下限；800 ms 链路自适应到 3.2 s）。
- **`/mesh/ws` 让出首屏**（`mesh-events.ts`）：`start()` 不当场建连，排到「首个终端内容绘制」或 `MESH_WS_START_DELAY_MS = 3 s` 兜底，谁先到算谁。该流服务端没有应用层心跳，所以恢复信号到来时若连接仍在但静默 ≥ `MESH_WS_SILENCE_RECONNECT_MS = 30 s`，直接换一条（不经退避、不触发 4401 判定）；任意入站帧刷新 `lastActivityAt`。
- **焦点回源**（`createNodeQueryClient`）：react-query 的 `refetchOnWindowFocus` 默认**关**，只给 `['devices']` 单独打开（`setQueryDefaults`），它仍受 `DEVICES_STALE_MS = 60 s` 约束。mesh 节点列表不走 react-query，由 `mesh-nodes` 自己的 `onVisible` 补一拍；其余查询改为事件驱动或各自轮询。实测回前台 3 s 内的 REST 从「每个挂载中的 node 各一批」降到 0 条焦点回源。
- **远端 node 的直连协商延后**：`attachDirectLink` 改为等该连接**首次 READY** 才拉直连栈并 `start()`（此前在建连接那一刻就拉，`?cid=` 必为 null，只会连吃 404 再重试）。订阅与诊断占位仍同帧挂好。
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

iOS 主屏 PWA 在后台会被系统回收，每次回到前台都是一次冷启动：壳、chunk、字体全部重新走网络（`index.html` 是 `no-cache`，字体至少一次条件请求）。这一层由「服务端下发口径 + 应用壳 Service Worker」共同解决。

### 4.1 服务端下发口径

`packages/app` 运行时 `serve-frontend.ts` 是唯一的 `fe-dist` 静态处理器（gateway 不直接 serve SPA）：

- Vite 默认 `assets/[name]-[hash].ext`（`vite.config.ts` 未覆盖 `rollupOptions.output`）：`Cache-Control: public, max-age=31536000, immutable`。
- 其余文件（`index.html`、`/sw.js`、图标、`/fonts/*.woff2` 等）：`Cache-Control: no-cache`，附 `ETag`（`W/"<size>-<mtimeMs>"`）与 `Last-Modified`，命中 `If-None-Match` / `If-Modified-Since` 返回 304。`/sw.js` 必须保持 `no-cache` 且位于站点根，否则 SW 更新检查会被缓存卡死、作用域也覆盖不到全站。
- MIME：`.wasm` → `application/wasm`（`WebAssembly.instantiateStreaming` 只认这个 MIME，不对就静默退回整包编译）、`.woff2` → `font/woff2`。
- **按 `Accept-Encoding` 下发 br / gzip**（`static-compression.ts`）：可压类型为 `.js .mjs .css .html .json .svg .wasm .map .txt .webmanifest`，`.woff2`（本身已压）与图片原样下发、不带 `Vary`。构建期 sidecar 优先——vite 插件 `compress-static` 在 SW 写完后为产物写 `.br`（质量 11）/ `.gz`（级别 9），压不小的文件不写；运行时没有新鲜 sidecar 才即时压（br q5 / gzip 9）并 temp+rename 落盘，目录只读时退到 64 MB 内存 LRU。落盘前复核源文件（size / mtime / inode）未被替换，避免升级切 `fe-dist` 时把旧内容缓存成新源的 sidecar。
- 可压响应带 `Vary: Accept-Encoding`；**ETag 按变体**（`W/"<size>-<mtime>"` / `-gzip` / `-br`），304 只在同一变体上命中，`If-Modified-Since` 只用于未压缩变体。带 `Range` 的请求一律不压。`.wasm` 压缩后仍是 `application/wasm`。`index.html` 保持 `no-cache`，可以压。
- 实测（隔离实例）：入口 `index-*.js` 593 KB → br 150 KB（−75%），js+css 合计 6.68 MB → br 1.71 MB。代价是 `fe-dist` 里多出约 4 MB sidecar，发行包体随之 +4 MB（见 [发版流程](../operations/release-process.md)）。
- `/api/manifest.webmanifest` 仍由 gateway `manifestJson` 设为 `no-store`。

### 4.2 应用壳 Service Worker

源码 `apps/fe/src/sw/`：`sw.ts` 主体、`sw-routes.ts` 路由分类、`sw-policy.ts` 各项取舍的纯函数、`precache-manifest.ts` 清单口径、`register.ts` 注册策略、`sw-reload.ts` chunk 刷新逃生通道、`access-gate-recovery.ts` 访问门兜底；换代握手（消息名 + `activateWaitingWorker`）在 `packages/ui/src/sw-activation.ts`，SW、`apps/fe` 与 `packages/ui` 的弹层逃生通道共用同一份。手写，不依赖 workbox。产物由 `vite.config.ts` 的 `serviceWorkerPlugin` 在主构建落盘后单独打一遍 lib 构建，输出**不带哈希**的 `dist/sw.js`（约 11.5 KB），并把预缓存清单与构建 id（`<monorepo 版本>-<清单 sha256 前 12 位>`）`define` 进去。

预缓存分三档，一次构建一代：

| 档位 | 内容 | 安装策略 |
| --- | --- | --- |
| core | `index.html` + 它直接引用的入口 js/css 与 modulepreload 依赖，**含默认 locale 的 core chunk**（当前 5 项） | `cache.addAll`，缺一即放弃本代安装 |
| lazy | 其余 `assets/**` 的 js/css/wasm（约 7.5 MB），外加两个**完整**默认字体（各 1.16 MB） | 逐个 `cache.add`，并发 6，失败的整体重试一轮；弱网 / 省流量时整档跳过 |
| fonts | 首屏要用的字体：两个 latin 子集面（44 / 47 KB）与没有子集的符号字体（162 KB） | 同 lazy，但**从不跳过** |

字体 URL 从**产物** `assets/*.css` 里扫（`src/index.css` 还 `@import` 了主题 CSS，只读源文件会漏），并显式剔掉 `/fonts/generated/**` 那 16 MB 可选家族（选用时才运行时缓存）。字体桶扫出来是空的直接让构建失败——CSS 管线一改就静默少缓存，只能等线上冷启动才发现。

**字体分档**（`splitFontTiers`）：同名 `-latin` 子集也被声明的完整字体降到 lazy 档（判据是后缀 `FONT_SUBSET_SUFFIX`，将来多切几个子集也不用改），首屏根本用不上它；子集面与符号字体留在 fonts 档常驻。

**按链路提示分档安装**：页面把 `navigator.connection` 的 `saveData` / `effectiveType` 报给 SW（`linkHintsMessage`），存在一个**不带代号**的 `vibeterm-link-hints` 缓存里——新一代在 install 期开的是自己那份空缓存，而「这次要不要装 lazy 档」恰恰要在 install 期决定。`shouldPrecacheLazy`：`saveData` 一票否决，`effectiveType` 只放行 `4g` 与「拿不到提示」。跳过时只写一个 `deferred-lazy` 标记，链路转好（页面再报一次提示）时每代补装一次。**主动跳过不计入缺口**，导航预算保持 600 ms，否则弱网用户反而每次导航多等 4 s。

运行时策略（`sw-routes.ts` 的分类结果）：

- `/assets/**`、`/fonts/**`、`/vibeterm.png`、`/vibeterm-maskable.png`、`/logo.png`：cache-first，未命中则取网络并写回本代缓存。
- 同源导航（`request.mode === 'navigate'`）：**网络优先但只给 600 ms 预算**（本代有缺口时放宽到 4 s）。网络在预算内返回 `status < 500` 或 `opaqueredirect` 就直接用它——Cloudflare Access 的 302、`guardEntryAccess` 的 403、域名访问关闭的 403 文本页都必须能接管，否则会被缓存壳整个遮住；**5xx 挡回去**（`vibeterm upgrade` 期间反代会短暂回 502/504，用它替换一个能用的缓存壳是纯粹的倒退）。超时、失败或 5xx 才回放本代缓存的 `index.html`，并顺带触发一次 `registration.update()`；超时会 `abort` 掉在途请求。**不**把新 `index.html` 写回本代缓存：新壳配旧 chunk 哈希正是要避免的组合。
- **一律不拦截**：非 GET、带 `Range` 的请求、跨源请求，同源的 `/api/`、`/ws`、`/mesh/`、`/healthz`、`/sw.js`，以及 `/n/<id>/` 下的传输层三段 `ws`、`api`、`mesh`（`/n/<id>/ws`、`/n/<id>/api/**`、`/n/<id>/mesh/**`）。`/n/<id>/devices` 这类是本应用的路由，导航时照常拿应用壳。这些请求连 `respondWith` 都不调用，由浏览器原样发出。其余未知同源 GET（非导航）同样直通，不做兜底缓存。

### 4.3 更新、逃生通道与降级

SW 自身仍**没有 `skipWaiting`、没有 `clients.claim`**：新版本发布后，浏览器在下次导航时发现 `/sw.js` 变了 → 新 SW 安装自己那一代缓存 → 等旧客户端全部退出才激活 → 激活时删掉其它 `vibeterm-shell-*` 代。正在运行的页面始终拿到同一代的壳与 chunk。

但「等旧客户端退出」在 iOS 主屏 PWA 上等于永不发生：切出去只是挂起，旧 SW 一直在控制，加上导航是 600 ms 预算的网络优先（手机到公网 hub 的 RTT 300–800 ms，基本每次都超预算回放上一代缓存壳），用户会无限期停在装机那天的 UI 上。**换代接管**（`sw-update.ts`）因此在两个「安全时刻」主动握手 + 整页刷新一次：

1. **页面刚加载完就发现 `registration.waiting`**：这一帧本来什么都没做，直接接管。**前提是本页已被某一代 SW 控制**；没有 controller（首次安装、SW 被系统杀掉后重装）说明这一页拿到的本来就是新壳，不刷。
2. **运行期装好新一代**（`updatefound → installed`）或 SW 报 `shell-stale`（本次导航回放的是旧壳）：先记账，等下一次**真正的回归**——在后台待够 `SW_TAKEOVER_MIN_HIDDEN_MS = 30 s` 后回到前台，或 bfcache 恢复（`pageshow{persisted}`）——才接管。切出去看一眼验证码再切回来不算回归。不够格就继续排队。

另外每次回到前台顺手 `registration.update()` 一次，限流 60 s，否则挂起几天的 PWA 连「有新版」都不知道。

刷新循环的守卫：握手失败（`waiting` 那一版根本不认 skip-waiting）时刷多少次都是同一代，所以刷新前把时刻写进 `sessionStorage`，`SW_TAKEOVER_COOLDOWN_MS = 10 min` 内不再刷；确认某次加载**没有 waiting**（上次接管真的生效了）就清掉守卫。用时刻而不是「本会话一次」：卡住时最多每个冷却期多刷一次，真正的下一次发版也不会被上一次的失败永久挡住。

对用户可见的表现：**升级后第一次把手机上的 PWA 切回前台，它会自己刷新一次**，之后就是新版界面。

「等旧客户端退出」本身必须有逃生通道，否则节点升级换掉 `resources/fe-dist` 之后会卡死在旧代（旧壳指向的 chunk 已 404，而新 SW 一直停在 `waiting`）。三条同时生效：

1. **页面侧握手**：`lazy-chunk.tsx` 的 `retryChunkLoad` 与 `packages/ui/src/lazy-overlay.tsx` 的 `recoverFromOverlayLoadFailure` 在整页刷新前，先给 `registration.waiting` 发 `{type:'vibeterm:sw-skip-waiting'}`，等一次 `controllerchange`（上限 2 s，等不到照常刷新）。两处都有 sessionStorage 的每会话一次守卫（新版本也 404 时无限刷新比停在重试卡片上糟得多），握手期间重试按钮禁用。
2. **SW 自毁**：`cacheFirst` 里某个**本代预缓存清单里收录过**的 `/assets/**` 缓存未命中且网络回 404，说明这一代指向的产物在服务端已经没了 → `caches.delete(CACHE_NAME)` + `registration.unregister()`，并置 `destructed` 让本实例余下的请求全部直通网络（否则 `caches.open` 会把刚删掉的那一代又建回来）。清单外的 404（例如强制门户返回的 404）不触发自毁。
3. **缺口降级**：lazy/fonts 失败的会整体重试一轮；重试后仍缺**任一字体**或超过 3 个 chunk 才判定这一代不可靠，把缺口清单写进 `/__vibeterm-sw__/partial-generation`。该代的导航预算放宽到 4 s（不是无限等，弱网离线不能因此白屏）；之后任何一次运行时 cache-first 写回补上清单里的条目就把它划掉，清空即删除标记、恢复 600 ms 预算。

**代的修剪**：`activate` 会把除当前代以外的同前缀缓存全删掉，因此 `caches.keys()`（按创建顺序）里剩下的**最旧**那个才是活动代。安装期（`precacheGeneration` 末尾）保留最旧的活动代与正在装的这一代，删中间那些「装完还没激活就被新版本顶掉」的残留——每代约 10 MB，只在 `activate` 里清等于永远清不到（iOS 上 activate 极少跑到）。取舍逻辑在 `sw-policy.ts` 的 `planGenerationPrune` / `planGenerationSweep`，有单测。

**访问门兜底**（`access-gate-recovery.ts`，两条路径共用一个 sessionStorage once 守卫）：

- Cloudflare Access 的 302 跳到别的源，跨源重定向根本到不了响应钩子。所以被 SW 控制时启动阶段单独探一次 `fetch('/api/auth/mode', { redirect: 'manual', credentials: 'include' })`，拿到 `opaqueredirect` / `type === 'error'` / `status === 0` 就注销 SW 并整页刷新一次。fetch 直接 reject **不**处置——那更可能是离线，而离线恰恰是缓存壳该发挥作用的时候。
- 网络慢到超预算时用户会先拿到缓存壳，随后应用第一批 API 才撞上 403。经 api-client 的 `addResponseHook` 盯住启动期第一个 `/api/**` 403：按错误信封精确比对 `error.code`（`access_denied` / `DOMAIN_ACCESS_DISABLED`），body 不是 JSON（域名访问关闭的纯文本页）才退回子串匹配；命中就注销 + 刷新。看到第一个非 403 的 `/api` 响应立即自卸，正常启动零开销。

**注册**：首帧之后经 `scheduleIdle`（`requestIdleCallback`，3 s 兜底）排进空闲，仅 `import.meta.env.PROD`；分享页（`isSharePathname`）不注册——匿名一次性入口没有复访收益，不该往陌生访客的配额里塞 10 MB。非生产反过来 `getRegistrations()` → `unregister()`，避免旧 SW 把同源的 `vite dev` 页面拦成过期打包壳（这一分支在分享页也照常执行）。

### 4.4 首屏字节：字体两段加载与 i18n 按需

高延迟弱网（400 ms RTT / 2 Mbps）冷启动实测，**首个终端内容绘制 21.7 s → 7.4 s（−66%）**，首帧前字节 4.79 MB → 838 KB。三块来源：静态资源 br 压缩（§4.1）、终端字体两段加载、i18n 只加载当前语言。

**终端字体两段加载**（只对默认字体 Geist Mono，其余六个字体仍整份懒加载）：

- 构建期从入库的完整 woff2 切出 latin 子集（44 / 47 KB，完整面各 1.16 MB），两个 `unicode-range` 由产物 cmap 反推、严格互补；字体本身没有的码位（CJK 等）不在任何一面里，所以浏览器不会为一个中文字去拉 1.16 MB。见 [字体管线](./font-pipeline.md)。
- 运行时 `loadTerminalFontStages(fontId, size) → { ready, startUpgrade }`：`ready` 只等首帧样本（默认字体 = 子集面），`startUpgrade()` 才发起 Nerd 图标完整面 + 符号兜底。二段在**首个真实快照落地**时启动（与 `markFirstTerminalScreenPainted` 同一处），到达后 `forceFullRepaint()` 整体重绘。
- 二段刻意做成「首屏后按需启动」而不是与首段并发：一起发时实测首帧 9.8 s，改成首屏后才降到 7.4 s——2 Mbps 下那 2.5 MB 会实打实抢走子集和 wasm 的带宽。
- wasm 与字体并行：`loadTerminalResources()` 第一件事是 `prewarmTerminalEngine()`（fire-and-forget），ghostty wasm 的下载 + 编译与字体同刻发起，不再排在字体之后。
- 不在关键路径上的 canvas 调用方（`TerminalPreview`、分享回放）仍用 `loadTerminalFonts()`「两段都等」：canvas 不像 DOM 文本那样会自己触发 swap 下载，少了二段就永远是兜底字形。

**i18n 只加载当前语言**（`i18n/locale-unlock.ts`）：`fallbackLng` 会让 i18next 在 init 时把 fallback 语言一起排进加载队列，中文用户白下一份 `en_US.core`，rest 阶段再白下一份 `en_US.rest`。现在 backend 只服务「已解锁」的语言，首屏只解锁 `resolveInitialLanguage()` 的结果；`ensureI18nRest()` 也只拉当前语言。

- fallback 的补拉由 `parseMissingKeyHandler` 记账触发，**不是一看到缺 key 就拉**：rest 到达之前任何渲染到 rest key 的 `t()` 都会缺。缺 key 先记下（上限 32 条），等当前语言的 rest 落地后用 `i18n.exists()` 复核，还缺才解锁并补 fallback；`createActiveCompleteWaiter` 给「rest 还没被任何懒路由请求」留 5 s 有界宽限期。
- **解锁必须走 `reloadResources`**：锁期内 backend 对该语言返回空包，i18next 的 connector 会把 `<lng>|translation` 记成已加载，此后 `loadLanguages(lng)` 直接短路——解锁也拿不回语言包，裸 key 一直裸着。`createLanguageActivator` 因此在解锁后强制 `i18n.reloadResources(lng, 'translation')`，运行时切换语言同样先解锁重载再切。

### 4.5 字体不再进冷启动关键路径

`useAppMonoFont` 过去在应用根对默认字体强制 `document.fonts.load()`，设备列表 / 设置页也要为完整 woff2 等一轮网络。现在它只注入 `@font-face`（`ensureFontFaceInjected`）并写 `--font-mono`，下载交给 `font-display: swap`。真正需要精确字形度量的终端各自在挂载前强制加载：`terminal-ui` 的 `ensureTerminalFonts`（`loadTerminalResources` 内，带进程内缓存）、`TerminalPreview`、分享回放 `use-replay-terminal`。

为了不把这份等待原样搬到「首次进终端页」，`main.tsx` 在冷启动预热闸门放行后调一次 `warmTerminalFonts`（`lib/fonts/warm-terminal-fonts.ts`，幂等）：预热走的就是终端启动时那个缓存，进终端页时多半已经就绪；弱网 / 省流量时闸门直接不放行（见 §1），任何非终端路由都不会因此阻塞渲染。

### 4.6 怎么验证

- Safari（iOS 需连 Mac）Web Inspector → Storage → Service Workers / Cache Storage：应看到一个 `vibeterm-shell-<版本>-<hash>` 缓存，条目数 = core + 成功的 lazy + fonts（外加有缺口时的 `/__vibeterm-sw__/partial-generation` 条目）。
- 控制台 `navigator.serviceWorker.getRegistrations()` 看注册与 `active`/`waiting` 状态；`caches.keys()` 看是否残留旧代（激活后应只剩一代，安装期最多两代）。
- Network 面板确认导航请求标记为 “Service Worker”，而 `/api/**`、`/ws`、`/n/<id>/ws` 仍是普通网络请求。
- 构建期看 vite 日志的 `[vite] service worker: dist/sw.js build=... precache core=N lazy=N fonts=N`（当前 core=5）；`dist/assets/*.{br,gz}` 是压缩 sidecar，`dist/fonts/*-latin.woff2` 是字体子集面。
- 压缩：`curl -sI -H 'Accept-Encoding: br' <url>/assets/index-*.js` 应回 `Content-Encoding: br` + `Vary: Accept-Encoding` + 带 `-br` 后缀的 ETag；带 `Range` 时不应有 `Content-Encoding`。回归覆盖：路由分类 `sw-routes.test.ts`、代/缺口/网络采信的取舍 `sw-policy.test.ts`、清单口径 `precache-manifest.test.ts`、逃生通道 `sw-reload.test.ts` 与 `packages/ui/src/sw-activation.test.ts`、访问门 `access-gate-recovery.test.ts`。
