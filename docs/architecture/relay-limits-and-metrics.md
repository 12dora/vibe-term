# 中继运营限额与性能指标

本文描述中继（relay）角色的两层配额 / 限额（按租户配额与中继级限额）的设计与带宽公平分配算法，以及 `GET /api/relay/metrics` 指标接口；面向中继运营者与改动 `apps/gateway/src/relay/` 的开发者。协议、存储、接口全貌见 [公共中继角色](./relay.md)（§11 为配额表）。

## 1. 两层分开

| 层 | 类型 | 存储 | 是否下发给租户 |
|---|---|---|---|
| 按租户配额 | `RelayQuota`（`maxNodes` / `maxStreams` / `bandwidthBytesPerSec` / `maxFileBytes`） | `relay_tenants.quota_json` / `relay_config.default_quota_json` | 是（`relay.quota` ctl 帧） |
| 中继级限额 | `RelayLimits`（`maxTenants` / `totalBandwidthBytesPerSec` / `fairShare`） | `relay_config` 的三个独立列（迁移 `0049_relay_limits.sql`） | 否 |

限额单独列而不是塞进 `default_quota_json`：默认配额是「每个租户各得这么多」的语义，且会原样推给租户节点；中继级限额是「全中继一共这么多」，绝不能进 `relay.quota` 帧。

- `RelayQuota.maxFileBytes: number | null`：可选字段，天花板 1 TiB，默认 `null` 不限。codec 里是可选字段，`null` 与缺失一样表示不限，旧中继 / 旧节点互通不受影响。
- `RelayLimits = { maxTenants: number | null, totalBandwidthBytesPerSec: number | null, fairShare: boolean }`：上限分别 65536 与 10 GiB/s，默认不限 + 公平分配开。`fair_share` 列 `NOT NULL DEFAULT 1`：升级上来的老库默认开公平分配，未配总带宽时令牌桶是 no-op，行为不变。
- `RELAY_QUOTA_LIMITS.maxNodes` 在 api-client 与服务端统一为 256（`RELAY_CTL_MAX_NODES`），由契约测试钉住。

## 2. 最大租户数

判定放在 `handleRelayEnroll` 里、**口令校验之后**：满员的中继若先判满员再判口令，就成了「口令对不对」的探测器。只拦建新租户；同一根公钥的重发令牌（被踢后重新输口令的路径）与密码加入（`mode: 'join'`）都不受影响，否则租户被踢一次就再也回不来。超限回 `409 RELAY_QUOTA_TENANTS`。

`checkEnrollPassword()` 是异步的（argon2）。租户上限在这段 `await` **之后**重新读一次配置，紧挨着后面同步的「计数—判断—建租户」三步，中间不再有 `await`；否则运营者在校验期间调小上限，在途的 enroll 仍按旧上限放行。口令哈希与 `passwordEpoch` 仍用校验前那次读到的值——它们必须与实际校验过的口令对应。

## 3. 总带宽与公平分配

中继的数据面只有一个 choke point：`relay-stream-router.ts` 的 `pumpMetered`。`relay-bandwidth.ts`：

