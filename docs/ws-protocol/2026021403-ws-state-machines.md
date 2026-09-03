# ws-borsh-v1 状态机设计（Gateway + FE）

> 状态：**已实现**。本文是当前行为的规范说明，不是待办设计稿。
>
> 目标：用明确状态机替代分散的隐式逻辑，保证 pane 切换、history/live 合并、resize、bell 的确定性。
>
> 代码索引：
>
> | 状态机 | 实现 |
> | --- | --- |
> | WS 连接 / 重连 / 心跳（FE） | `packages/ws-client/src/{connection,reconnect-controller,heartbeat-controller}.ts` |
> | canonical 状态流客户端（FE） | `packages/ws-client/src/canonical-state-client.ts`、`pane-sink-registry.ts`、`canonical-size-epochs.ts` |
> | 设备连接 entry（Gateway） | `apps/gateway/src/ws/device-connection-registry.ts` |
> | canonical feed（Gateway） | `apps/gateway/src/ws/canonical-feed-session.ts`、`apps/gateway/src/ws/canonical/` |
>
> **1.1.23 起 legacy 状态流整体下线**：`SWITCH_ACK` / `TERM_HISTORY` / `LIVE_RESUME` / `TERM_OUTPUT` /
> `STATE_SNAPSHOT(_DIFF)` / `TERM_RESIZE` / `TERM_SYNC_SIZE` / `TMUX_FETCH_PANE_HISTORY` 全部删除，
> 对应的 `SelectStateMachine`、`pane-history-gate`、`SwitchBarrier` 也一并删除。对端不满足
> canonical v1.1 门槛（能力 `canonical-state-v1.1` + 版本 ≥ 1.1.22）时**不回退**，直接判定
> `stateFeedMode = 'unsupported'` 并提示用户升级。切换语义见
> `docs/terminal/2026021404-terminal-switch-barrier-design.md`。

## 设计原则

- **显式状态**：所有跨消息的流程（切换/缓冲/历史）必须有状态与 token。
- **不变量优先**：先定义必须成立的规则，再写实现。
- **超时与降级**：任何流程都必须有超时兜底，避免卡死。
- **幂等与去重**：重复消息不产生副作用；过期 token 一律丢弃。

## 全局不变量（必须满足）

1. 每个 pane 的画面基线只能由 canonical 首屏事务（`ScreenBegin → ScreenChunk* → ScreenCommit`）建立；
   没有基线的流中片段一律丢弃，不缓冲等待。
2. `SetPaneSubscriptions` 是集合替换；`SubscriptionApplied` 的 `generation` 单调递增，收到更旧的
   generation 必须幂等忽略。
3. pane 字节流按 `(paneEpoch, terminalSeq)` 对账；不连续时由服务端发 `SourceGap`，客户端重取整屏，
   不允许静默拼接。
4. resize 以浏览器视口为源（FE），Gateway 仅做同步与 tmux client/pty 对齐；两类几何语义由
   `ResizePaneV11.geometryReason` 区分。
5. bell 去重与频控必须在 Gateway 统一，FE 仅展示。

---

## 1) WS 连接状态机（FE）

### 状态

- `IDLE`
- `WS_CONNECTING`
- `HELLO_NEGOTIATING`
- `READY`
- `RECONNECT_BACKOFF`
- `CLOSED`

状态枚举即 `ConnectionState`（`packages/ws-client/src/client.ts`）。

### 事件（无独立事件枚举，均为回调 / 方法）

- `BorshWebSocketClient.connect()`
- `socket.onopen` -> `sendHello()`
- `ProtocolDispatcher.onHello` -> `handleHelloNegotiated(hello)`
- `socket.onerror` -> `handleError()`、`socket.onclose` -> `handleClose()`
- `ReconnectController.schedule()` 的退避定时器到期 -> `onReconnect` -> `connect()`
- `BorshWebSocketClient.disconnect()`

### 转移

