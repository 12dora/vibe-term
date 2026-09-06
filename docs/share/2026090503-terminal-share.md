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
共享类型与纯函数在 `packages/shared/src/share/`（导出为 `@vibeterm/shared/share`，零 `node:` 依赖，浏览器可用）。

## 服务组成（`apps/gateway/src/share/`）

- `share-service.ts` —— 单例 `getShareService()`：创建 / 列表 / 终止 / 删除 / 读日志 / 设置 / 地址候选 /
  凭证校验与登录登出 / viewer 计数 / 巡检。`runtime.ts` 在 `liveStart()` 前 `startSweeper()`。
- `share-store.ts` —— drizzle CRUD、日志批量追加（单事务推进 `log_seq`/`log_bytes`，越界置 `log_truncated`）、
  分页读、按保留期清理。
- `share-recorder.ts` —— 单分享录制器：`attachPaneConsumer` 订阅 window 内 pane，先给每个 pane 写
  `captureCanonicalScreen()` 的 `checkpoint`（并按 `baseSeq` 精确裁掉 checkpoint 之前的字节），之后追加
  `out`；输入 / 尺寸由 ws 层回调写 `in` / `resize`；250 ms 批量落库；每 2 s 按设备快照跟随 pane 进出 window。
- `share-origins.ts` —— 候选构造：`site`（`site_settings.site_url`）、`hub`（每个 `mesh_hubs.publicUrl`，
  他人 hub 带 `/n/<本机 nodeId>`）、`relay`（中继上联时的 `mesh_relays.url`，带 `/n/<本机 nodeId>`，见下）、
  `tunnel`（cloudflared 公开地址）、`ip`（`config.baseUrl` 且 host 为 IP）。
  排序由 `rankShareOrigins()` 做：`custom > site > hub > relay > tunnel > ip`，同 kind 保序去重；
  **自动候选过滤非公网地址，用户显式填的 `custom` 不过滤**（内网演示分享要能用）。
  每个候选都带 `accessUrl = origin + 转发前缀`，即浏览器实际要打开的地址（如 `https://relay/n/<nodeId>`）；
  设置页的「本机可被访问的地址」直接用这份候选（`GET /api/settings/site` 的 `siteAccessOrigins`，不含 `custom`）。
  另外两条去重规则：**站点 URL 与隧道域名同源时不再单独产出 `site`**（由 `tunnel` 候选代表，避免同一地址
  以更高优先级的 kind 出现两次）；**站点 URL 由 hub 托管时（`siteUrlManaged()`）也不产出 `site`**，
  它已经等于 `hub` 候选。手填的「默认分享地址」若与某个转发型候选（`hub` / `relay`）同主机，
  会继承该候选的 `/n/<nodeId>` 前缀，否则生成的是打不开的死链。
- `share-rate-limit.ts` —— `ShareLoginLimiter`：按（shareId, IP）15 min 窗口 10 次失败锁 15 min。
- 巡检：开机全扫一遍，之后每 5 s 判到期（`expired`）、设备消失（`device_removed`）、window 关闭
  （`window_closed`）；每小时按 `logRetentionDays` 删日志行、清过期凭证。

### 中继候选与入口探测（`relay-entry-probe.ts`）

中继链路本身是盲字节转发，浏览器不能靠它直达节点；但**同时担任 `node` 角色的中继主机**会跑 mesh
`Forwarder`（`mesh/mesh-http.ts`），于是 `https://<中继>/n/<本机 nodeId>/…` 这条 HTTP/WS 路径是通的
（`/s/<shareId>`、`/api/share-access/*`、`/ws?share=` 全部覆盖）。纯 `relay` 角色的主机只有
`/relay/uplink` 与 `/api/relay/*`，给出去就是死链。两者从节点侧看不出区别，因此中继候选由可达性探测放行：

- 只在 `node_identity.uplink_kind = 'relay'` 时考虑中继（hub 上联下永远不产出 `relay` 候选；
  切到中继后 `mesh_hubs` 会被清空，`hub` 候选自然消失）。
- `RelayEntryProbe.ensure(url)` 发即忘地 GET `${url}/n/${localNodeId}/api/auth/mode`（5 s 超时），
  HTTP 200 且 JSON 的 `nodeId` 等于本机 node id 才记 `ok`；同一地址单飞，`ok` 缓存 10 min、
  `bad`/异常缓存 2 min，过期后下次读取自动重探。
- **前缀与探测状态无关**：只要是中继上联且拿得到本机 node id，中继就恒定产出原始候选，
  `/n/<self>` 一定进 `prefixes`，同主机的自定义/默认分享地址照常继承前缀。探测只决定它进不进
  排序后的 `candidates`（即推荐与自动选取）。否则 `ok` 一过期就会存下
  `https://<中继>/s/<id>` 这种没有前缀的死链。