- `RelayBandwidthLimiter` 持有**一只**中继级 `RelayTokenBucket(totalBandwidthBytesPerSec)`。
- 公平分配开时，每个租户在这只桶里占**一个逻辑流**（`RelayTokenStream`，引用计数，租户没有活跃中继流时释放）。桶的 `drain()` 在就绪的逻辑流之间轮转、每轮最多发 4 KiB，于是「一个租户一个流」直接得到租户间轮转公平。空闲租户的逻辑流没有待处理请求，不进就绪队列，不占轮转位。
- 公平分配关时，**bulk** 共用一条 FCFS 流：先到先得。一个租户排队的大帧会挡住其他租户，这正是 FCFS 的定义；除非运营者明确要「先到先得」，否则保持默认开启。旁路道即使在 `fairShare` 关掉时仍按租户轮转，不是 FCFS。
- 中继级这只桶**关掉无上限的 ≤4 KiB 旁路**（`RelayTokenBucketOptions.bypassSmallFrames: false`）。旁路按逻辑流轮转、不进 bulk 队列，并与 bulk 道按 `shouldServeBypass` **1:1 交替**：有 bulk 排队时旁路最多占整管 50%，与租户数无关。若按桶级 FIFO 发放，开小帧流多的租户能靠并发占满旁路（8 条小帧流对 1 条能拉到 8:1）。配了 `totalBandwidthBytesPerSec` 时，PONG / 按键 / `DEVICE_LATENCY` / peer ping 这类 ≤4 KiB 帧若也进 bulk 轮转，会和 256 KiB bulk 按 4 KiB 粒度排队，被拖上百毫秒。因此每租户另有一只旁路预算桶（`SMALL_FRAME_BYPASS_BYTES_PER_SEC = 32 KiB/s`，突发 64 KiB）：≤4 KiB 且预算够的帧走 `takeBypass` 跳过 bulk 轮转（仍按租户流轮转），预算用尽则仍进公平队列。同一租户的多条流共用一份预算与一个轮转位，原先的公平性问题被封顶。交互优先在**租户自己**那只桶里仍是无上限旁路（`relay-uplink-server.ts` 的 `bucketFor`）：那里的旁路只在租户自己的额度内排序。
- 每条中继流从租户逻辑流上派生一个**独立可关闭的把手**（`RelayTokenStream.createHandle()`）。中止一条流只撤这条流自己排队的请求，同租户其他流不受影响；`RelayBandwidthLimiter.clear()`（`stop()` 调用）撤掉所有队列。已关闭的把手上再 `take()` 直接 reject。没有这层身份，反复「开流—发帧—中止」会把待发放请求和 payload 一直留在桶里。
- `drain()` 一轮只发放**整块**（`min(rate, 剩余, 4 KiB)`），攒不够就先睡。发放零头会毁掉轮转：分到零头的一方要等下一次补给才凑得齐一块，而下一次补给又整块给了对手——帧长正好等于轮转粒度（4 KiB）时会锁成一边倒（67:1）。

`pumpMetered` 里的顺序是「先租户闸、后中继闸、再记 admitted」：超了自家配额的租户不该在全局轮转里占位。两道闸都只延迟不丢帧，mux 的 WINDOW 信用会把背压自然传回发送端。`PATCH /api/relay/config` 落库后立刻调 `applyLimits()` 热更新速率与开关，不必重启。

## 4. 单文件上限：中继发布、节点执行

中继流里跑的是整段 peer 会话（`SecureChannelLink` + `LinkMux`）的 AES-GCM 密文，中继看不到 HTTP 头、`Content-Length`、文件名，也分不出一条内层流是文件还是终端会话。因此 `maxFileBytes` 只能是**中继发布的策略**，由租户节点在自己的传输入口执行：

- `apps/gateway/src/files/transfer-limit.ts`：`effectiveTransferMaxBytes(configMax, relayQuota)` 取本机 `config.transferMaxBytes` 与中继下发值的小值（`null` 即忽略）。中继配额通过 `setRelayQuotaProvider()` 注入（在 `createRelayRoutes` 里接线，读的是 uplink 池当前的 `RelayUplinkClient.quota`），files 侧因此不必依赖 mesh。
- 执行点两处：`file-transfer-routes.ts` 的上传 init（`POST /api/files/upload/init`，超限回 413 `too_large` 并在响应体带 `maxBytes`）与 `device-storage.ts` 的 `pullFileFromDevice` 前后两次大小检查。直连 DataChannel 的 bulk 通道以 init 声明的大小为准，拦住 init 就一并拦住了它。

改过软件的租户可以无视 `maxFileBytes`；真正保护运营者的是中继级带宽闸。端口映射没有可声明的大小，`maxFileBytes` 对它不生效，只有带宽闸管得住。

## 5. 接口

### HTTP

