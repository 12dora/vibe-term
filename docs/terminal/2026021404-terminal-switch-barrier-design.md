# 终端切换屏障（selectToken）设计 — 已于 1.1.23 下线

> 状态：**已移除**。屏障机制（`SWITCH_ACK` → `TERM_HISTORY` → `LIVE_RESUME`）连同整条 legacy 状态流
> 在 1.1.23 删除，代码（`apps/gateway/src/ws/borsh/switch-barrier.ts`、
> `packages/ws-client/src/state-machine.ts`、`packages/ws-client/src/pane-history-gate.ts`）已不存在。
> 本文保留背景与问题定义，供理解 canonical 方案为什么这么设计；实现细节以第 3 节为准。
>
> 代码索引（现行）：
>
> - Gateway canonical feed：`apps/gateway/src/ws/canonical-feed-session.ts`、`apps/gateway/src/ws/canonical/`。
> - FE canonical 状态流：`packages/ws-client/src/canonical-state-client.ts`、`pane-sink-registry.ts`。
> - e2e：`apps/fe/tests/ws-borsh-pane-switch.spec.ts`（已改写为 canonical 首屏事务 + 订阅代断言）。
>
> 状态机全貌见 `docs/ws-protocol/2026021403-ws-state-machines.md` 第 3、4 节。

## 1. 背景与问题（仍然成立）

屏障引入前的实现依赖：

- Gateway：`tmux/select` 后 `capture-pane` 推 `term/history`。
- FE：先写 history，再把 live buffer 追加。

缺少明确的事务边界，导致：

- live output 可能在 history 之前到达并被写入，随后 history 覆盖，造成乱序。
- 用户快速切换 pane 时，旧 pane 的 history/live 可能写入新 pane。
- 历史订阅与 select 的时机竞态，导致偶发「无历史/白屏」。

## 2. 屏障方案（历史，已删除）

每次选择事务由客户端生成 `selectToken(16 bytes)`，服务端按序发 `SWITCH_ACK` → `TERM_HISTORY` →
`LIVE_RESUME` 三段式屏障，`LIVE_RESUME` 之前的 live output 在 Gateway 侧缓冲。

局限（也是被替换的原因）：

- 屏障边界与 tmux `capture-pane` 的一致性靠时序约定维持，没有可对账的序号；capture 与 live
  之间的重叠/缺口无法证明。
- history 只有「当前屏」一页，向上滚动要另发 `TMUX_FETCH_PANE_HISTORY`，两条路径各有一套门控。
- 缓冲期在 Gateway 与 FE 各存一份，快切时两侧都要靠 token 对账丢弃，出错就是白屏。
- 尺寸补发与真实尺寸变化在 wire 上无法区分（`TERM_RESIZE` / `TERM_SYNC_SIZE` 字段完全相同）。

## 3. canonical 方案（现行）

切换不再有屏障帧。画面重建是一次**带 requestId 与序号的首屏事务**，输出连续性靠
`(paneEpoch, terminalSeq)` 对账：

```text
FE                                  Gateway                          tmux
 | SetPaneSubscriptions(gen, panes)  |                                |
 |---------------------------------->| 订阅集合替换                    |
 |         SubscriptionApplied(gen)  |                                |
 |<----------------------------------|                                |
 | RequestScreen(requestId, pane)    |                                |
 |---------------------------------->| capture-pane（同一 command block）|
 |                                   |------------------------------->|
 |  ScreenBegin(requestId, baseSeq)  |                                |
 |<----------------------------------|                                |
 |  ScreenChunk(requestId, offset)*  |                                |
 |<----------------------------------|                                |
 |  ScreenCommit(requestId, cursor)  |                                |
 |<----------------------------------| （提交后才整屏重写）              |
 |  PaneData(seqStart..seqEnd)       |                                |
 |<----------------------------------|<-------------------------------|
```

对应关系：

| 旧机制 | canonical 替代 |
| --- | --- |
| `SWITCH_ACK(token)` | `SubscriptionApplied(generation)`：订阅集合替换的回执，generation 单调递增 |
| `TERM_HISTORY(token)` | `ScreenBegin/Chunk/Commit`（首屏）+ `HistoryBegin/Chunk/Commit`（游标分页） |
| `LIVE_RESUME(token)` | `ScreenCommit` 的 `baseSeq`：早于它的 `PaneData` 直接丢弃，无需闸门 |
| Gateway 屏障期缓冲 | 无。未提交首屏的 pane 直接丢弃流中字节 |
| token 对账 | `requestId`（首屏/历史）与 `generation`（订阅），过期的自然被忽略 |
| 超时降级重试 | `SourceGap` + 重取整屏；不再有「无进展超时」状态机 |
| `TERM_RESIZE` / `TERM_SYNC_SIZE` | `ResizePaneV11` 的 `geometryReason`（change / resend）+ `sizeEpoch` |

`TMUX_SELECT` / `TMUX_SELECT_WINDOW` / `TMUX_FOCUS_PANE` 保留：它们是 tmux 控制面（真正切
tmux 的当前 pane、携带视口尺寸参与几何仲裁），不属于被删除的状态流。`selectToken` 仍随 wire 发
（schema 未改），但客户端已不再用它对账。

## 4. 关键边界条件（canonical 下如何满足）

- **快速切换 pane**：旧 pane 的首屏 Commit 到达时其 requestId 已无人认领；订阅集合以最新
  generation 为准，旧 generation 的回执幂等忽略。
- **history 很大**：首屏与历史都按 `ScreenChunk` / `HistoryChunk` 分片，且不经通用 `CHUNK` 通道。
- **设备断线/重连**：视为新 feed，客户端重发订阅集合，服务端回最新 metadata snapshot 与
  `SubscriptionApplied`；server/pane epoch 变化则发 `SourceGap` 并重推整屏。
- **对端过旧**：对端不满足 canonical v1.1 门槛（能力 `canonical-state-v1.1` + 版本 ≥ 1.1.23）时
  **不回退**，`stateFeedMode = 'unsupported'` 并提示升级；提示按 `server-too-old` 事件里的
  `side` 分流（入口网关 / 被拒节点 / 本页面），节点侧点名 ERROR message 里带的节点编号。

## 5. 验收用例（e2e）

`apps/fe/tests/ws-borsh-pane-switch.spec.ts`：

1. 跨 window 切换后，`TMUX_SELECT` 仍携带本地 cols/rows；目标 pane 的首屏事务 Begin/Commit 成对且
   requestId 一致；目标 pane 进入最新订阅集合。
2. 连续两次跨 window 切换后，订阅 generation 单调递增、最终订阅集合含最后选中的 pane，且没有
   `PaneData` 落在从未进过订阅集合的 pane 上。

`apps/fe/tests/ws-borsh-history.spec.ts`、`ws-borsh-pane-route.spec.ts` 分别覆盖首屏内容与
canonical PaneTarget 的 pane 路由。
