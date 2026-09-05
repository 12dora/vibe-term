# 终端分享（1.1.34）

## 背景与目标

在此之前，把一个终端给别人看只有两条路：把对方拉进 mesh（等于给出整台机器），或截图。本轮新增
「终端分享」：终端页工具栏点一下，生成一条带口令的公开链接，对方在浏览器里能操作**这一个 tmux
window**（含分屏），看不到节点名、设备名与其它 window。分享可随时终止，全过程录屏式留痕可回放。

设计目标：

1. **隔离要真**：分享连接与常规会话走两套凭证、两套作用域；越界帧在服务端拒绝，出站数据按 window 过滤。
2. **终止要快**：撤销后 1 s 内断开，且要穿透 Hub 转发与中继链路。
3. **不新开入口**：分享面只在站长已经暴露的入口上可用，不给 Cloudflare Access / 域名访问开关打洞。

## 产品决策（2026-09-05 逐项确认）

| 项 | 决策 |
|---|---|
| 链接地址 | 不探测延迟，按预设优先级自动选：自建域名 > 中继域名 > 隧道域名 > 公网 IP；内网 IP / localhost / `.local` 从自动候选里排除。设置里可固定「默认分享地址」或填自定义域名，弹窗可临时改选 |
| 分享范围 | 整个 tab（tmux window，含分屏，动态包含之后新开的 pane） |
| 被分享人权限 | 键盘输入、鼠标上报、滚动回看；**参与尺寸仲裁**；不同步剪贴板；不能改分屏结构；看不到任何节点名 / 设备名 / 其它 tab |
| 登录态 | 输对口令后保持到到期或终止，允许多人同时在线 |
| 日志 | 录屏式（输出 + 输入 + 尺寸，带时间戳），时间轴回放；默认开启，保留 30 天，单条上限 50 MB |
| 期限 | 1 h / 24 h / 7 d / 永久 + 自定义，默认 24 h |
| 安全 | 口令最短 6 位、默认 8 位随机、只存哈希；按（分享，来源 IP）限速；分享凭证独立 cookie，拿不到任何常规 `/api/*` |

## 数据模型

`apps/gateway/src/db/schema/share.ts`，迁移 `apps/gateway/drizzle/0047_share.sql`。

| 表 | 关键列 |
|---|---|
| `shares` | `id`（22 位 base64url）、`name`、`device_id`、`window_id`、`window_name`（创建时快照）、`state`(`active`/`ended`)、`end_reason`、`password_hash`、`origin`、`url`、`record_log`、`log_bytes`、`log_truncated`、`log_seq`、`created_at`、`expires_at`（null = 永久）、`ended_at` |
| `share_access_tokens` | `id`、`share_id`、`token_hash`（SHA-256 唯一）、`client_ip`、`expires_at`、`last_seen_at`；`ON DELETE cascade` |
| `share_logs` | 主键 `(share_id, seq)`，`at`、`kind`(`out`/`in`/`resize`/`checkpoint`)、`pane_id`、`cols`、`rows`、`data BLOB` |
| `share_settings` | `id = 1` 单例：`record_logs`、`log_retention_days`、`log_max_bytes`、`default_origin` |

口令用仓库既有的 argon2id（`relay-password.ts`，与根密钥同参数）；访问 token 只存 SHA-256。
共享类型与纯函数在 `packages/shared/src/share/`（导出为 `@tmex/shared/share`，零 `node:` 依赖，浏览器可用）。

## 服务组成（`apps/gateway/src/share/`）

- `share-service.ts` —— 单例 `getShareService()`：创建 / 列表 / 终止 / 删除 / 读日志 / 设置 / 地址候选 /
  凭证校验与登录登出 / viewer 计数 / 巡检。`runtime.ts` 在 `liveStart()` 前 `startSweeper()`。
- `share-store.ts` —— drizzle CRUD、日志批量追加（单事务推进 `log_seq`/`log_bytes`，越界置 `log_truncated`）、
  分页读、按保留期清理。
- `share-recorder.ts` —— 单分享录制器：`attachPaneConsumer` 订阅 window 内 pane，先给每个 pane 写
  `captureCanonicalScreen()` 的 `checkpoint`（并按 `baseSeq` 精确裁掉 checkpoint 之前的字节），之后追加
  `out`；输入 / 尺寸由 ws 层回调写 `in` / `resize`；250 ms 批量落库；每 2 s 按设备快照跟随 pane 进出 window。