- `GET /api/relay/status` → `config.limits: { maxTenants, totalBandwidthBytesPerSec, fairShare }`。
- `PATCH /api/relay/config` 接受 `{ defaultQuota? , limits? }`，二者至少给一个：都不给 400 `RELAY_INVALID_BODY`，`defaultQuota` 非法 400 `RELAY_BAD_QUOTA`，`limits` 非法 400 `RELAY_BAD_LIMITS`。
- `GET /api/relay/health` 无鉴权，**不暴露限额**。
- `POST /api/relay/enroll` 可能 409 `RELAY_QUOTA_TENANTS`。
- 节点侧 `GET /api/mesh/relay/status` 的 `quota` 透传 `maxFileBytes`。

### CLI

```
vibeterm relay quota <tenantId|default> [--max-nodes N] [--max-streams N] [--bandwidth <KBps>|unlimited] [--max-file-mb <MB>|none] [--inherit]
vibeterm relay limits [--max-tenants N|none] [--total-bandwidth-kb <KBps>|none] [--fair-share on|off]
```

`relay limits` 不带任何参数时只读并打印当前限额；给了参数则按字段合并后 PATCH。需要带值的旗标走 `requireFlagValue()`：光秃秃的 `--max-tenants` 与 `--max-tenants=` 都会在发出任何请求之前报用法错。

### 网页

- 「设置 → 中继管理」页头「更多」→「中继限额…」，弹窗三项：最大租户数、总带宽上限（KB/s）、租户带宽公平分配开关。前两项留空即不限。
- 默认配额弹窗与单租户配额弹窗共用的 `QuotaFields` 第四项「单文件上限（MB）」，留空即不限。
- 网页表单里带宽按 KB/s、单文件按 MB 取整显示。草稿记下打开表单时的**原始字节值**（`QuotaOrigin` / `LimitsOrigin`）：某个字段的文本没被改过就原样回传原值，只有真被改过才做单位换算——否则 512 B/s 会在改别的字段时被改写成 1024 B/s。
- 租户侧「设置 → 节点 → 连接详情」的配额行有「单文件上限」。

## 6. 指标接口 `GET /api/relay/metrics`

- 路径：`GET /api/relay/metrics`，可选 `?members=0` 省略成员数组。
- CLI：中继机本地 `vibeterm relay metrics [--members] [--json]`（默认 `?members=0`；`--members` 发 `1` 并打成员表；`--json` 打原始 JSON）。
- 鉴权：与 `/api/relay/status` 相同（`Authorization: Bearer <管理令牌>` 或本机已登录会话）。
- 类型：`packages/api-client/src/relay/metrics-types.ts` 的 `RelayMetricsResponse`；客户端 `RelayAdminApi.metrics()`（`{ members: false }` 重载返回 `Omit<…, 'members'>`）。
- 采样：`RelayMetricsCollector`（`apps/gateway/src/relay/relay-metrics.ts`）每 5 s 采样一次，`history.samples` 保留最近 60 个样本（约 5 分钟）；定时器 `unref`，运行时关闭时停止。

