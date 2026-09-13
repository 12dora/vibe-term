# 多节点通知汇聚（notification sink）

本文描述把其它节点的通知汇聚到一台或多台「汇聚机」的机制：用户签名的汇聚声明、节点侧转发与队列策略、汇聚机侧校验、接口、安全边界与兼容性；面向改动 `apps/gateway/src/events/mesh-*` 与 `mesh/notification-sink-*` 的开发者。

## 背景

通知在 VibeTerm 里一直是**严格按机器**发的：`EventNotifier`（`apps/gateway/src/events/index.ts`）
把事件扇出给 webhook / telegram / 微信 / ws 广播四个渠道，四者读的全是**本机**表。
hub 只复制节点表、证书和密钥日志，通知配置不在其中。结果是 hub A + 节点 B/C 的部署里，
用户只在 A 上配了 bot，就永远收不到 B/C 的响铃、watch 命中和设备掉线。

唯一的例外是远端 agent 会话：它由**发起机**的 `AgentSupervisor` 拥有，`agent_*` 事件走发起机
的渠道，并在 `payload.nodeId/nodeName` 上打了来源节点；`events/channels/pane-url.ts` 据此把深链
拼成 `<站点>/n/<nodeId>/devices/...`，`notification-format.ts` 据此多打一行「节点：<名>」。
通知汇聚把这套「带节点标记的事件」能力推广到所有事件。

## 目标

- 任意一台或多台机器可以打开「接收其它节点的通知」，成为**汇聚机**（sink）。
- 其余节点把本机产生的事件转发给每一台汇聚机（不含自己），由汇聚机用**它自己**的渠道发出去，
  文案带节点名、深链带 `/n/<nodeId>`。
- 各节点本地行为不变：自己配了渠道的照常自己发。
- 汇聚机短时离线不丢事件（有界补发），长时离线不堆内存。

## 设计

### 汇聚声明（用户签名记录）

汇聚声明是一条**用户签名的密钥日志记录**，不是节点自述的元数据：

```
type = notification-sink
payload = { node_id: 16 B, enabled: bool, at: u64 }   // packages/shared/src/auth/notification-sink-record.ts
signer = root | passkey                                // KEY_LOG_SIGNER_MATRIX
```

密钥日志本来就全网复制（hub 下发 / 中继同步 / join 回放同一条链），因此每台节点都能独立
回放出同一份汇聚集合：`mesh/notification-sink-records.ts` 按 `type='notification-sink'`
过滤、按 `seq` 递增回放，**同一节点后写的赢**（`enabled: false` 即撤销）。
**不需要新表**，只加了一条迁移 `0052_notification_sink_keylog.sql` 放宽 `user_key_log`
的类型 CHECK 约束。

浏览器侧翻转开关的动作（`pages/settings/notifications/mesh-sink-toggle.ts`）：

1. `useCredentialPrompt` 当场取一次密码 / 通行密钥（与 `rename-node` 同一套仪式）；
2. 取 head → 签 `notification-sink` → `POST /api/auth/keylog?hub=sync`；
3. 记录落地后才 `PUT /api/notifications/mesh` 翻本机开关。用户取消凭据交互时三步都不发生。

CLI 对齐同一条路径：`vibeterm settings notifications mesh set on|off` 先用 `VIBETERM_PASSWORD` 签 `notification-sink`（`hubAck` 失败不 PUT），成功后再 `PUT /api/notifications/mesh {enabled}`。见 [命令行使用手册](../operations/cli-usage.md)。

本机开关仍存 `gateway_kv`（键 `mesh.notification.sink.enabled`，见
`mesh/notification-sink-state.ts`），语义收窄为「这台机器现在收不收转发件」：

| 判据 | 谁说了算 | 作用 |
| --- | --- | --- |
| 用户签名声明 | 密钥日志（全网复制） | 别的节点要不要往这里转发 |
| 本机开关 | 本机 `gateway_kv` | 本机收到转发件后收不收（入站路由的 404 判据之一） |

`mesh/notification-sink-set.ts` 据此产出 `MeshNotificationSink[]`：远端节点只看声明，
本机要求「声明 + 开关」同时成立；`peer_cache` / `user_nodes` / `node.list` 三处只用来取显示名
与在线态，**inventory 里的 `notifySink` 已经删除，新版本一概不读**。
`collectMeshNotificationSinks` 跳过 entry 本机 `paused` 的远端汇聚机（self 不受 paused 影响）：暂停节点不收、也不往那边转发。

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
- **投递前复核声明**：每次投递（含每次重试）之前重新问一遍「这台还是签过名的汇聚机吗」，
  不是就地丢掉整条队列（`reason=unauthorized`）并 abort 在途请求；`notification-sink` 记录
  一落地，`key-log-projection` 立刻调 `pruneUnauthorizedSinks()` 收掉被撤销的队列。
  入队时通过不等于重试时仍然通过：被攻陷的汇聚机可以先让投递失败，等声明被撤销后再收下重试件；
- **生命周期**：队列被移出集合（`forget`）或 mesh 桥被替换/清空（`setMeshNotificationBridge`
  的变更回调 → `MeshForwardChannel.detach()`）后，定时器与在途投递一并取消，退休的运行时上
  不会再排队；
- **丢弃日志**：`[notify] forward dropped sink=<id> reason=overflow|expired|rejected ...`，
  超时另记 `[notify] forward timeout sink=<id> ...`；