- `share-origins.ts` —— 候选构造：`site`（`site_settings.site_url`）、`hub`（每个 `mesh_hubs.publicUrl`，
  他人 hub 带 `/n/<本机 nodeId>`）、`tunnel`（cloudflared 公开地址）、`ip`（`config.baseUrl` 且 host 为 IP）。
  排序由 `rankShareOrigins()` 做：`custom > site > hub > relay > tunnel > ip`，同 kind 保序去重；
  **自动候选过滤非公网地址，用户显式填的 `custom` 不过滤**（内网演示分享要能用）。
- `share-rate-limit.ts` —— `ShareLoginLimiter`：按（shareId, IP）15 min 窗口 10 次失败锁 15 min。
- 巡检：开机全扫一遍，之后每 5 s 判到期（`expired`）、设备消失（`device_removed`）、window 关闭
  （`window_closed`）；每小时按 `logRetentionDays` 删日志行、清过期凭证。

本仓库的中继是盲字节转发，浏览器无法经中继直达节点，因此 `relay` 保留在优先级表里但不产出候选。

## 接口

### 分享方（需常规会话；经 Hub 时走 `/n/<nodeId>/api/...`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/share` | `?deviceId=&windowId=` 可选过滤，返回 `{ active, history }` |
| POST | `/api/share` | `{ deviceId, windowId, name, password, expiresInMs, origin }` → `{ share, password }` |
| POST | `/api/share/:id/revoke` | 终止 → `{ share }` |
| DELETE | `/api/share/:id` | 仅 ended，连日志一起删 |
| GET | `/api/share/:id/log` | `?after=<seq>&limit=`，默认 2000 条 / 2 MiB 一页 |
| GET/PUT | `/api/share/settings` | `ShareSettings` |
| GET | `/api/share/origins` | `{ candidates, recommended, nodePrefix }` |

错误码：`SHARE_NOT_FOUND` 404、`SHARE_WINDOW_NOT_FOUND` 404、`SHARE_PASSWORD_TOO_SHORT` 400、
`SHARE_ORIGIN_INVALID` 400、`SHARE_ENDED` 409、`SHARE_ACTIVE` 409（删进行中的分享）、
`SHARE_AUTH_REQUIRED` 409（见下「开放模式」）。

### 被分享人（公开路径，无常规会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/share-access/:id` | `{ id, name, state, expiresAt, authenticated }`，认证后附 `deviceId`/`windowId` |
| POST | `/api/share-access/:id/login` | `{ password }` → 200 / 401 `SHARE_PASSWORD_INVALID` / 429 `SHARE_LOGIN_LOCKED{retryAfterMs}` / 410 `SHARE_ENDED` |
| POST | `/api/share-access/:id/logout` | 清凭证 |

`/api/share-access/*` 整个前缀进 `auth-public-paths`，`localUiGuard` 与节点侧流入口同时放行；
分享 cookie **只**能打这三条路径，其余 `/api/*` 在流入口直接 401。

## 凭证流

1. **登录**：节点侧 login 成功不直接写 `Set-Cookie`，而是回内部响应头 `x-tmex-set-share: <token>` +
   `x-tmex-set-share-max-age: <秒>`（登出为 `x-tmex-clear-share: 1`）。token 格式 `<shareId>.<32 字节 base64url>`，
   服务端只存 SHA-256，TTL 7 天并滑动续期。
2. **翻成 cookie**：本机由 `session-middleware.consumeSetSessionForBrowser`、Hub 由
   `forwarder-auth-policy.applyAuthPolicy` 转成 `tmex_sh_<via>=<token>; Path=/; HttpOnly; SameSite=Lax[; Secure]`
   （via = `self` 或节点 id）。三个内部头归入 `INTERNAL_CREDENTIAL_HEADERS`，绝不外传。
   续期同样走这条路：`GET /api/share-access/:id` 校验时若发生续期就重新下发这两个头，永久分享的 cookie
   不会在 7 天后无声消失。
