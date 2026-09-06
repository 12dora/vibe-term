# 中继运营限额（第 32 轮）

## 背景

中继角色此前只有**按租户**的三档配额（`maxNodes` / `maxStreams` / `bandwidthBytesPerSec`），运营者缺两样东西：

- 中继整体的闸门。租户数无上限，每个租户的带宽桶又各自独立，十个租户各配 10 MB/s 就能把中继机的上行吃干。
- 单文件大小的约束。运营者不希望自己的中继被当成大文件搬运通道，但配额里没有这一项。

本轮补上三项中继级限额与一项按租户配额，并把它们接到 HTTP、`relay.quota` 推送、运营控制台与 CLI。

## 设计

### 两层分开

| 层 | 类型 | 存储 | 是否下发给租户 |
|---|---|---|---|
| 按租户配额 | `RelayQuota` | `relay_tenants.quota_json` / `relay_config.default_quota_json` | 是（`relay.quota` ctl 帧） |
| 中继级限额 | `RelayLimits` | `relay_config` 的三个独立列（迁移 `0049_relay_limits.sql`） | 否 |

限额单独列而不是塞进 `default_quota_json`：默认配额是「每个租户各得这么多」的语义，且会原样推给租户节点；
中继级限额是「全中继一共这么多」，绝不能进 `relay.quota` 帧。

### 新增字段

- `RelayQuota.maxFileBytes: number | null`（可选字段，天花板 1 TiB，默认 `null` 不限）。
  codec 里是可选字段，`null` 与缺失一样表示不限，因此旧中继/旧节点互通不受影响。
- `RelayLimits = { maxTenants: number | null, totalBandwidthBytesPerSec: number | null, fairShare: boolean }`
  （上限分别 65536 与 10 GiB/s，默认不限 + 公平分配开）。

### 最大租户数

判定放在 `handleRelayEnroll` 里、**口令校验之后**：满员的中继若先判满员再判口令，就成了「口令对不对」的探测器。
只拦建新租户；同一根公钥的重发令牌（被踢后重新输口令的路径）与密码加入（`mode: 'join'`）都不受影响，
否则租户被踢一次就再也回不来。超限回 `409 RELAY_QUOTA_TENANTS`。

### 总带宽与公平分配

中继的数据面只有一个 choke point：`relay-stream-router.ts` 的 `pumpMetered`。新增 `relay-bandwidth.ts`：

- `RelayBandwidthLimiter` 持有**一只**中继级 `RelayTokenBucket(totalBandwidthBytesPerSec)`。
- 公平分配开时，每个租户在这只桶里占**一个逻辑流**（`RelayTokenStream`，引用计数，租户没有活跃中继流时释放）。
  桶的 `drain()` 本来就在就绪的逻辑流之间轮转、每轮最多发 4 KiB，于是「一个租户一个流」直接得到租户间轮转公平，
  不需要第二套调度器。空闲租户的逻辑流没有待处理请求，不进就绪队列，不占轮转位。
- 公平分配关时，所有租户共用桶的默认流：同一条 FIFO，先到先得。

`pumpMetered` 里的顺序是「先租户闸、后中继闸、再记 admitted」：超了自家配额的租户不该在全局轮转里占位。
两道闸都只延迟不丢帧，mux 的 WINDOW 信用会把背压自然传回发送端。`PATCH /api/relay/config` 落库后
立刻调 `applyLimits()` 热更新速率与开关，不必重启。

### 单文件上限：中继发布、节点执行

中继流里跑的是整段 peer 会话（`SecureChannelLink` + `LinkMux`）的 AES-GCM 密文，
中继看不到 HTTP 头、`Content-Length`、文件名，也分不出一条内层流是文件还是终端会话。
因此 `maxFileBytes` 只能是**中继发布的策略**，由租户节点在自己的传输入口执行：

- 新文件 `apps/gateway/src/files/transfer-limit.ts`：`effectiveTransferMaxBytes(configMax, relayQuota)`
  取本机 `config.transferMaxBytes` 与中继下发值的小值（`null` 即忽略）。
  中继配额通过 `setRelayQuotaProvider()` 注入（在 `createRelayRoutes` 里接线，读的是 uplink 池当前的
  `RelayUplinkClient.quota`），files 侧因此不必依赖 mesh。
