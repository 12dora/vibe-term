# 多节点通知汇聚（notification sink）

## 背景

通知在 tmex 里一直是**严格按机器**发的：`EventNotifier`（`apps/gateway/src/events/index.ts`）
把事件扇出给 webhook / telegram / 微信 / ws 广播四个渠道，四者读的全是**本机**表。
hub 只复制节点表、证书和密钥日志，通知配置不在其中。结果是 hub A + 节点 B/C 的部署里，
用户只在 A 上配了 bot，就永远收不到 B/C 的响铃、watch 命中和设备掉线。
（审计详见 `prompt-archives/2026090603-round31-mesh-notifications/sub/EX6-notifications-mesh-report.md`）

唯一的例外是远端 agent 会话：它由**发起机**的 `AgentSupervisor` 拥有，`agent_*` 事件走发起机
的渠道，并在 `payload.nodeId/nodeName` 上打了来源节点；`events/channels/pane-url.ts` 据此把深链
拼成 `<站点>/n/<nodeId>/devices/...`，`notification-format.ts` 据此多打一行「节点：<名>」。
本轮做的就是把这套已有的「带节点标记的事件」能力推广到所有事件。

## 目标

- 任意一台或多台机器可以打开「接收其它节点的通知」，成为**汇聚机**（sink）。
- 其余节点把本机产生的事件转发给每一台汇聚机（不含自己），由汇聚机用**它自己**的渠道发出去，
  文案带节点名、深链带 `/n/<nodeId>`。
- 各节点本地行为不变：自己配了渠道的照常自己发。
- 汇聚机短时离线不丢事件（有界补发），长时离线不堆内存。

## 设计

### 汇聚声明的广播

汇聚开关是**节点自述的元数据**，搭 `node.status` 的 `inventory` 便车广播：

```
inventory = { version: "1.1.36", notifySink: true }   // 关闭时不带该键
```

链路与落地（三条都已存在，本轮没有新增协议帧）：

| 拓扑 | 上行 | 落到对端哪里 |
| --- | --- | --- |
| hub 模式 | `node.status` → hub | hub `user_nodes.inventory_json`；hub 再经 `node.list` 广播给全部节点，节点写 `peer_cache.inventory_json` |
| 中继模式 | `relay.status`（K_meta 封装的状态块） | 对端解封后写 `peer_cache.inventory_json` |
| 直连对端 | `peer.status` | `peer_cache.inventory_json`（`peer-status-sync.ts`） |

因此**不需要新表、不需要迁移**：汇聚集合本来就随节点列表持久化在 `peer_cache` /
`user_nodes` 里，重启后立刻可用。本机开关自己存 `gateway_kv`（键
`mesh.notification.sink.enabled`，见 `mesh/notification-sink-state.ts`），进程内缓存一份，
`statusProvider()` 每次心跳读它做 `jsonStable` 比对。

开关翻转后立即 `uplink.sendStatusIfChanged()` + `peerManager.refreshAdvertisedStatus()`，
不等心跳。

`mesh/notification-sink-set.ts` 把三处来源归并成 `MeshNotificationSink[]`，判据是
**取最新的一次权威观测**，不是「任一为真」：

1. `peer_cache` 有行就以它为准——它由上行 `node.list`、中继状态块与直连 `peer.status`
   共同刷新，是最全的一路；
2. `peer_cache` 与 hub 侧 `user_nodes` 行同时存在时，比两者的 `last_seen_at`，取新的那一路；
3. `peer_cache` 没有该节点才退回 `node.list` 广播，再没有才退回 `user_nodes` 行。

取「或」会漏掉「关」：节点在上行中断期间通过直连撤销声明后，陈旧的那一路仍为真，
事件会继续往一台已经不再接收的机器上发（round31 审查项 F2）。

> **未采用密钥日志记录**：`rename-node` 那类记录的签名者只能是 root 或 passkey
> （`KEY_LOG_SIGNER_MATRIX`），节点自身没有签名能力，一个设置开关每次都要用户输密码
> 或过 passkey 不可接受，`PUT /api/notifications/mesh` 也无从签起。改名在 hub 模式下同样
> 不走密钥日志（走 hub 控制面），`rename-node` 只是中继模式没有控制面时的补位。
> 代价见「安全边界」。