3. **经 Hub 的流**：`forwardHttp` 对 `/api/share-access/*` 用 `share:<token>` 作为流 auth；节点侧
   `stream-auth.verifyStreamAuth` 识别 `share:` 前缀，并把 token 合成回 `cookie: tmex_sh_<peerNodeId>=<token>`。
   Hub 侧 `skip401Rewrite` 对分享路径置真，节点的 401 不会被改写成 `NODE_LOGIN_REQUIRED`，也不会误清 cookie。
   **失效的分享 cookie 在分享公开 HTTP 路径上降级为匿名请求**（并清掉该 cookie），否则 A 被撤销后残留的
   HttpOnly cookie 会让同节点分享 B 的查询与登录全部 401，页面永远回不来；WS 仍严格拒绝。
   常规 cookie 失效时不再遮蔽有效的分享凭证：两套候选都带给节点，常规验证失败再试分享凭证。
4. **WS 绑定**：分享页的每一次握手（初连与重连）都带 `?share=<shareId>`。带这个参数的握手**一律按分享凭证
   鉴权，不回退常规会话**；凭证缺失 / 失效 / 绑的是别的 shareId → 关闭码 4401 `SHARE_LOGIN_REQUIRED`。
   没有这个参数的普通运行时行为不变。前端常量 `SHARE_WS_QUERY_PARAM`（`apps/fe/src/share/share-runtime.ts`）。
   本机路径由 `mesh-http.guardGatewayWebSocket` 以 `MESH_SHARE_WS_KIND` 升级并带上 scope；Hub 路径由
   `acceptWsStream` → `attachStreamSession(carrier, { shareScope })`。分享连接不进 `SessionRegistry`，
   在 `WebSocketServer` 内按 shareId 索引；复验周期 60 s。

## ws 隔离

`GatewaySession.shareScope?: { shareId, deviceId, windowId }` 是唯一的作用域来源。pane 归属由设备**当前快照**
动态判定（`share-scope.ts`，快照未就绪一律判越权，fail-closed）。

- **入站白名单**：HELLO / PING / PONG / ERROR / CHUNK；`DEVICE_CONNECT`/`DEVICE_DISCONNECT` 仅 scope 设备；
  `TERM_INPUT`/`TERM_PASTE`/`RESIZE_PANE`/`TERM_VIEWPORT`/`TMUX_SELECT`/`FOCUS_PANE` 仅 scope window 内 pane；
  `CANONICAL_COMMAND` 的 pane target 必须在 scope 内。其余（`SPLIT/CLOSE/MOVE/BREAK/RENAME/REORDER_*`、
  `APPLY_STACKED_LAYOUT`、`SET_WINDOW_STYLE`、`AGENT_*`、`SITE_THEME_UPDATE`）一律拒绝，回 `KIND_ERROR`
  code **1501** / message `SHARE_FORBIDDEN`，**不断开**。
- **出站过滤**：`SourceMetadataSnapshot/Patch` 只留 device/server/session 骨架（剥掉设备名、会话名）+ scope
  window 及其 pane；scope 外 pane 的 `PaneData` 丢弃；`DEVICE_EVENT`/`TMUX_EVENT`/`CLIPBOARD_WRITE` 只放行
  scope 内 pane 的事件；`SITE_THEME_UPDATE`/`SETTINGS_UPDATE`/`NOTIFY_EVENT` 广播跳过分享连接；HELLO 时不注册
  agent ws hub，因此 `AGENT_EVENT`/`WATCH_EVENT` 天然不到。
- **removal 也要防泄露**：`ShareMetadataView` 按连接记录真正下发过的实体，只为「曾暴露、现已移出」的实体发
  removal，其余越界变化丢弃（patch 照发，revision 连续）——否则未共享 pane 的 ID 与活动时序仍会外流。
- **异步事务复核**：抓屏 / 读历史在 `captureCanonicalScreen()` / `readPaneHistory()` 返回后、`ScreenBegin` /
  `HistoryBegin` 之前重新过一次 scope，不通过一律回 `ERROR_TMUX_TARGET_NOT_FOUND`，不发任何 Begin/Chunk/Commit。
- **移出即撤销**：metadata patch / rebase 到达时按最新 scope 重放订阅集合，服务端主动撤销越界 pane 的租约订阅，
  并丢弃该 pane 的待发批次、待发 gap 与首屏任务。订阅协调器为服务端强制改写引入代次 bias，避免与客户端的
  generation 契约冲突；撤销路径不回放，以免重复推送。
