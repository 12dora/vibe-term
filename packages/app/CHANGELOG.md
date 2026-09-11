# 2.2.3

_2026-09-12_

## English

### Fixes

- **Direct links no longer die after the other side restarts.** A node remembered the highest "offer number" it had seen from each peer for as long as it ran, while a peer that restarted (an upgrade, a reboot) started counting from zero again — so every new direct-connection offer from that peer was rejected as stale until this node itself restarted. That is why the fleet fell back to the relay after each upgrade. The memory now expires after 30 s, and candidates that arrive just before their offer are kept instead of dropped.
- **An unreachable TURN server no longer breaks direct connections for everyone.** With a TURN server configured, a node that cannot reach it over UDP (typical behind a proxy TUN that drops overseas UDP) would wait forever for the relay allocation and never finish gathering. Nodes now probe the TURN server first: only a reachable TURN is used (and UDP multiplexing is turned off for it); otherwise the node keeps its normal STUN-only behaviour. `GET /api/mesh/rtc-config` shows `turnConfigured` / `turnProbe`.

### Upgrade notes

- Only nodes need this release. Upgrading either side of a pair fixes that direction.

---

## 中文

### 修复

- **对端重启后直连不再永久断掉。** 节点会一直记住从每个对端看到的最大「offer 序号」，而对端一重启（升级、重启机器）就从零重新计数，于是它之后发来的每个直连 offer 都被当作过期拒收，直到本机自己重启——这正是每次升级后全网退回中继的原因。现在这份记忆 30 秒后过期，紧跟在 offer 前到达的候选也会被保留而不是丢弃。
- **打不通的 TURN 不再拖垮所有节点的直连。** 配了 TURN 之后，UDP 到不了它的节点（典型是代理 TUN 吞境外 UDP）会一直等 relay 分配、永远完不成候选收集。现在节点先探测 TURN：探测可达才使用（并为它关闭 UDP 复用），否则保持原来的纯 STUN 行为。`GET /api/mesh/rtc-config` 新增 `turnConfigured` / `turnProbe`。

### 升级说明

- 只有节点需要升级；一对节点任一侧升级即可修好该方向。