- 执行点两处：`file-transfer-routes.ts` 的上传 init（`POST /api/files/upload/init`，超限回 413 `too_large`
  并在响应体带 `maxBytes`）与 `device-storage.ts` 的 `pullFileFromDevice` 前后两次大小检查
  （超限 `too_large`，`detail` 为生效上限）。直连 DataChannel 的 bulk 通道以 init 声明的大小为准，
  拦住 init 就一并拦住了它。

**诚实说明**：改过软件的租户可以无视 `maxFileBytes`；真正保护运营者的是中继级带宽闸。
端口映射（第 32 轮第二部分）没有可声明的大小，`maxFileBytes` 对它不生效，只有带宽闸管得住。

## 接口

### HTTP

- `GET /api/relay/status` → `config.limits: { maxTenants, totalBandwidthBytesPerSec, fairShare }`。
- `PATCH /api/relay/config` 接受 `{ defaultQuota? , limits? }`，二者至少给一个：
  都不给 400 `RELAY_INVALID_BODY`，`defaultQuota` 非法 400 `RELAY_BAD_QUOTA`，`limits` 非法 400 `RELAY_BAD_LIMITS`。
- `GET /api/relay/health` 无鉴权，**不暴露限额**。
- `GET /api/relay/metrics` 的 `totals` 增 `bandwidthLimitBytesPerSec` / `maxTenants` / `fairShare`。
- `POST /api/relay/enroll` 新增 409 `RELAY_QUOTA_TENANTS`。
- 节点侧 `GET /api/mesh/relay/status` 的 `quota` 透传 `maxFileBytes`。

### CLI

```
tmex relay quota <tenantId|default> [--max-nodes N] [--max-streams N] [--bandwidth <KBps>|unlimited] [--max-file-mb <MB>|none] [--inherit]
tmex relay limits [--max-tenants N|none] [--total-bandwidth-kb <KBps>|none] [--fair-share on|off]
```

`relay limits` 不带任何参数时只读并打印当前限额；给了参数则按字段合并后 PATCH。

### 网页

- 「设置 → 中继管理」页头「更多」新增「中继限额…」，弹窗三项：最大租户数、总带宽上限（KB/s）、租户带宽公平分配开关。
  前两项留空即不限。
- 默认配额弹窗与单租户配额弹窗共用的 `QuotaFields` 增第四项「单文件上限（MB）」，留空即不限。
- 指标磁贴「流量」组增「租户」（`n / 上限`）与「放行带宽」（`已用 / 上限`）两格；没配上限时只出当前值。
- 租户侧「设置 → 节点 → 连接详情」的配额行增第四行「单文件上限」。

## 验收

- `cd apps/gateway && bun test src/relay src/db src/files`：
  迁移列断言、`normalizeRelayLimits` 边界、令牌桶两租户约 50/50、空闲中继不限速、关掉公平分配退回 FCFS、
  满员 409 且重发令牌放行、limits PATCH 与 metrics 投影、`effectiveTransferMaxBytes`。
- `packages/shared`：`relay.quota` 带 `maxFileBytes` 的编解码与向下兼容（`null` 与缺失都当不限）。
- `packages/api-client` / `apps/fe` / `packages/app`：契约、表单往返、CLI 旗标与 help。
- 现网口径：设最大租户数 N 后第 N+1 个 enroll 回 409；两租户同时灌流量时 admitted 速率各占总上限约一半。

## 注意事项

- `RELAY_QUOTA_LIMITS.maxNodes` 在 api-client 里原为 4096，与服务端的 256（`RELAY_CTL_MAX_NODES`）不符：
  表单放行的值服务端会 400。本轮一并改成 256 并加契约测试钉住。
- 迁移 `0049_relay_limits.sql` 必须同时登记进 `apps/gateway/src/db/managed-migrations.ts` 的 `MIGRATIONS`
  与 `drizzle/meta/_journal.json`，否则打包运行时不会执行它。
- `fair_share` 列是 `NOT NULL DEFAULT 1`：升级上来的老库默认开公平分配，行为与「只有一只全局桶」相比
  在未配总带宽时完全一致（`rate === null` 时令牌桶是 no-op）。
- 关掉公平分配后所有租户共用一条 FIFO：一个租户排队的大帧会挡住其他租户，这正是 FCFS 的定义。
  除非运营者明确要「先到先得」，否则保持默认开启。
