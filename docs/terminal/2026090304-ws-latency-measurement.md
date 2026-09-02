# 左上角延迟徽标的测量口径

## 徽标测的是什么

浏览器 ↔ **当前入口网关**的 WebSocket 心跳往返（Borsh `PING` / `PONG`）。这段链路包含浏览器事件循环、网络、网关事件循环与 PONG 编码，**不包含**入口节点到目标节点的 peer link，也不包含 hub 中继。所以在 mesh 里看到的这个数字与「终端按键到回显」的端到端延迟不是一回事；徽标 tooltip 里已经写明了这一点，并附带最近一次原始样本。

`≥ 200ms` 徽标变色。

## 客户端（`packages/ws-client`）

心跳间隔 5s（页面隐藏时 30s），PONG 超时按 cadence 配置。本轮修正三处：

- **nonce 关联**：`PING` 带随机 nonce，只有 nonce 匹配的 `PONG` 才算一次 RTT。错配 / 迟到的 PONG 不计延迟、不清理在途探测，也不当协议错误（不会因此断连）。
- **单个在途探测**：间隔 tick 时若已有未回的 PONG 就跳过，且**不覆盖** `lastPingSentAt`。改造前重叠探测会把上一次的发送时刻冲掉，是 200ms+ 假毛刺的主要来源。在途探测仍由原来的 pong-timeout 守活——错配帧不会给它续命。
- **中位数平滑**：`performance.now()` 计时（无 `performance` 时回退 `Date.now()`），取最近最多 5 个有效样本的中位数，四舍五入成整数。

对外字段：

| 字段 | 含义 |
| --- | --- |
| `wsLatencyMs` | 最近 ≤5 个样本的中位数（徽标显示这个） |
| `wsLatencyRawMs` | 最新一次匹配成功的样本（tooltip 显示这个） |

transport 事件为 `{ type: 'latency', latencyMs, rawMs }`，`GatewayTransport.latencyRawMs` 与 `latencyMs` 并列且必填（自建 FakeTransport 的地方要补一行）。重连或离开 READY 时 store 把两个字段清成 `null`，客户端平滑窗口一并重置。

## 网关（`apps/gateway/src/ws`）

`handlePing` 编好 `PONG` 后走 `WebSocketSendGuard.sendPriorityFrames()`：直接 `carrier.send()`，**不**经过终端输出的 `canSend` / 丢帧 / stream gap 标记。改造前 PONG 和终端输出挤同一条队列，背压时会被延后甚至丢掉，测出来的是队列深度而不是链路延迟。

发送路径按 socket 缓冲分类记账：`bufferedAmount() < 64 KiB`（`GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES`）且 guard 不处于背压 → 记 `bypassed`；否则仍然发送，但记 `queued`。

30s 聚合一条日志，没有 per-probe 日志：

```
[ws-metrics] ping probes=… server_handle_ms_p50=… server_handle_ms_max=… \
  bypassed=… queued=… buffered_max_bytes=… event_loop_lag_ms=…
```

`server_handle_ms` 是「收到 PING 到把 PONG 交给 socket」的服务端耗时，`event_loop_lag_ms` 取自已有的事件循环滞后采样。

## 排查毛刺

按这条日志分三种情况看：

| 现象 | 判断 |
| --- | --- |
| `server_handle_ms_p50/max` 高 | 网关事件循环被占住（对照 `event_loop_lag_ms` 与 `[ws-metrics]` 的终端输出行）；不是网络问题 |
| `queued` 占比高、`buffered_max_bytes` 大 | 该连接正在背压，终端输出把 socket 塞满；徽标数字里含排队时间 |
| 服务端两项都低、徽标仍高 | 真在网络或浏览器侧；对比 tooltip 里的原始样本与中位数，抖动大说明链路不稳而非整体变慢 |

徽标只反映浏览器到入口的那一段。怀疑 mesh 链路慢时看节点的 `transport`（`dc` / `ws-secure` / `relay`）与 `[mesh][rtc]` / `[mesh][peer]` 日志，不要用这个数字下结论。