| 字段 | 来源 | 说明 |
|---|---|---|
| `process.memory / cpu / loadAvg / eventLoop / openSockets / authenticatedLinks` | `process.memoryUsage()`、连续 `cpuUsage()` 差值、`os.loadavg()`、网关事件循环采样器、uplink 服务端已接受的 WebSocket 数、registry 在线链路数 | `loadAvg` 平台不支持时为 `null`；CPU 首个样本为 `null` |
| `totals.bytesIn / bytesOut` | `RelayMetering` 累计 | `bytesIn` 为从成员收到的字节，`bytesOut` 为发给成员的字节；同一份中转数据两侧各计一次（与落库口径一致） |
| `totals.*PerSec` | 相邻样本累计值之差 / 间隔 | 累计值回绕视为计数器复位，从 0 起算 |
| `totals.framesIn/OutPerSec` | `LinkMux.stats()`（在线链路之和 + 已移除链路折入的 `retired` 累计） | 链路关闭或替换不会让速率跌成 0 |
| `totals.bandwidthBytesPerSec` | 令牌桶放行字节的相邻样本差 / 间隔（`RelayMetering.recordAdmitted`） | 与限额同口径：被延迟的字节不计入；不要用 `bytesIn + bytesOut` |
| `totals.bandwidthLimitBytesPerSec / maxTenants / fairShare` | `relay_config` 的中继级限额 | 两个上限为 `null` 即不限；旧中继不下发这三项 |
| `tenants[].quota` / `tenants[].usage` | 生效配额（租户覆盖 ?? 默认）与当前用量 | `maxFileBytes` 为 `null` 或缺失即不限；运营者侧 `GET /api/relay/status` 的 `tenants[n].quota` 仍是原始覆盖值 |
| `members[].rttMs / connectedAt / reconnects / activeStreams / bytes*PerSec` | uplink 服务端 ping 时间戳、registry 记账、stream router 记账 | 等待 pong 期间不再重发 ping，RTT 对应原始 ping；吊销成员与删除租户时清理记账 |
| `tenants[].pack.sizeBytes / updatedAt` | `relay_tenants.sealed_pack` 与 `sealed_pack_updated_at`（迁移 0046） | 根轮换时清空时间戳 |

响应不含令牌哈希、密钥、密封包内容与 key-log 原文。生产链路是 `WebSocketLink`，已公开 `stats()`；新增链路类型需同样实现，否则帧计数缺失。

### 实时用量推送

控制消息 `relay.quota` 可选 `usage { currentNodes, currentStreams, bytesInPerSec, bytesOutPerSec, bandwidthBytesPerSec?, sampledAt }`；接入后立即推一次，此后随 5 s 指标采样、用量指纹变化才推。旧中继不下发，旧节点忽略未知字段。节点侧 `quota.usage` 只对当前 attached 的中继有值；本机卡片「连接详情」三档配额显示 `used / max` 与进度条，带宽无上限显示「不限」。

### 前端

- `packages/ui`：`Sparkline`（内联 SVG，多序列共享刻度，空/常量序列安全）、`StatTile`（`Card size="sm"`）。
- `apps/fe/src/pages/settings/relay/relay-metrics-store.ts`：页面可见时每 5 s 轮询，隐藏/卸载停止；401/404 进入 `unauthorized`/`unavailable` 后停止轮询，重新挂载或点重试才再探测。
- 本机卡片「中继服务」段：4 + 3 个精简瓦片（在线节点、活跃流、吞吐、延迟；内存、CPU、运行时长）。
- 「中继管理」tab：瓦片分「流量 / 进程」两组，「租户」与「放行带宽」两格在配了上限时显示 `已用 / 上限`；趋势卡三条 5 分钟折线（吞吐、活跃流、事件循环延迟），成员表（RTT、流、速率、重连、接入时间）。新建的 `relay,node` 在接入自身中继前 `/api/mesh/relay/status` 返回 `mode: "hub"`，前端按角色而非该字段决定文案。

## 测试

`cd apps/gateway && bun test src/relay src/db src/files`：迁移列断言、`normalizeRelayLimits` 边界、令牌桶两租户约 50/50、空闲中继不限速、关掉公平分配退回 FCFS、满员 409 且重发令牌放行、上限在口令校验期间被调小仍然生效、limits PATCH 与 metrics 投影、`effectiveTransferMaxBytes`；100 次「开流—发帧—中止」后两种模式下队列都清零、被取消的租户不再吃令牌、8 条小帧流的租户对 1 条流的租户放行字节接近 1:1；小帧在 bulk 排队时走每租户旁路预算、预算用尽回退公平队列、租户之间预算隔离；采集器（速率、环形缓冲、CPU 占比、链路移除/替换、计数复位）、心跳 RTT、记账清理、路由鉴权。`packages/shared`：`relay.quota` 带 `maxFileBytes` 的编解码与向下兼容。