### 节点侧转发

内置渠道 `mesh-forward`（`events/channels/mesh-forward.ts`）注册进 `EventNotifier`，
与其它渠道并列扇出，因此本地渠道行为完全不变。

不转发的两类事件（判据只有一条：`payload.nodeId` 非空即不转发）：

1. 发起机代远端 agent 会话上报的 `agent_*` —— 汇聚机本来就会从发起机收到那一份，转发会重复；
2. 本机作为汇聚机刚收下的转发件 —— 再转一次会在多汇聚机之间成环。

投递走 `Forwarder.forwardInternalHttp()`（对端链路 + 对端标记，与远端 agent 调
`/api/mesh-internal/tmux/*` 同一条路）：

```
POST /api/mesh-internal/notifications
{
  "eventType": "terminal_bell",
  "event": { site, device, tmux?, payload? },   // 不含 eventType / timestamp
  "origin": { "nodeId": "<hex>", "nodeName": "B 机" }   // nodeName 仅供日志，汇聚机不采信
}
```

回包：`202 Accepted`（已收下并入队扇出）。

### 队列策略

每台汇聚机一条独立队列（`events/mesh-forward-queue.ts` + `events/mesh-forwarder.ts`）：

- **合并**：入队按 `nodeId:deviceId:paneId:eventType` 合并，同身份只留最新一条；
- **上限**：20 条，超限丢最旧；
- **过期**：3 分钟，出队时丢弃；
- **退避**：单飞投递，失败按 1 / 2 / 4 / 8 s 重试，之后恒定 15 s 封顶；
- **截止时间**：单次投递 15 s（`MESH_FORWARD_DELIVER_TIMEOUT_MS`），到点 abort 在途请求并当作
  可重试失败，汇聚机卡死不会永久占住这条队列的单飞位；`AbortSignal` 一路传到
  `Forwarder.forwardInternalHttp()`；
- **回插溢出**：投递失败的那条回插队首时若队列已满，丢的是**这条最旧的**（记
  `reason=overflow`），不能反过来把队尾刚入队的新事件挤掉；
- **终止性失败**：汇聚机回 4xx（典型是开关已关的 404）直接丢弃不再重试，429 例外（当作可重试）；
- **生命周期**：队列被移出集合（`forget`）或 mesh 桥被替换/清空（`setMeshNotificationBridge`
  的变更回调 → `MeshForwardChannel.detach()`）后，定时器与在途投递一并取消，退休的运行时上
  不会再排队；
- **丢弃日志**：`[notify] forward dropped sink=<id> reason=overflow|expired|rejected ...`，
  超时另记 `[notify] forward timeout sink=<id> ...`；
- 计数经 `GET /api/notifications/mesh` 的 `forwardQueue` 下发。

### 汇聚机侧

`mesh/mesh-internal-notifications-routes.ts`，挂在 mesh-internal 总入口（`handleMeshInternalTmuxRequest`）下，
共用它的 `requirePeerMarker` 把关，逐条校验：

1. 本机开关没打开 → **404**（对端据此丢弃，不再重试）；
2. 没有对端标记，或来源不是本机认识的 mesh 节点（`getMeshAgentBridge().lookupNode()`）→ **403**；
3. 每来源节点每分钟 60 条（`TokenBucket`），超出 → **429**；桶表用 `IdleLruMap`
   （容量 1024、空闲 60 s 回收）管理：新来源只回收空闲桶或淘汰最久未用的一个，
   **不会 clear 整张表**——否则换 64 个来源就能把已经打满的来源重新放行；
4. `eventType` 必须在 `EventType` 联合内（`isEventType`，值比对而非 `in`，避免 `toString` 之类原型键混入），
   `device.id/name/type` 必填，`origin.nodeId` 必须与对端标记一致，`tmux` 按字段白名单裁剪 → 不合格 **400**。

落地时：