- 探测要等本机上联真的挂到该中继之后才可能通（中继主机得把 `/n/<self>` 经 mesh 转回来），
  所以**装配期不预热**：`assembleVibeTerm()` 在 `start()` 之后延迟 10 s 首探，之后每 5 min 补探一次
  （定时器 `unref`，`stop()` 时清理）。另外 `buildShareOriginContext()` 与
  `primeShareRelayOrigins()` 都记着上次「在用中继」，一旦变化（含从无到有）就
  `RelayEntryProbe.invalidate()` 掉该地址的 `bad` 结论并立即重探，不必干等 2 min；
  `ok` 结论不丢，免得候选在切换瞬间凭空消失。
- 被踢（`kicked`）的中继不参与；多中继按「当前在用的排最前，其余按 priority」排序。

中继上联下的**站点 URL**（`mesh/effective-site-url.ts`）：`effectiveSiteUrl()` 不再一律返回 null——
存储值本身是公网地址就以存储值为准，否则退回当前中继入口 `<relay>/n/<self>`
（`relayShareAccessUrl()` 提供，探测未通过时返回 null，调用方回落存储值）。通知深链
（push/supervisor、agent run-notify、连接告警）都读 `getSiteSettings().siteUrl`，而装机种子值多是
`http://127.0.0.1:9883`，不兜底就会退化成点不开的链接。站点 URL 仍然不托管
（`siteUrlManaged() === false`）、设置页可编辑，保存即写回存储值。

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
| GET | `/api/share/:id/password` | 回显口令明文 → `{ password }`（见下「口令查看与修改」） |
| POST | `/api/share/:id/password` | `{ password, endSessions }` → `{ share, endedSessions }` |

错误码：`SHARE_NOT_FOUND` 404、`SHARE_WINDOW_NOT_FOUND` 404、`SHARE_PASSWORD_TOO_SHORT` 400、
`SHARE_ORIGIN_INVALID` 400、`SHARE_ENDED` 409、`SHARE_ACTIVE` 409（删进行中的分享）、
`SHARE_PASSWORD_UNAVAILABLE` 409（口令无密文，只能改不能看）、
`SHARE_AUTH_REQUIRED` 409（见下「开放模式」）。

### 被分享人（公开路径，无常规会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/share-access/:id` | `{ id, name, state, expiresAt, authenticated }`，认证后附 `deviceId`/`windowId` |
| POST | `/api/share-access/:id/login` | `{ password }` → 200 / 401 `SHARE_PASSWORD_INVALID` / 429 `SHARE_LOGIN_LOCKED{retryAfterMs}` / 410 `SHARE_ENDED` |
| POST | `/api/share-access/:id/logout` | 清凭证 |

`/api/share-access/*` 整个前缀进 `auth-public-paths`，`localUiGuard` 与节点侧流入口同时放行；
分享 cookie **只**能打这三条路径，其余 `/api/*` 在流入口直接 401。

## 口令查看与修改（1.1.35）

分享创建后口令只在响应里返回一次，站长事后想再看到它、或临时换一个，此前只能终止重开。本轮补上
「查看 / 修改口令」，并允许把口令直接塞进链接。

### 密文存储

`shares` 新增可空列 `password_enc`（迁移 `0048_share_password_enc.sql`）：口令同时落两份——
`password_hash` 是 argon2id，**登录校验只认它**；`password_enc` 是 `apps/gateway/src/crypto` 的
AES-256-GCM 密文（主密钥 `VIBETERM_MASTER_KEY`，与 Telegram token、LLM key 同一套），只服务于回显。
两份都在 `apps/gateway/src/share/share-password-service.ts` 的 `SharePasswordManager` 里成对写入。

- **0048 之前创建的分享** `password_enc` 为 null：`GET /api/share/:id/password` 回 409
  `SHARE_PASSWORD_UNAVAILABLE`（前端文案 `share.error.passwordUnavailable`：「该分享的口令无法查看，
  请直接修改。」），改一次口令即补上密文。
- **主密钥与密文对不上**（换了 `VIBETERM_MASTER_KEY`、密文损坏）是部署故障，不是「不可回显」：
  `decryptWithContext` 抛的 `CryptoDecryptError` 冒到路由层，回 500 `SHARE_PASSWORD_DECRYPT_FAILED`
  并带上原始诊断（含「VIBETERM_MASTER_KEY 与数据库中的加密数据不匹配」）。绝不降级成 409，否则会把
  运维故障伪装成正常业务态。

### 修改与踢人语义

`POST /api/share/:id/password` `{ password, endSessions }`：

