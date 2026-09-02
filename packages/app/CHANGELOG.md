# 1.1.17

_2026-09-02_

## English

### Improvements

- Terminal links between nodes recover faster and more predictably: when a terminal stream has to be rebuilt, the history that is replayed is now bounded (at most 256 KiB per pane, 1 MiB per recovery, shared fairly across panes), so a recovery no longer floods the connection and triggers the next stall. Panes that cannot get a bounded tail are told to refresh their screen instead of silently missing output.
- WebRTC direct-connection attempts to a peer that keeps failing (for example a server that blocks UDP) are paused for 6 hours after 8 consecutive failures instead of retrying forever; the working WebSocket or hub link is unaffected.
- Diagnostics for latency spikes: gateway mesh and terminal log lines now carry timestamps; stream recoveries log their cause, per-step timings, replayed bytes and the event-loop lag; backpressure events report which connection was affected and how much was skipped. `[ws-metrics]` includes the event-loop lag.

---

## 中文

### 改进

- 节点间终端链路的恢复更快、更可预测：终端流需要重建时，回放的历史现在有上限（每个 pane 最多 256 KiB、每次恢复最多 1 MiB，按 pane 公平分配），不会再因为一次恢复把连接灌满而引发下一次卡顿。拿不到有限历史的 pane 会被告知刷新屏幕，而不是悄悄漏掉输出。
- 对持续失败的对端（例如屏蔽 UDP 的服务器），WebRTC 直连在连续失败 8 次后暂停 6 小时，不再无限重试；现有的 WebSocket 或 Hub 链路不受影响。
- 延迟突增的诊断能力：网关 mesh 与终端日志带时间戳；终端流重建会记录起因、各步耗时、回放字节数和事件循环延迟；背压事件会说明受影响的连接与跳过的数据量。`[ws-metrics]` 增加事件循环延迟。