- `site` 换成**汇聚机自己的**站点名与 URL，深链才会是 `<汇聚机>/n/<来源节点>/devices/...`；
- `payload.nodeId` 用对端标记覆盖；`payload.nodeName` 由汇聚机**自己**按标记 id 查本机元数据
  （`mesh/notification-origin-name.ts`：`peer_cache.name` → `nodes.name`，查不到回落节点 id），
  body 里的 `origin.nodeName` 一律忽略——发送方不能决定汇聚机通知里显示的名字；
- 再调本机 `eventNotifier.notify()`，webhook / telegram / 微信 / ws 广播照常走；
- **不等扇出完成**：校验通过即入队并立刻回 **202 Accepted**（`void notify().catch(log)`），
  汇聚机上一个慢 webhook 不会把发送方的队列拖住；202 与 200 一样算投递成功。

### 节流键

`EventNotifier` 的响铃与通知节流键前面加了节点作用域（`eventThrottleScope`）：

```
<nodeId|local>:<deviceId>:<paneId>
```

否则 B 与 C 上同名的 `%1` 会互相压制。本机事件没有 `payload.nodeId`，统一记 `local`。

## 对外接口

| 端点 | 说明 |
| --- | --- |
| `GET /api/notifications/mesh` | 返回 `MeshNotificationState`：`supported`（无 mesh 时 false）、`selfEnabled`、`sinks[]`、`forwardQueue` |
| `PUT /api/notifications/mesh` | body `{ enabled: boolean }`，落库 + 立刻重播状态 + 广播设置变更，返回最新 `MeshNotificationState` |
| `POST /api/mesh-internal/notifications` | 节点→汇聚机内部投递，对端标记保护，浏览器不可达；成功回 202（已收下，扇出异步） |

设置变更广播命名空间：`notifications-mesh`（前端据此失效缓存）。
契约在 `packages/shared/src/contracts/mesh-notifications.ts`，客户端在
`packages/api-client/src/notifications-mesh.ts`。

## 安全边界

- 投递只走对端链路，标记由 `acceptHttpStream` 按**已认证的对端身份**写入，浏览器侧的
  `x-tmex-mesh-peer` 头在入口就被 `stripMeshPeerMarkerFromRequest` 剥掉，伪造不进来。
- 汇聚机独立判据：即便来源节点声称对方是汇聚机，只要本机开关没打开就回 404。
- 通知文案里的节点名由汇聚机按对端标记自己查，`origin.nodeName` 不采信：发送方伪造不了
  别人的名字，也塞不进任意文本。
- **已知取舍**：汇聚声明搭的是 `node.status`/`node.list` 便车，中继模式下状态块用 K_meta 封装，
  中继伪造不了；**hub 模式下一个被攻陷的 hub 可以给某个节点伪造 `notifySink: true`**，
  从而让其它节点把事件转发给它选定的**某台已入网节点**。影响面限于用户自己的机器之间
  （攻陷的 hub 本就能转发浏览器流量），且目标只能是已签发证书的节点，不能外流。
  如果后续要堵死，正解是把声明升级成节点自签的记录，而不是回到密钥日志。

## 限制

- standalone / 纯中继没有 mesh 桥，`supported=false`，前端不显示卡片。
- 汇聚机离线超过 3 分钟的事件不补发（有界队列的既定取舍）。
- 单次投递超过 15 s 视为失败重投：汇聚机侧已收下但回包丢了的极端情况会重复通知一次
  （事件本身幂等性由渠道侧节流兜底）。
- 202 只表示「汇聚机收下」，不表示 webhook / bot 已经发出去；扇出失败只在汇聚机侧留日志。
- 转发的是事件本身，不是渠道配置：汇聚机得自己配好 bot / webhook。
- 消息指令（round25）仍然只在本机执行，本轮不涉及。

## 验收

- 节点 B 的响铃 / watch 命中出现在汇聚机 A 的 webhook 与浏览器 toast 里，文案带「节点：B」，
  深链为 `<A 的站点>/n/<B>/devices/...`；
- A 离线 2 分钟内恢复，能收到合并后的补发；离线超过 3 分钟的丢弃并留日志；
- 纯 standalone 部署行为完全不变。