- **关闭码**：4410 `SHARE_ENDED`（终止 / 到期 / window 关闭 / 设备删除）、4401 `SHARE_LOGIN_REQUIRED`（凭证无效）。
- **撤销可达**：终止性关闭码白名单 `{4401, 4410}` 由 `stream-close-code.ts` 编进 mux RST 的 reason，
  Hub 侧解码后直接透给浏览器，不再当链路抖动去 failover。分享 ws 初次鉴权失败同样用
  `encodeTerminalStreamClose(4401, 'SHARE_LOGIN_REQUIRED')`，否则前端只会看到 1011 并无限重连。

## 录制与回放

日志是「checkpoint + 增量」而非视频：分享创建即为 window 内每个 pane 写一条 `checkpoint`（canonical 屏幕快照，
带 cols/rows），之后 `out` 追加输出、`in` 记输入、`resize` 记尺寸变化，全部带 `at` 时间戳与 `pane_id`。
超过 `logMaxBytes` 停记并标 `logTruncated`。

回放（设置 → 分享 → 历史 → 回放）在只读 ghostty 终端里按时间轴重放：跳转往前接着播、往回从最近的
checkpoint 重建；倍速 1x/2x/4x/8x；`in` 条目**只**进终端下方的标记条（`⏎ ⇥ ⌫ ⎋ ^X`），绝不写回终端。
回放尺寸由录像决定，终端开启 `setViewportPan(true)`，大尺寸录像可平移到右下角而不是被容器裁掉。

## 限速与开放模式

- **节点侧**：`ShareLoginLimiter.begin()` 在 argon2 验证**之前**预占额度（在途尝试计入上限），`settle()`
  结算——成功清空、失败落账；同（分享, IP）并发验证上限 2，超出直接 429。第 10 次失败单独记
  `lockedUntil = now + 15 min`，与滑动窗口分开维护（否则解锁时间从最早一次失败算，可能只锁 1 ms）。
- **Hub 侧**：节点看到的 clientIp 是 `peer:<hubNodeId>`，真实浏览器 IP 不过 mesh。因此
  `mesh/share-login-quota.ts` 在 `Forwarder.gateForwardedAuth()` 里对
  `POST /api/share-access/:id/login` 复用同一个 `ShareLoginLimiter`，分桶键是（真实来源 IP, shareId）：
  锁定则**转发前**返回 429 + `retry-after`，上游 401 记一次失败、2xx 清桶。
- **开放模式禁止创建**：`ShareService.setAuthRequiredResolver()` 在未启用登录保护的 standalone 部署上返回
  false，`POST /api/share` 直接 409 `SHARE_AUTH_REQUIRED`。这类部署上升级出来的连接没有 shareScope，
  分享无法兑现隔离承诺，只能从源头堵住。

## 前端

- **分享入口**：终端工具栏「分享」按钮（`packages/panels/src/share/`），弹窗字段为名称 / 有效期 / 口令 / 地址；
  创建成功后显示链接与口令（口令只在创建时给一次明文），已有分享时按钮高亮并显示在线人数。
  列表轮询：有进行中分享 10 s，否则 60 s，隐藏页不轮询。
- **被分享页**：`/s/:shareId` 与 `/n/:nodeId/s/:shareId`，挂在 `RootLayout` **之外**（无侧栏、无设置、无文件面板），
  独立 chunk。状态机 `loading → password → terminal → ended`。专用运行时
  `createShareRuntime()` 关掉 agent / watch / files，预置 `['devices']`、`['terminal-shortcuts']` 缓存做到**零常规
  `/api/*` 请求**；`host.appPath` 把包内的 `/devices/<d>/windows/<w>/panes/<p>` 映射成 `/s/<id>?w=&p=`，
  访客被钉死在这一个 tab 上。`installSessionInterceptor` 对分享路径不跳登录页。
  分享模式（`features.shareViewer`）下工具栏不渲染分屏按钮与分享按钮，分屏视图不渲染 pane 关闭按钮、
  标题栏不可拖动；splitter 拖拽（resize-pane）与尺寸仲裁保留。
