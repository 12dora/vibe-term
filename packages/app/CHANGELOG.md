# 2.20.0

_2026-11-25_

## English

### Features

- **Predictive echo**: on high-latency connections the terminal shows what you type immediately, mosh-style, and reconciles it with the server's echo; characters still awaiting confirmation are underlined. It stays off in full-screen apps, password prompts and while scrolled back, and backs off automatically after repeated mispredictions. Settings → Terminal → Predictive echo: Auto (default, on when the link RTT is 50 ms or more) / On / Off.
- **Faster recovery from packet loss between nodes**: node-to-node WebRTC links now send a redundant copy of small messages (keystrokes, small terminal output, control frames) on an extra unordered channel, so a single lost packet no longer stalls the terminal for a retransmission timeout. Both nodes must run 2.20.0; older nodes keep the previous behaviour. Disable with `VIBETERM_DC_FAST_PATH=0`. Counters are shown in `vibeterm nodes show <node>` (`dcFastPath`).

### Bug Fixes

- **No duplicate messages under backlog**: a DataChannel send that the native layer queued is no longer retried, which could deliver the same message twice when the channel was congested.

---

## 中文

### 新功能

- **预测回显**：高延迟连接下，输入会像 mosh 一样先在本地显示，再与服务器回显对账；尚未确认的字符带下划线。全屏程序、密码输入、回看历史时不启用，连续预测失误会自动暂停。「设置 → 终端 → 预测回显」：自动（默认，链路 RTT 不低于 50 ms 时开启）/ 开启 / 关闭。
- **节点间丢包恢复更快**：节点之间的 WebRTC 链路会把按键、小段终端输出、控制帧等小消息在一条无序通道上额外发送一份，单个丢包不再让终端卡住一个重传超时。两端都需为 2.20.0，旧版本节点保持原有行为。可用 `VIBETERM_DC_FAST_PATH=0` 关闭；计数见 `vibeterm nodes show <node>` 的 `dcFastPath`。

### 问题修复

- **拥塞时不再重复发送**：底层已排队的 DataChannel 消息不再被重试，避免通道拥塞时同一条消息送达两次。
