# 2.3.0

_2026-09-12_

## English

### Features

- **The relay now runs its own TURN server.** Deploying a relay (`relay` / `relay,node`) automatically starts a built-in STUN/TURN server on UDP 3478 (`VIBETERM_TURN_PORT`, `0`/`off` disables) with relayed ports 49160–49259 (`VIBETERM_TURN_RELAY_PORT_RANGE`). Credentials are generated and persisted automatically, the public IPv4 is discovered from the relay's public URL (DoH-aware) or a STUN self-probe (`VIBETERM_TURN_EXTERNAL_IP` / `VIBETERM_TURN_HOST` override), and the `turn:<ip>:<port>?transport=udp` entry is distributed to members with the existing `relay.list`. The old `VIBETERM_TURN_URL/_USERNAME/_CREDENTIAL` triple still works as an *external* TURN and disables the built-in one. `vibeterm relay status`, `vibeterm doctor`, `GET /api/relay/status` and the relay management page show the TURN state; `init`/`install.sh` print the UDP ports to open. **Open UDP 3478 and UDP 49160–49259 on the relay host's cloud security group / firewall.**
- **Nodes stay attached to every relay and pick the best one per peer.** With two or more relays, a node keeps a live uplink to all of them: the existing one is the *primary* (key-log authority, roster source, target of "set as primary"), the others are *secondaries* (presence, inbound streams, signalling). Each peer link is opened through the relay with the lowest `rtt(self, relay) + rtt(peer, relay)` (nodes advertise their relay RTT in the status blob), so two nodes in China talk via the Chinese relay while a cross-border pair picks whichever is faster. Nodes that are only visible on one relay stay online; a relay outage only affects peers exclusive to it. `GET /api/mesh/relay/status` rows gain `role` / `online` / per-row `rttMs` / `peersOnline` / `turn` (+ `multiAttach`), `/api/mesh/nodes` and `NODE_EVENT` gain `viaRelay` / `relayPresence`, `vibeterm relay list` gains ROLE / PEERS / TURN columns, and the relay strip in Settings shows every relay with its RTT and a "set as primary" action.
- **TURN handling on nodes.** Every advertised TURN server is probed; only reachable ones (at most 2, best RTT first) are handed to ICE, and ICE UDP mux is only disabled when a reachable TURN is included — an unprobed or unreachable TURN can no longer stall candidate gathering. `GET /api/mesh/rtc-config` now returns `turn` / `turnConfigured` as arrays plus `turnProbes`.

### Fixes

