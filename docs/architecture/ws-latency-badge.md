# 延迟徽标的测量口径

本文说明终端页那枚延迟徽标测的是哪一段链路、客户端与网关如何测量与平滑，以及如何用
`[ws-metrics] ping` 日志区分毛刺来源；面向排查「延迟高」的运维与开发者。

## 唯一一枚徽标

全站只有终端页头部右上角这一枚延迟徽标（`apps/fe/src/node/device-node-badges.tsx`），量的是
**浏览器 → 该设备 tmux 宿主**的整条链路往返，`≥ 200ms` 变色。它在 `NodeRuntimeBoundary` 之内，
按路由的 node 与 deviceId 取值。侧边栏顶部那枚只覆盖「浏览器 ↔ 入口网关」一段的徽标已下线：
它与终端页徽标的第一段是同一个数，两枚并排只会让人误以为在量两条不同的链路。

## 终端页徽标：两段相加

数字 = **浏览器 → node** + **node → tmux**。

- **浏览器 → node**：该 node 自己那条 Gateway WS 的心跳中位数（`wsLatencyMs`）。远端 node 的 WS
  由入口按字节转发、由**拥有该设备的 node** 终结，所以这一段已经含了 entry 转发、peer link 与
  中继在内的每一跳；浏览器直连（WebRTC）接管后 PING 走 DataChannel，量的仍是当前那条真实路径。
- **node → tmux**：拥有该设备的网关自己测的宿主一跳（本地 tmux 或经 SSH），见下节。测不到时
  只显示前一段，浮层里写明「未测量」。

标签只说这条链路怎么走：`本机` / `直连` / `局域网` / `公网` / `中转`，取值同 `/api/mesh/nodes`
的 `reach` 与浏览器直连诊断。`self`（入口自身）同样出徽标——它只是没有第二跳。

点开浮层按跳拆开：浏览器 → 节点、节点 → tmux、最近一次样本（两段原始样本之和），再列这条链路的
现场：到达路径、承载、entry ↔ node 的 peer ping（不再是头条，但排查「慢在哪一跳」要看）、已连接
时长、对端 / 中转地址、ICE 明细与未直连原因。

浮层用 `createPortal` 挂到 `document.body` 并按 `position: fixed` 定位（`device-node-badges-placement.tsx`）：
手机上量的必须是**视觉**视口（`window.visualViewport`）——地址栏收起、键盘弹出、双指缩放之后
布局视口和看得见的那块不是一回事。测量完才渲染（先渲染会在 body 左上角闪一帧），双向夹回视口，
内容过高时卡片自己滚动（`maxHeight` + `overscroll-contain`），下方放不下就翻到徽标上方。
拿不到测量结果时退回「贴徽标右对齐、固定 288px」的 absolute 老样子。

## 宿主一跳：`DEVICE_LATENCY`

- wire：`KIND_DEVICE_LATENCY = 0x0106`，载荷 `DeviceLatencySchema { deviceId, rttMs, rawMs,
  hop, sampledAt }`（`packages/shared/src/ws-borsh/schema.ts`）。`hop` 为 `0` 本地 / `1` SSH。
- 谁发：拥有该设备的网关按 tmux 控制模式回执测得并平滑，材料性变化（≥10 ms 或 ≥20%，且 |Δ| ≥ 2 ms，两次下发间隔 ≥5 s）立即下发；有会话连着时即使没有新样本也会每 15 s 重发最近一次估计，避免健康设备因采样空隙被客户端判过期。
- 谁认：网关在 HELLO_S2C 里播报能力 `device-latency-v1`（`GATEWAY_CAPABILITY_DEVICE_LATENCY_V1`）。
  没播报的旧节点永远不发这条帧，UI 把这一段显示成「未测量（节点版本过旧）」，而不是当成 0。
- 客户端：`packages/ws-client/src/transport-message-decoder.ts` 解出
  `{ type: 'device-latency', deviceId, rttMs, rawMs, hop: 'local' | 'ssh', sampledAt }`；
  `packages/stores/src/tmux-event-router.ts` 落到 store 的 `deviceLatency[deviceId]`，能力落到
  `deviceLatencySupported`，并在收到时本地盖一个 `receivedAt`。读数不变的帧也要落地（`receivedAt`
  是判断「这一跳还在不在上报」的唯一依据）；`sampledAt` 更早的乱序帧一律丢，采样时刻相同且读数
  也相同的重复帧不写 store。离开 READY 与设备断开时把读数和能力位一并清掉，READY 时按新一轮
  HELLO 重判——否则重连到旧节点会一直等一个永远不来的帧。