- `IDLE -> WS_CONNECTING`：调用 `connect()`。
- `WS_CONNECTING -> HELLO_NEGOTIATING`：`socket.onopen` 里 `sendHello()` 发出 `HELLO_C2S`。
- `HELLO_NEGOTIATING -> READY`：`handleHelloNegotiated()` 收下 `HELLO_S2C` 的协商结果。
- `READY -> RECONNECT_BACKOFF`：`handleClose()` 且 `reconnector.canRetry()`。
- `RECONNECT_BACKOFF -> WS_CONNECTING`：退避定时器到期回调 `connect()`。
- 任意状态 `-> CLOSED`：`disconnect()`，或重试次数用尽后由 `handleClose()` 置位。

### 超时

- 没有独立的 HELLO 超时定时器：`HELLO_S2C` 解码失败走 `onHelloFailure`，其余情况靠 socket 关闭与心跳兜底。
- 心跳 PONG 超时（`HeartbeatController`，缺省 10s，页面隐藏时 60s）直接 `ws.close()`，随后按 `handleClose()` 进入退避。
- 退避为指数退避（基数 `reconnectDelayMs` 1s，上限 30s）；尝试次数超过 `maxReconnectAttempts`（缺省 5）后置 `CLOSED`。

### 关键实现点

- `seq` 在单条 ws 连接内单调递增；重连后从 1 重置。
- READY 前的业务消息进入队列缓存，READY 后 flush。

---

## 2) 设备连接状态机（FE，按 deviceId）

### 状态

- `DETACHED`
- `CONNECTING`
- `CONNECTED`
- `FAILED`
- `DISCONNECTING`

### 转移

- `DETACHED -> CONNECTING`：发 `DEVICE_CONNECT`。
- `CONNECTING -> CONNECTED`：收 `DEVICE_CONNECTED`。
- `CONNECTING/CONNECTED -> FAILED`：收 `DEVICE_EVENT(error)`。
- `CONNECTED -> DISCONNECTING`：发 `DEVICE_DISCONNECT`。
- `DISCONNECTING -> DETACHED`：收 `DEVICE_DISCONNECTED`。

### 关键实现点

- FAILED 状态下允许用户重试 connect（回到 CONNECTING）。

---

## 3) Pane 画面重建（FE，按 deviceId+paneId）

> legacy 的「选择事务状态机」（`SELECTING/ACKED/HISTORY_APPLIED/LIVE/SELECT_FAILED` + selectToken 对账）
> 已于 1.1.23 删除。切 pane 不再有屏障帧，画面重建完全由 canonical 首屏事务承担。

### 流程

1. pane 挂载 → `mountPane()` 把它加进订阅集合 → 发 `SetPaneSubscriptions(generation, active, hot)`。
2. 发 `RequestScreen(requestId, pane, byteLimit)`。
3. 收 `ScreenBegin(requestId, paneEpoch, baseSeq, rows, cols, modes, totalBytes)`
   → `ScreenChunk(requestId, offset, data)*` → `ScreenCommit(requestId, totalBytes, historyCursor)`。
   Commit 才整屏重写终端（`writeCanonicalSnapshot`：reset → resize → 恢复 tmux 模式位图 → 一次 write）。
4. 之后的 `PaneData(pane, paneEpoch, seqStart, seqEnd, data)` 按序追加；`seqStart` 早于 `baseSeq` 的部分丢弃。
5. 向上滚动时按 `historyCursor` 发 `RequestHistory`，服务端以
   `HistoryBegin → HistoryChunk* → HistoryCommit(nextCursor)` 分页返回。

### 不变量

- 未提交首屏的 pane 不写任何流中字节（`PaneSinkRegistry` 直接丢弃，不做无界缓冲）。
- `requestId` 一一对应：Begin 与 Commit 必须同 `requestId`，中途换 pane 只是让旧事务的 Commit 被忽略。
- pane epoch 变化（tmux pane 重建）即基线失效，服务端发 `SourceGap`，客户端重取整屏。
- 没有超时重试状态机：请求失败/缺块由 `SourceGap` 与重订阅驱动，不再有「无进展超时」。

---

## 4) 订阅代与重连补流（FE，按 deviceId）

> legacy 的「输出门控状态机」（`FLOWING/BUFFERING` + `LIVE_RESUME` 放闸）已随屏障一起删除。
> canonical 下没有需要闸门的窗口期：订阅集合与首屏事务本身就界定了哪些字节该写。

### 规则