- **A DataChannel upgrade no longer kills the relay session you are using.** When a direct link came up, the still-active relay/WS stream was reset immediately (`replaced`), dropping terminals that then had to reconnect. The old session is now drained make-before-break: new streams go to the new link, the old one closes only once its inner streams are gone (30 min hard cap).
- **`dc handshake receive queue overflow` fixed.** The offerer flooded a `hello` every 40 ms into an 8-slot queue that the answerer only attached after the channel opened, so a peer that connected 1–2 s earlier always overflowed it. The receive queue is attached first, hellos are resent every 500 ms and deduplicated by type, the queue holds 64 entries, and control frames that arrive mid-handshake are re-injected in order.
- Fake-IP (`198.18.0.0/15`) ICE host candidates from proxy TUN interfaces are dropped on both sides.
- Peer RTT is measured with a `sentAt` echo (no longer inflated by the sender's own queue), smoothed with an EWMA and a spike guard; the dial budget uses the median of live links instead of the global maximum, so one congested link no longer slows every new dial.
- Idle DataChannels are kept for 30 minutes (relay/WS links still 5). Peers whose direct dial is permanently impossible (`no_srflx` etc.) or whose breaker is disabled are no longer re-dialed by the background upgrade scan every 15 s (60 min hold / until re-arm).
- Built-in TURN hardening: oversized peer datagrams are dropped instead of crashing the handler, per-allocation permission caps, and rate-limited unauthenticated replies.

### Upgrade notes

- Upgrade the relay(s) first, then the nodes. Open UDP 3478 + 49160–49259 on the relay host; remove the old `VIBETERM_TURN_*` triple from the relay's `app.env` if you want the built-in TURN (an external coturn is no longer needed).
- Adding a second relay: `vibeterm relay enroll <https-url>` on any member; nodes attach to both automatically after the update.

---

## 中文

### 新功能

- **中继自带 TURN 服务器。** 部署中继（`relay` / `relay,node`）即自动在 UDP 3478 起内置 STUN/TURN（`VIBETERM_TURN_PORT`，`0`/`off` 关闭），中继端口段 49160–49259（`VIBETERM_TURN_RELAY_PORT_RANGE`）。凭据自动生成并持久化；公网 IPv4 由中继公网 URL（DoH 解析）或 STUN 自探得到（`VIBETERM_TURN_EXTERNAL_IP` / `VIBETERM_TURN_HOST` 可覆盖）；`turn:<ip>:<port>?transport=udp` 随原有 `relay.list` 下发。旧的 `VIBETERM_TURN_URL/_USERNAME/_CREDENTIAL` 三件套仍可用，视为**外部** TURN 并关闭内置。`vibeterm relay status`、`vibeterm doctor`、`GET /api/relay/status` 与中继管理页均显示 TURN 状态；`init`/`install.sh` 会提示要放行的 UDP 端口。**请在中继宿主的云安全组/防火墙放行 UDP 3478 与 UDP 49160–49259。**
- **节点同时挂载全部中继，按对端选最优中继。** 有两台以上中继时，节点与每台都保持上行：原来那台是**主中继**（密钥日志权威、花名册来源、「设为主中继」的目标），其余是**副中继**（在线状态、入站流、信令）。每条对端链路走 `rtt(本机, 中继) + rtt(对端, 中继)` 最小的那台（节点在状态块里上报自己到中继的 RTT）：两台都在国内就走国内中继，一内一外则按实测挑更快的。只在某一台中继上可见的节点照样在线；一台中继故障只影响仅在它上面的对端。`GET /api/mesh/relay/status` 行增加 `role` / `online` / 逐行 `rttMs` / `peersOnline` / `turn`（顶层 `multiAttach`），`/api/mesh/nodes` 与 `NODE_EVENT` 增加 `viaRelay` / `relayPresence`，`vibeterm relay list` 增加 ROLE / PEERS / TURN 列，设置页中继条显示每台中继的 RTT 与「设为主中继」。
- **节点侧 TURN 处理。** 每条下发的 TURN 都会探测；只有可达的（最多 2 条，按 RTT）交给 ICE，且只在纳入可达 TURN 时才关闭 ICE UDP mux——未探测或不可达的 TURN 不再卡死候选收集。`GET /api/mesh/rtc-config` 的 `turn` / `turnConfigured` 改为数组并新增 `turnProbes`。

### 修复

- **直连升级不再杀掉正在使用的中继会话。** 以前 DataChannel 一建立就立刻 reset 仍在用的 relay/WS 流（`replaced`），终端掉线重连。现在旧会话 make-before-break 排空：新流走新链路，旧链路等内层流走完才关（上限 30 分钟）。
- **修复 `dc handshake receive queue overflow`。** offerer 每 40 ms 狂发 `hello`，而 answerer 的 8 槽接收队列要等通道打开后才挂上，先连上 1–2 秒的对端必然把它灌爆。现在先挂接收队列、hello 每 500 ms 重发并按类型去重、队列 64 槽，握手期间到达的控制帧按序重注入。
- 丢弃代理 TUN 网卡产生的 fake-IP（`198.18.0.0/15`）ICE host 候选（收发两侧）。
- 对端 RTT 改为 `sentAt` 回显测量（不再被本端发送队列抬高），EWMA 平滑并忽略尖峰；拨号预算取活跃链路的中位数而非全局最大值，一条拥塞链路不再拖慢所有新拨号。
- 空闲 DataChannel 保留 30 分钟（relay/WS 仍为 5 分钟）。直连永久不可能（`no_srflx` 等）或熔断已禁用的对端，不再被后台升级扫描每 15 秒重拨（抑制 60 分钟 / 直到重新武装）。
- 内置 TURN 加固：超大 peer 报文丢弃而非崩溃、每 allocation 的 permission 上限、未认证应答限流。

### 升级说明

- 先升级中继，再升级节点。在中继宿主放行 UDP 3478 + 49160–49259；要用内置 TURN，请删掉中继 `app.env` 里旧的 `VIBETERM_TURN_*` 三件套（外部 coturn 不再需要）。
- 加第二台中继：在任一成员上 `vibeterm relay enroll <https-url>`，升级后节点会自动同时挂载两台。
