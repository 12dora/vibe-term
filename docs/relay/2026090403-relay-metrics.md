# 中继性能指标（`GET /api/relay/metrics`）

## 背景

中继角色此前只有 `/api/relay/status` 的累计计数（租户、节点、流、累计字节），没有速率、延迟与进程资源，运维时看不出中继是否吃紧。本轮为中继补齐实时指标，并在设置页给出可视化。

## 接口

- 路径：`GET /api/relay/metrics`，可选 `?members=0` 省略成员数组。
- 鉴权：与 `/api/relay/status` 相同（`Authorization: Bearer <管理令牌>` 或本机已登录会话）。
- 类型：`packages/api-client/src/relay/metrics-types.ts` 的 `RelayMetricsResponse`；客户端 `RelayAdminApi.metrics()`（`{ members: false }` 重载返回 `Omit<…, 'members'>`）。
- 采样：`RelayMetricsCollector`（`apps/gateway/src/relay/relay-metrics.ts`）每 5 s 采样一次，`history.samples` 保留最近 60 个样本（约 5 分钟）；定时器 `unref`，运行时关闭时停止。

字段要点：

| 字段 | 来源 | 说明 |
|---|---|---|
| `process.memory / cpu / loadAvg / eventLoop / openSockets / authenticatedLinks` | `process.memoryUsage()`、连续 `cpuUsage()` 差值、`os.loadavg()`、网关事件循环采样器、uplink 服务端已接受的 WebSocket 数、registry 在线链路数 | `loadAvg` 平台不支持时为 `null`；CPU 首个样本为 `null` |
| `totals.bytesIn / bytesOut` | `RelayMetering` 累计 | `bytesIn` 为从成员收到的字节，`bytesOut` 为发给成员的字节；同一份中转数据两侧各计一次（与落库口径一致） |
| `totals.*PerSec` | 相邻样本累计值之差 / 间隔 | 累计值回绕视为计数器复位，从 0 起算 |
| `totals.framesIn/OutPerSec` | `LinkMux.stats()`（在线链路之和 + 已移除链路折入的 `retired` 累计） | 链路关闭或替换不会让速率跌成 0 |
| `members[].rttMs / connectedAt / reconnects / activeStreams / bytes*PerSec` | uplink 服务端 ping 时间戳、registry 记账、stream router 记账 | 等待 pong 期间不再重发 ping，RTT 对应原始 ping；吊销成员与删除租户时清理记账 |
| `tenants[].pack.sizeBytes / updatedAt` | `relay_tenants.sealed_pack` 与新列 `sealed_pack_updated_at`（迁移 0046） | 根轮换时清空时间戳 |

响应不含令牌哈希、密钥、密封包内容与 key-log 原文。

## 前端

- `packages/ui`：`Sparkline`（内联 SVG，多序列共享刻度，空/常量序列安全）、`StatTile`（`Card size="sm"`，标签可换行、数值不截断、折线槽位可压缩并在窄屏隐藏）。
- `apps/fe/src/pages/settings/relay/relay-metrics-store.ts`：页面可见时每 5 s 轮询，隐藏/卸载停止；401/404 进入 `unauthorized`/`unavailable` 后停止轮询，重新挂载或点重试才再探测。
- 本机卡片「中继服务」段：4 + 3 个精简瓦片（在线节点、活跃流、吞吐、延迟；内存、CPU、运行时长）。
- 「中继」设置 tab：12 个瓦片分「流量 / 进程」两组（窄屏两列、`lg` 三列、`2xl` 六列），趋势卡三条 5 分钟折线（吞吐、活跃流、事件循环延迟），成员表（RTT、流、速率、重连、接入时间）。

## 验收

- `cd apps/gateway && bun test src/relay`：含采集器（速率、环形缓冲、CPU 占比、链路移除/替换、新成员首窗口、计数复位）、心跳 RTT、记账清理、路由鉴权。
- 临时 `relay,node` 实例接入自身中继后，`/api/relay/metrics` 报告 `membersOnline=1`、`authenticatedLinks=1`、帧速率约 0.8/s（心跳）。

## 注意事项

- 生产链路是 `WebSocketLink`，已公开 `stats()`；新增链路类型需同样实现，否则帧计数缺失。
- 新建的 `relay,node` 在接入自身中继前，`/api/mesh/relay/status` 返回 `mode: "hub"`（既有行为），前端按角色而非该字段决定文案。