- 过期：`HOST_HOP_STALE_MS = 45 s`（3 倍下发间隔），比的是 **`receivedAt` 与浏览器当前时刻**。
  网关停播、设备静默掉线都不会有 `device-disconnected`，超过这条线徽标就不再加这一跳，浮层写
  「已停止上报」。**不拿 `sampledAt` 判新鲜**：两端时钟未必对齐，用网关时刻减浏览器时刻会把
  时钟慢几分钟的节点永远判死；`sampledAt` 只用于排序与展示。徽标按 `receivedAt` 算出的过期时刻
  排一次性定时器，收起状态下不做周期 tick。

## 客户端心跳（`packages/ws-client`）

网关在 HELLO_S2C 里给 `heartbeatIntervalMs: 15000`，客户端按 `[5s, 30s]` 夹取后采用，缺省超时按
`timeout/interval`（2×）跟随；页面隐藏时固定 30 s / 30 s。三条测量规则：

- **nonce 关联**：`PING` 带随机 nonce，只有 nonce 匹配的 `PONG` 才算一次 RTT。错配 / 迟到的 PONG
  不计延迟、不清理在途探测，也不当协议错误（不会因此断连）。
- **单个在途探测**：间隔 tick 时若已有未回的 PONG 就跳过，且**不覆盖** `lastPingSentAt`。重叠探测
  会把上一次的发送时刻冲掉，是 200ms+ 假毛刺的主要来源。在途探测仍由 pong-timeout 守活——错配帧
  不会给它续命。
- **中位数平滑**：`performance.now()` 计时（无 `performance` 时回退 `Date.now()`），取最近最多 5 个
  有效样本的中位数，四舍五入成整数。

对外字段：

| 字段 | 含义 |
| --- | --- |
| `wsLatencyMs` | 最近 ≤5 个样本的中位数（徽标第一段用它） |
| `wsLatencyRawMs` | 最新一次匹配成功的样本（浮层 / 气泡显示这个） |
| `deviceLatency[deviceId]` | 宿主一跳：`{ rttMs, rawMs, hop, sampledAt }` |
| `deviceLatencySupported` | 该 node 是否播报 `device-latency-v1` |

transport 事件为 `{ type: 'latency', latencyMs, rawMs }`，`GatewayTransport.latencyRawMs` 与
`latencyMs` 并列且必填（自建 FakeTransport 的地方要补一行）。重连或离开 READY 时 store 把两个字段
清成 `null`，客户端平滑窗口一并重置。

## 网关（`apps/gateway/src/ws`）

`handlePing` 编好 `PONG` 后走 `WebSocketSendGuard.sendPriorityFrames()`：载体实现了 `sendPriority`
就走优先通道，否则退回 `carrier.send()`；两条路都**不**经过终端输出的 `canSend` / 丢帧 / stream gap
标记。否则 PONG 和终端输出挤同一条队列，背压时会被延后甚至丢掉，测出来的是队列深度而不是链路延迟。

发送路径按 socket 缓冲分类记账：`bufferedAmount() < 64 KiB`（`GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES`）
且 guard 不处于背压 → 记 `bypassed`；否则仍然发送，但记 `queued`。

30s 聚合一条日志，没有 per-probe 日志：

```
[ws-metrics] ping probes=… server_handle_ms_p50=… server_handle_ms_max=… \
  bypassed=… queued=… buffered_max_bytes=… event_loop_lag_ms=…
```

`server_handle_ms` 是「收到 PING 到把 PONG 交给 socket」的服务端耗时，`event_loop_lag_ms` 取自已有的
事件循环滞后采样。

### 转发会话的优先通道与在途上限

远端 node 的浏览器 socket 终结在**拥有设备的 node**，回程走 mesh 流（`LinkStreamCarrier`）。这条路上
PONG / `DEVICE_LATENCY` 同样要插队，否则徽标量的是转发队列深度：