- 订阅集合变更（挂载/卸载 pane、keep-alive 池置冷）各产生一次 `SetPaneSubscriptions`，`generation` 自增。
- 服务端以 `SubscriptionApplied(generation, activePanes, hotPanes, rejected)` 回执；客户端只认最新 generation。
- 直连（WebRTC）回落到 primary 后**不主动重取整屏**：重订阅带 cursor，服务端只补缺口，
  确实有 gap 时才发 `SourceGap` 触发整屏。
- 网关不满足 canonical v1.1 门槛时进入 `stateFeedMode = 'unsupported'`：canonical 会话不建立、
  待发命令丢弃、弹一次 `websocket.serverTooOld` 提示，**不回退 legacy**。

---

## 5) Resize 上报编排（FE，按 deviceId+paneId）

这里没有显式状态枚举：在途状态就是调度器持有的定时器 / RAF 回调，闸门是每次执行时现取的快照。

### 实现

- 触发源：容器 `ResizeObserver`（`useContainerResizeObserver`）+ `FitAddon.proposeDimensions()`（`ghostty-terminal` 提供的兼容实现）。
- 编排：`TerminalResizeScheduler`（`packages/terminal-ui/src/components/terminal-resize-scheduler.ts`）先防抖合并，再落到一次 RAF 上执行（`RafCoalescer`），等布局稳定后才测量。
- 上报闸门：`TerminalResizeReporter`（同目录 `terminal-resize-reporter.ts`）在**执行时**取 `TerminalResizeGate`；`sizingMode` 为 `report | follow | local`，只有 `report` 才真正发帧，避免防抖排队期间实例被切到后台仍替它上报。

### 参数与规则

- 防抖：`RESIZE_DEBOUNCE_MS = 150`。
- 切 pane 后补测三轮（`runPostSelect`）：立即一次、`POST_SELECT_RETRY_MS = 60` 后一次、`document.fonts.ready` 后一次。
- 去重：cols/rows 未变化不发送。
- `TMUX_SELECT` 可以携带 cols/rows 作为首包同步。
- 尺寸命令统一走 canonical `ResizePaneV11`，两类语义由 `geometryReason` 区分（原 `TERM_RESIZE` /
  `TERM_SYNC_SIZE` 两个 kind 已删除）：
  - `geometryReason = 0`（change）：真实容器/视口变化，发送前 `sizeEpoch` 自增。
  - `geometryReason = 1`（resend）：焦点恢复、暖切换后重新声明当前尺寸，复用该 pane 上一次 change 的
    `sizeEpoch`；网关据此走「不信任旧快照几何」的分支。
- `sizeEpoch` 是 u64 且恒 ≥ 1（0 为保留值）；网关按 epoch 丢弃过期尺寸，同 epoch 的补发必须放行。

---

## 6) Bell 状态机（Gateway，按 deviceId+paneId）

### 状态

- `ALLOW`
- `THROTTLED(untilMs)`

### 规则

- bell 事件来源统一：
  - 优先 tmux 控制事件 `%bell`
  - 兼容输出 0x07 作为兜底
  - 两者进入统一去重/频控逻辑
- 频控参数来自 site settings：`bellThrottleSeconds`。
- THROTTLED 期间相同 pane 的 bell 不再推送。

---

## 7) Gateway 侧设备连接状态机（DeviceConnectionEntry）

> 对应 `apps/gateway/src/ws/device-connection-registry.ts` 的 device entry 管理与重连（由 `apps/gateway/src/ws/index.ts` 装配）。

### 状态（隐式，由 registry 的两张表与 entry 上的定时器体现）

- 无 entry：`connections` 里没有该 deviceId。
- 创建中：`pendingConnectionEntries` 有在途 promise，并发 connect 合流到同一个 promise。
- ACTIVE：`connections` 有 entry，tmux ready，能处理命令与输出。
- RECONNECTING：`entry.reconnectTimer` 在途。
- 空闲宽限：`entry.clients` 与 `entry.canonicalClients` 都空，`entry.idleReleaseTimer` 在途。

### 规则

