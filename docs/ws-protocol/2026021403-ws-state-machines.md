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
> | 选择事务 + 输出门控（FE） | `packages/ws-client/src/state-machine.ts`（`SelectStateMachine`、`SelectTransactionState`、`OutputGateState`） |
> | history 分页门控（FE） | `packages/ws-client/src/pane-history-gate.ts` |
> | 切换屏障（Gateway） | `apps/gateway/src/ws/borsh/switch-barrier.ts`（`SwitchBarrier`） |
> | 设备连接 entry（Gateway） | `apps/gateway/src/ws/device-connection-registry.ts` |
> | canonical feed（Gateway） | `apps/gateway/src/ws/canonical-feed-session.ts`、`apps/gateway/src/ws/canonical/` |
>
> 第 3、4 节是切换屏障的 FE 侧；Gateway 侧时序、超时降级与验收用例见 `docs/terminal/2026021404-terminal-switch-barrier-design.md`。

## 设计原则

- **显式状态**：所有跨消息的流程（切换/缓冲/历史）必须有状态与 token。
- **不变量优先**：先定义必须成立的规则，再写实现。
- **超时与降级**：任何流程都必须有超时兜底，避免卡死。
- **幂等与去重**：重复消息不产生副作用；过期 token 一律丢弃。

## 全局不变量（必须满足）

1. 每个 `deviceId` 在每个客户端上同时最多只有一个“当前活跃选择事务”。
2. `LIVE_RESUME(selectToken)` 之前不允许把 live output 直接写入终端。
3. `TERM_HISTORY(selectToken)` 只能应用到匹配 token 的事务。
4. 任何消息若 token 不匹配或事务已被新事务替代，必须丢弃。
5. resize 以浏览器视口为源（FE），Gateway 仅做同步与 tmux client/pty 对齐。
6. bell 去重与频控必须在 Gateway 统一，FE 仅展示。

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

## 3) 选择事务状态机（FE，按 deviceId）

> 这是最关键的状态机，决定 history/live 合并与输出门控。

### 状态

- `STABLE`：当前 pane 已处于 LIVE。
- `SELECTING`：已发送 `TMUX_SELECT(token)`，等待 `SWITCH_ACK`。
- `ACKED`：收到 `SWITCH_ACK(token)`。
- `HISTORY_APPLIED`：已应用 `TERM_HISTORY(token)`。
- `LIVE`：收到 `LIVE_RESUME(token)` 并已 flush 缓冲。
- `SELECT_FAILED`：超时/错误。

### 事件

- `selectRequested(token, paneId, windowId)`：由路由变化或 `pane-active` 事件触发。
- `switchAck(token)`
- `history(token, bytes)`
- `liveResume(token)`
- `error(token?/refSeq?)`
- `timeout`

### 转移规则

1. `STABLE -> SELECTING`：触发新选择事务。
2. `SELECTING -> ACKED`：收到 `SWITCH_ACK(token)`。
3. `ACKED -> HISTORY_APPLIED`：收到 `TERM_HISTORY(token)`（若 wantHistory=true）。
4. `ACKED/HISTORY_APPLIED -> LIVE`：收到 `LIVE_RESUME(token)`。
5. `LIVE -> STABLE`：标记该 token 成为当前稳定 pane。

并发/替换：

- 任意状态收到 `selectRequested(newToken)`：
  - 立刻废弃旧 token（清空缓冲、停止等待）。
  - 进入 `SELECTING(newToken)`。

失败：

- `SELECTING/ACKED/HISTORY_APPLIED` 超时 -> `SELECT_FAILED`。
- `SELECT_FAILED` 可回退到上一个 `STABLE` 的 pane（若存在），或保持空白并提示。

### 超时策略

- 选择事务使用“无进展超时”，每收到一个属于当前 token 的有效 ACK、history chunk 或 live bytes 都刷新 deadline。
- 超时后保留上一份已提交画布并自动重试当前 select；不得先清空终端，也不得提交缺块的 history。
- 新 token 会立即废弃旧 token 的事务缓冲；旧 token 的后续帧全部丢弃。

---

## 4) 输出门控状态机（FE，按 deviceId）

### 状态

- `FLOWING`：直接写入终端。
- `BUFFERING`：缓冲 output bytes。

### 规则

- 进入新 `SELECTING` 时强制切到 `BUFFERING`。
- 收到 `LIVE_RESUME(token)` 时：
  1. 把缓冲 output 依次写入终端。
  2. 切回 `FLOWING`。
- 若收到 output 时处于 BUFFERING：追加到缓冲。

不变量：

- BUFFERING 期间绝不直接 write 到终端（当前底座为 Ghostty wasm，见 `docs/terminal/2026041600-ghostty-wasm-runtime.md`）。
- 缓冲有显式字节上限，超限时丢弃最旧数据并靠后续 snapshot 恢复，不形成无界积压。

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
- `TERM_RESIZE` 与 `TERM_SYNC_SIZE` 语义一致；建议：
  - `TERM_SYNC_SIZE` 用于 “select 后强制同步”
  - `TERM_RESIZE` 用于 “正常容器变化”

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
