# 直连信令代次、链路活性与在途流保护（1.1.31）

## 背景

生产 hub 日志反复出现 `[mesh][rtc] dial failed reason=datachannel open timeout` 与 `Unexpected remote answer description in signaling state stable`，熔断器升到 level 3/4（240 s / 480 s 冷却）后再也回不来。经中继推送 13 MB 升级包时收到 `rst recv reason=relay-rst` 导致整次升级失败。round 28 探索（`prompt-archives/2026090502-round28-net-perf-smell/sub/EX1、EX3`）定位到两组根因。

## 根因

1. **陈旧信令重放**：`rtcSession = dc:<lo>:<hi>` 对同一对节点恒定、无代次；offerer 拨号失败后注销监听，answerer 仍按 5/15/30/60 s 重试产生新 answer，这些 answer 进入 `rtcInbox`（无 TTL、不按类型过滤）；冷却结束后新 PeerConnection 在 `bindSignaling` 时同步重放 inbox，把 answer 打在 `stable` 状态的 PC 上抛错。并发变体：同一次尝试收到两个 answer，第二个被吞掉，PC 绑错 ufrag → 15 s 后 `datachannel open timeout`。
2. **双泄漏**：`bindSignaling` 在 try 之外，抛错时 `untrackAndClose` 不执行；`signalingFor.onMessage` 在 `set.add` 后重放抛错导致 `unsub` 未赋值，监听器永久残留并自我放大。
3. **保活饥饿与在途流无保护**：大上传把外层 1 MiB 窗口打满，内层 ctl ping 被 DATA 队头阻塞，45 s 后 `dropPeer('missed-pong')`；`dropPeer`、`UplinkPool.retireClient`、`considerNearestSwitch`、`reconfigureUplinkPool` 全部无视在途流；中继心跳也在节点忙于写盘时判死。

## 设计

### 信令

- SDP / candidate 的 JSON 信封新增可选 `epoch`（offerer 每次拨号生成，answerer 从 offer 回显）；`rtcSession` 字符串不变（hub 路由按 `dc:<a>:<b>` 解析）。收到 `epoch` 已定义且不匹配的消息直接丢弃；`epoch` 未定义视为旧节点，退回按类型过滤。
- `bindSignaling` 带 `expect: 'offer' | 'answer'`，错类型丢弃，offerer 每次尝试只应用一个 answer；`setRemoteDescription` / `addRemoteCandidate` 各自 try/catch 记 `signal dropped`。
- `bindSignaling` 与 `trackPc` 纳入 `connectToPeer` 统一清理区；inbox 重放走 microtask 且先返回 unsubscribe；inbox 条目带 `receivedAt`，30 s 过期；offerer 无监听时不缓存 answer，无尝试时不缓存 candidate。
- 测试假件 `FakePeerConnection` 实现 `stable / have-local-offer / have-remote-offer` 状态机并复现 libdatachannel 的异常。

### ICE / 拨号

- `buildRtcIceConfig`：`enableIceTcp`、`enableIceUdpMux`、`mtu: 1200`；`peerBindHost` 为单一具体地址时写入 `bindAddress`；`TMEX_RTC_PORT_RANGE=begin-end` 映射端口范围（node-datachannel 0.33 无网卡过滤 API，未做接口过滤）。
- `connectToPeer` 四阶段共用一个 15 s deadline；`waitLocalFingerprint` 改回调扇出。
- 熔断器 `skipKinds` 排除本地信令状态错误；到达永久禁用阈值后每 10 min 允许一次 `forceProbe`。
- 按 peer 聚合候选对类型的成功/失败与拨号耗时，`[mesh][rtc] summary` 每 peer 最多 60 s 一条。

### 活性与在途流

- ws-secure / relay 链路 ping 5 s × 3 次；`LinkMux.lastFrameAt` 让任意入站帧重置漏计。
- `dropPeer` 的 `missed-pong` / `idle` 在 `live.streams > 0` 时走退休宽限（保留原因），`revoked` / `stopped` 仍立即关闭。
- relay client / pool 双层追踪在途隧道流；就近切换、回切、reconfigure 等待排空（每 3 s 复查，10 min 硬上限）；`retireClient` 停止接新流并排空后再 `stop()`；死链仍立即处理。
- 中继 registry 记录 `lastByteAt`，心跳期间有流量不累加 miss；令牌桶按逻辑流独立排队、4 KiB quantum 轮转，≤ 4 KiB 帧走优先通道；`pumpMetered` 单向失败先 half-close，RST 原因细化为 `relay-rst:src-read` / `relay-rst:dst-write` / `relay-rst:peer-abort`（保留 `relay-rst` 前缀）。
- 发送分片 16 KiB（接收上限仍 64 KiB，向后兼容）；`MAX_LINK_UNACKED` 提到 65 × 1 MiB 覆盖默认 64 条中继流。
- forwarder failover 退避追加 3200 / 6400 ms（总预算约 15 s）。

## 兼容性

- 旧节点（≤ 1.1.30）省略 `epoch`，新节点退回类型过滤；ping / pong 载荷不变，只是新节点发送周期缩短；RST 原因保持前缀；分片只降发送端。

## 风险

- `MAX_LINK_UNACKED` 提高意味着单 mux 最坏内存占用上升，是不误关满窗口中继流的直接代价。
- 排空 10 min 上限到期时剩余流会被 reset。
- 尚无真实公网 NAT / ICE-TCP / 端口范围集成测试，仅 fake / memory transport。

## 相关

`docs/hub/2026090306-rtc-dial-breaker.md`、`docs/hub/2026090305-peer-endpoint-backoff.md`。