| 情况 | 结果 |
|---|---|
| 分享不存在 | 404 `SHARE_NOT_FOUND` |
| 分享已结束 | 409 `SHARE_ENDED`（结束的分享不再改口令） |
| 口令短于 `SHARE_PASSWORD_MIN_LENGTH`(6) | 400 `SHARE_PASSWORD_TOO_SHORT` |
| `endSessions: false` | 只换哈希 + 密文；**已登录的观众不受影响**（访问凭证独立于口令），新访客用新口令登录 |
| `endSessions: true` | 额外 `deleteAccessTokensByShare(id)` 删光该分享的全部访问凭证，并广播 `onSessionsRevoked` |

`endedSessions` 返回的是**被作废的访问凭证条数**（≈ 处于登录态的浏览器数），不是当前 ws 连接数——
凭证在库里，数得起；ws 连接数由 `ShareSessionIndex` 单独维护，且离线用户也该算进「被踢」。

踢人的断线路径：`ShareService.onSessionsRevoked` → `ws/share-hooks.ts` 的 `ShareWsService` 门面 →
`ShareSessionIndex.closeAll(shareId, 4401, 'SHARE_LOGIN_REQUIRED')`。用 4401 而不是终止用的 4410：
前端把 4401 当「要重新登录」退回密码表单，4410 才是「分享已结束」。分享记录本身仍是 `active`。

### 带口令的链接

`<share.url>#p=<encodeURIComponent(password)>`，**纯前端拼接**，服务端不参与、也不记录。接收页从
`location.hash` 读出预填密码表单（只填不提交，仍需人点一次登录），随即 `history.replaceState` 抹掉
hash。选 fragment 而非 query 是因为 fragment 不会进 Referer、不进反代与网关的访问日志。

安全提示：这等于把口令和地址合成一条「谁拿到谁能进」的链接，口令的二次门槛就没了——只适合发给
本来就该看到这个终端的人。链接一旦外泄，唯一的补救是改口令并勾「同时断开当前所有观看者」。

## 凭证流

> 头名与 cookie 名在 2.0.0 由 `x-tmex-*` / `tmex_sh_*` 改为 `x-vibeterm-*` / `vibeterm_sh_*`；混合版本期两组同时收发，读取新名优先。见 [改名迁移](../release/2026090607-rename-vibeterm.md)。

1. **登录**：节点侧 login 成功不直接写 `Set-Cookie`，而是回内部响应头 `x-vibeterm-set-share: <token>` +
   `x-vibeterm-set-share-max-age: <秒>`（登出为 `x-vibeterm-clear-share: 1`）。token 格式 `<shareId>.<32 字节 base64url>`，
   服务端只存 SHA-256，TTL 7 天并滑动续期。
2. **翻成 cookie**：本机由 `session-middleware.consumeSetSessionForBrowser`、Hub 由
   `forwarder-auth-policy.applyAuthPolicy` 转成 `vibeterm_sh_<via>=<token>; Path=/; HttpOnly; SameSite=Lax[; Secure]`
   （via = `self` 或节点 id）。三个内部头归入 `INTERNAL_CREDENTIAL_HEADERS`，绝不外传。
   续期同样走这条路：`GET /api/share-access/:id` 校验时若发生续期就重新下发这两个头，永久分享的 cookie
   不会在 7 天后无声消失。
3. **经 Hub 的流**：`forwardHttp` 对 `/api/share-access/*` 用 `share:<token>` 作为流 auth；节点侧
   `stream-auth.verifyStreamAuth` 识别 `share:` 前缀，并把 token 合成回 `cookie: vibeterm_sh_<peerNodeId>=<token>`。
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
cd apps/fe && VIBETERM_E2E_MESH=1 VIBETERM_E2E_MESH_ONLY=1 bun run scripts/run-e2e.ts tests/mesh-share.spec.ts
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
7. **口令密文与主密钥同生死**：轮换 `VIBETERM_MASTER_KEY` 后，历史分享的 `password_enc` 一律解不开，
   查看口令会报 500；登录不受影响（走哈希），改一次口令即用新主密钥重新落密文。
8. **带口令的链接不可撤回**：`#p=` 只是前端拼接，服务端既不知道谁发过、也没法作废单条链接；
   泄漏后只能改口令 + 踢人。
9. **中继入口探测是缓存式的**：中继主机刚掉 `node` 角色时，最长 10 min 内仍可能把它当作候选推荐；
   反过来刚可用的中继最长 2 min 后才会出现。要立刻纠正只能重启网关（启动时会重新预热）。
   探测走本机出网直连中继域名，被出网策略挡住时中继候选会静默消失（判定 fail-closed）。

## 相关

`docs/hub/2026082700-hub-node-architecture.md`、`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`、
`docs/terminal/2026090101-viewport-policy.md`、`docs/operations/2026090302-domain-access-policy.md`。