- 计数经 `GET /api/notifications/mesh` 的 `forwardQueue` 下发。

### 汇聚机侧

`mesh/mesh-internal-notifications-routes.ts`，挂在 mesh-internal 总入口（`handleMeshInternalTmuxRequest`）下，
共用它的 `requirePeerMarker` 把关，逐条校验：

1. 用户没签过本机的 `notification-sink` 声明、或本机开关没打开 → **404**
   （对端据此丢弃，不再重试）；判据即 `MeshNotificationBridge.selfSinkEnabled()`；
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
| `GET /api/notifications/mesh` | 返回 `MeshNotificationState`：`supported`（无 mesh 时 false）、`selfNodeId`（前端签记录用）、`selfEnabled`、`sinks[]`、`forwardQueue` |
| `PUT /api/notifications/mesh` | body `{ enabled: boolean }`，只落本机开关 + 广播设置变更，返回最新 `MeshNotificationState`；汇聚声明由浏览器另签一条 `notification-sink` 记录 |
| `POST /api/auth/keylog?hub=sync` | 浏览器提交签好的 `notification-sink` 记录（与 `rename-node` 同一条路） |
| `POST /api/mesh-internal/notifications` | 节点→汇聚机内部投递，对端标记保护，浏览器不可达；成功回 202（已收下，扇出异步） |

设置变更广播命名空间：`notifications-mesh`（前端据此失效缓存）。
契约在 `packages/shared/src/contracts/mesh-notifications.ts`，客户端在
`packages/api-client/src/notifications-mesh.ts`。

## 安全边界

- 投递只走对端链路，标记由 `acceptHttpStream` 按**已认证的对端身份**写入，浏览器侧的
  `x-vibeterm-mesh-peer` 头在入口就被 `stripMeshPeerMarkerFromRequest` 剥掉，伪造不进来。
- 汇聚机独立判据：即便来源节点声称对方是汇聚机，只要本机没签过声明或开关没打开就回 404。
- 通知文案里的节点名由汇聚机按对端标记自己查，`origin.nodeName` 不采信：发送方伪造不了
  别人的名字，也塞不进任意文本。
- 汇聚集合只认用户签名的 `notification-sink` 记录：被攻陷的节点既不能自称汇聚机（自述的
  inventory 不再被读），也不能替别人撤销声明；被攻陷的 hub / 中继同样伪造不出记录——
  链是 prev_hash 串起来的，签名者只能是 root 或 passkey，改一条就整链验不过。
- 转发件的来源同样不可伪造：`origin.nodeId` 必须与已认证的对端标记一致，否则 400。
- 声明撤销即时生效于**发送侧**：队列每次投递前复核，桥的 `deliver()` 再兜一道（未授权就地
  回 403 不出网）。不能只靠汇聚机自己回 404——被攻陷的汇聚机不会拒收。

## 兼容性

- `notification-sink` 是新记录类型，旧版本节点解不开（`KeyLogType` 是 Borsh 枚举，
  `user_key_log` 还有类型 CHECK 约束），收到会卡住整条密钥日志。因此写入前走既有的版本门
  `KEYLOG_RECORD_COMPAT`：全网未吊销节点都 ≥ **1.1.39** 才允许写，否则
  `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`，卡片上提示「有节点版本低于 1.1.39，须先升级全部节点」。
  不允许 force 绕过。
- 版本门对**版本未知的成员**同样 fail closed（兼容规格里的 `failClosedUncached`，与
  `readmit-node` 同一档）：中继模式下 `peer_cache` 只覆盖握过手的对端，默认策略会跳过
  没进表的已入网节点——对这类记录跳过等于把那台离线老节点的密钥日志同步写死。
- 1.1.38 及更早的节点仍在 inventory 里发 `notifySink`，新版本一概忽略：混合版本的网络里，
  旧节点声明的汇聚身份对新节点无效（新节点不会往它转发），升级后由用户在设置里重新打开一次
  开关（签一条记录）即可恢复。旧节点自己仍按老逻辑读 inventory，看不到新记录，也不会因此出错。

## 限制

- standalone / 纯中继没有 mesh 桥，`supported=false`，前端不显示卡片。
- 汇聚机离线超过 3 分钟的事件不补发（有界队列的既定取舍）。
- 单次投递超过 15 s 视为失败重投：汇聚机侧已收下但回包丢了的极端情况会重复通知一次
  （事件本身幂等性由渠道侧节流兜底）。
- 202 只表示「汇聚机收下」，不表示 webhook / bot 已经发出去；扇出失败只在汇聚机侧留日志。
- 转发的是事件本身，不是渠道配置：汇聚机得自己配好 bot / webhook。
- 签名声明与本机开关理论上可能不一致（记录写成了、随后那次 `PUT` 没成）：此时别的节点照发，
  本机回 404 丢弃，其它节点的卡片仍把它列成汇聚机。再点一次开关即可对齐（记录是幂等的）。
- [消息指令](./messaging-commands.md)仍然只在本机执行。

## 验收行为

- 打开开关要过一次密码 / 通行密钥；取消则开关不动、记录不写；
- 节点 B 的响铃 / watch 命中出现在汇聚机 A 的 webhook 与浏览器 toast 里，文案带「节点：B」，
  深链为 `<A 的站点>/n/<B>/devices/...`；
- A 离线 2 分钟内恢复，能收到合并后的补发；离线超过 3 分钟的丢弃并留日志；
- 纯 standalone 部署行为完全不变。