- 客户端集合为空时不立即断开 tmux，而是 `scheduleConnectionEntryRelease()` 排一次 `RUNTIME_IDLE_GRACE_MS`（5s）宽限；宽限内重新 connect 直接复用同一 entry，超时才 `releaseConnectionEntry()`。
- clients 不为空且断链时走 `handleConnectionClose()` 重连（按 site settings 的 `sshReconnectMaxRetries` / `sshReconnectDelaySeconds`）。
- 重连成功后发送 `DEVICE_EVENT(reconnected)` 并主动推 snapshot；重试用尽由 `finalizeReconnectFailure()` 广播终态事件并清空 entry。

---

## 8) Tmux 输出与命令回复匹配（Gateway 内部）

要求：

- 不能依赖纯 FIFO `shift()` 来把 tmux 输出块与命令类型绑定。
- 必须将“发送队列”与“收到 %begin 时绑定 commandNo”做关联；输出块以 `%begin/%end` 的 commandNo/flags/time 作为真实边界。

这样才能在 output 与 reply 交错时仍保持确定性。

---

## 9) Canonical feed 状态机（每条客户端 WS）

### 状态

- `NEGOTIATING`：等待 HELLO，不能收发 canonical 业务消息。
- `READY`：已发送一次 `FeedReady` 和完整 metadata snapshot，可接受命令。
- `CLOSED`：释放客户端订阅；不关闭仍被其他消费者使用的 device runtime。

三个状态在 `CanonicalFeedSession` 里是 `readySent` / `bootstrapped` / `closed` 三个标志，不是枚举。metadata 重置不是会话级状态，而是 per-device 标志 `AttachedDevice.metadataNeedsRebase`（`requestMetadataRebase()` 置位并重发完整 metadata snapshot）；pane sequence gap 由 `CanonicalPaneStream` 发 `SourceGap`，同样不改变会话状态。

### 不变量

1. 同一个 `deviceId` 的所有 WS 消费者共享一个 `DeviceSessionRuntime` 和一条底层 tmux control/output 连接，不能按浏览器 tab 新建采集流。
2. feed 建立时先发 `FeedReady`，再发完整 metadata snapshot；snapshot Commit 前客户端不可应用后续 patch。
3. metadata patch 必须满足 `fromRevision == clientRevision`；不连续时置 `metadataNeedsRebase` 并重发完整 metadata snapshot。
4. pane output 只下发给该 feed 的 active/hot 并集；未订阅 pane 的元数据仍实时下发，但终端字节不下发。
5. `SetPaneSubscriptions` 是集合替换，不是增量修改。generation 小于等于已应用 generation 时幂等忽略并回当前 ACK。
6. canonical event 直接编码为不超过 32KiB 的 Envelope，严禁再经通用 `CHUNK`。
7. 首屏 capture 与 terminal `baseSeq` 在同一 control-mode command block 边界提交；该 block 结束后到达的 pane output 只能作为 replay/live 应用。
8. history 使用独立、可过期的行游标分页；大页不得经过 terminal control stream，SSH 读取使用独立 bounded channel，不能排在 input 前面。

### 连接恢复

- WS 重连后视为新 feed：客户端重新发送期望的 active/hot 集，服务端返回最新 metadata snapshot 和 `SubscriptionApplied`。
- tmux/SSH 底层短暂重连时，runtime 保留已提交热缓存；server epoch 未变则继续原有 pane sequence，并补发缺口内仍保留的数据。
- server epoch 或 pane epoch 改变、或者所需数据已被逐出时，发送 `SourceGap`，随后为受影响 pane 推送完整 screen snapshot；客户端无需刷新页面。

---

## 10) Active / Hot / Cold 缓存状态机（Gateway runtime）

- `ACTIVE`：至少一个 feed 把 pane 放入 active 集。实时转发输出，保留 screen emulator 与有界增量环。
- `HOT`：没有 active 引用但至少一个 hot 引用，或刚从 active 降级且仍在热集 TTL/LRU 内。继续维护有界 screen/增量缓存，但不向未订阅客户端发送字节。
- `COLD`：无引用且已逐出热集。只维护元数据；再次激活时通过一次 screen snapshot 恢复。

订阅集按所有 feed 求并集并带引用计数。容量超限时优先拒绝或逐出 hot pane，不能影响 active pane；所有环形缓冲、screen 和历史页都有显式 byte 上限，达到阈值必须丢弃旧数据并用 gap/snapshot 恢复，不能形成无界积压。