- **优先通道**：`LinkStreamCarrier.sendPriority()` 走独立的有界队列（16 帧 / 64 KiB，满了返回
  `rejected`），并以 `write(bytes, { priority: true })` 交给 mux——优先写有自己的写链，不排在普通写
  后面，还能动用每流 16 KiB 的预留发送信用（`PRIORITY_SEND_RESERVE`，普通写永不占用）。预留纯粹是
  发送侧策略，线格式与对端窗口记账都不变，和旧版本节点互通。插队只发生在**消息与消息之间**：一条
  被切成多片的大消息在片与片之间持有分片闸门，优先帧不会挤进分片中间。
- **在途上限**：`bufferedAmount()` 返回「载体队列 + 已交给 mux 但对端尚未回信用的字节」，高水位默认
  **256 KiB**（`VIBETERM_LINK_STREAM_INFLIGHT_BYTES`，最低 32 KiB），跌回一半才触发 `onDrain`。此前
  只看载体队列、上限 1 MiB，叠上 mux 的 1 MiB 窗口后每条转发会话能囤 2 MiB，慢上行时等于给每个 PONG
  前面排上几百毫秒。压到 256 KiB 是拿输出完整性换交互延迟：超限走 guard 既有的丢帧 → stream gap →
  canonical 回放这条降级路径。`INITIAL_STREAM_WINDOW` / `MAX_DATA_SEND_PAYLOAD` 保持不变，文件传输与
  端口映射仍要高 BDP 下的吞吐；预留信用也只在 ws 转发流上按需 arm（`reservePriorityCredit()`）。
- **`DEVICE_LATENCY`**：载体有优先通道时，背压中的会话也照发（这帧不到 64 字节，正是队列积压时必须
  挤出去的那一帧）；没有优先通道的浏览器直连 socket 仍然跳过。
- 基准见 `apps/gateway/src/mesh/link-stream-priority-latency.test.ts`：限速 4096 B/ms、单向 15 ms 的
  假链路上灌满终端输出后插一帧 PONG，改前约 150–180 ms，改后约 20 ms。

## REST 期限与 EWMA

同一个连接上的 REST 客户端（`packages/api-client` 的 `ApiClient`）也在观测延迟：每次请求按实测耗时
更新一条 EWMA（α = 0.2），调用方没给 `signal` 时挂 `AbortSignal.timeout(clamp(8×EWMA, 8 s, 45 s))`，
转发路径（`/n/<id>/`）再 ×1.5；长流（NDJSON、上传下载）用 `timeout: false` 或自带 signal 跳过这层期限。它与徽标的 WS 样本各测各的（一个是应用层 PING/PONG，一个是 HTTP
往返），但都能用来判断「这条链路整体有多慢」；会话探测的期限 `clamp(8×EWMA, 8 s, 30 s)` 用的就是这条 EWMA。

## 排查毛刺

先看终端页浮层是哪一跳大：

| 现象 | 判断 |
| --- | --- |
| 节点 → tmux 大 | tmux server 或 SSH 那一段慢：查设备所在机器的负载，SSH 设备还要查中间链路 |
| 浏览器 → 节点 大、peer ping 小 | 慢在浏览器到入口这一段，或入口自身；按下表继续 |
| 浏览器 → 节点 与 peer ping 一起大 | 慢在 entry ↔ node：看该节点的 `transport`（`dc` / `ws-secure` / `relay`）与 `[mesh][rtc]` / `[mesh][peer]` 日志 |

浏览器 ↔ 入口这一段再按 `[ws-metrics] ping` 分三种情况：

| 现象 | 判断 |
| --- | --- |
| `server_handle_ms_p50/max` 高 | 网关事件循环被占住（对照 `event_loop_lag_ms` 与 `[ws-metrics]` 的终端输出行）；不是网络问题 |
| `queued` 占比高、`buffered_max_bytes` 大 | 该连接正在背压，终端输出把 socket 塞满；徽标数字里含排队时间 |
| 服务端两项都低、徽标仍高 | 真在网络或浏览器侧；对比最近一次样本与中位数，抖动大说明链路不稳而非整体变慢 |

同一窗口还会按 `carrier.logContext.kind` 各打一行 `[ws-metrics] ping kind=…`（`physical_browser_ws` / `mesh_link_stream` / `webrtc_dc`），字段与聚合行相同但不带 `event_loop_lag_ms`。入口同时服务浏览器套接字与转发 mesh 会话时，用 kind 行判断是哪一种被 queued。