- **设置 → 分享**：进行中表、历史表（删除）、日志回放、设置区（记录日志 / 保留天数 / 单条上限 / 默认地址）。
- **i18n**：分享方 `share.*`、设置 `settings.share.*` 在 rest 包；被分享页 `shareAccess.*` 进
  `I18N_CORE_KEY_PREFIXES`（页面在懒加载路由之外）。错误统一经 `shareErrorKey(error)` → `share.error.<CODE>`，
  未知码落 `share.error.generic`。

## 安全边界与明确不做

- **不给 Cloudflare Access / 域名访问开关打洞**。分享链接用的就是站长选定的入口；入口被 Access 保护，
  被分享人本来就该先过 Access。域名访问开关是「关掉公网入口」的总闸，分享不能穿（`/api/share-access/*`
  与 `/n/<N>/api/...` 403 JSON、`/s/<id>` 403 文本，内网来源仍放行）。净效果：分享面在「入口本身可达」时可用，
  不多开任何一条入口。
- **不同步剪贴板**、**不放行结构性操作**（分屏、关闭 pane、改窗口样式都是写操作）。
- **被分享人参与尺寸仲裁**：这是有意的产品决策，等价于多开一个客户端；最小可见客户端拥有 PTY 尺寸的策略不变
  （见 `docs/terminal/2026090101-viewport-policy.md`）。
- **无 pane 归属的设备事件**（disconnected / reconnecting / error）不发给分享连接。想让访客看到「设备已断开」，
  需要单独定义一条不含设备信息的提示帧。

## 测试

- 单测：`packages/shared/src/share/*.test.ts`；`apps/gateway/src/db/share.migration.test.ts`；
  `apps/gateway/src/share/*.test.ts`；`apps/gateway/src/ws/share-*.test.ts`；
  `apps/gateway/src/mesh/{mesh-http,session-middleware,forwarder,forwarder-auth-policy,stream-targets,link-stream-carrier,share-login-quota}.test.ts`
  与 `mesh/integration/mesh.integration.test.ts`（真实 hub A + 节点 B，终止后浏览器收到 4410）；
  前端 `apps/fe/src/share/`、`apps/fe/src/pages/settings/share/`、`packages/panels/src/share/`、
  `packages/api-client/src/share*.test.ts`。
- mesh e2e：`apps/fe/tests/mesh-share.spec.ts`（Hub 转发路径、口令、只见该 window、终止 4410、日志有内容）。

```bash
cd apps/fe && TMEX_E2E_MESH=1 TMEX_E2E_MESH_ONLY=1 bun run scripts/run-e2e.ts tests/mesh-share.spec.ts
```

e2e 环境里 hub 只有 localhost 地址、自动候选为空，用例先 `PUT /api/share/settings` 显式指定「默认分享地址」
再创建分享——这也是 `custom` 地址不做公网校验的原因。

## 已知限制与风险

1. **Hub 转发不传浏览器来源 IP**：节点侧限速在 Hub 路径上仍把所有访客算成同一个来源，由 Hub 侧配额兜住。
   彻底解法是给 peer 上下文加一条 Hub 可信填写、浏览器不可覆盖的来源 IP 元数据。
2. **录制器跟随 pane 靠 2 s 轮询设备快照**（没有事件驱动的 pane 变更钩子）；输入 / 尺寸不再因 pane 尚未同步
   而丢弃——见到陌生 pane 会先触发一次同步再记账。
3. **日志保留按日志行的 `at` 裁剪**，长命分享会先丢头部，不是按分享结束时间整条删。
4. **并发验证上限固定为 2**：同一 NAT 后大量访客同时首次登录会撞上，需要时把 `SHARE_LOGIN_MAX_CONCURRENT`
   提到 4–8。
5. **撤销依赖设备快照的更新时序**：最坏结果是少撤销一拍（下一次 patch 补上），判定本身 fail-closed。
6. **创建分享依赖设备当前快照里能找到该 window**；设备完全没有客户端连接时会回 `SHARE_WINDOW_NOT_FOUND`
   （分享入口在终端页，实际不会命中）。

## 相关

`docs/hub/2026082700-hub-node-architecture.md`、`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`、
`docs/terminal/2026090101-viewport-policy.md`、`docs/operations/2026090302-domain-access-policy.md`。
