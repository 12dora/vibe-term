# 路径优选与选路模式

本文说明两件事：运营商按五元组做 ECMP 时，同一对主机上不同连接为何会差一倍 RTT、VibeTerm 用哪三条机制挑快路；以及节点间选路模式（智能 / 直连 / 中继）如何在直连与中继之间切换。面向排查跨境延迟的运维与改动 `apps/gateway/src/mesh/` 拨号路径的开发者。直连拨号保护见 [节点直连](./peer-direct-connect.md)，中继 uplink 见 [公共中继](./relay.md)。运维改模式见 [mesh 运维](../operations/mesh-operations.md)。

## 背景：五元组 ECMP

跨境运营商常按 `(srcIP, dstIP, proto, srcPort, dstPort)` 哈希选路。同一对机器上，换一个源端口就可能从「直连」跳到「绕行」，RTT 差一倍；单条长连接一旦哈希到慢路，会一直慢下去。

现网一对链路（浙江移动 ↔ 大阪 / 东京）的观测口径：

| 方向 | 观测 | 数值 |
|---|---|---|
| 去程 ICMP | 200 包 | avg 168.7 ms，min 167.4，max 178.6，丢包 0 %；全部落在绕行 |
| 去程 TCP 握手 | 28 次 | 双峰：**~90–98 ms（19 次）** 与 **~170–213 ms（8 次）**，另 1 次 1.15 s（SYN 重传） |
| 回程 | mtr 到边缘 | ~85 ms，CMI 东京—上海直连，无绕行 |

去程路径在 CMI 出口分叉：一部分上海→东京（~90 ms），一部分经美西圣何塞再回东京（~180–205 ms）。ICMP 全部落在绕行；TCP / UDP 业务按流哈希，大约三分之一的流会走到慢路。中继绕行（本机→上海 22 ms + 上海→东京 ~160 ms）并不比直连绕行更快。

对 VibeTerm 的含义：peer DataChannel（一条 UDP 流）、ws-secure / 中继 uplink（一条 TCP 流）都可能一开链就落在慢五元组上，之后心跳再准也救不回来——必须换源端口重拨。

下面三条机制都不能**创造**一条物理上不存在的路径；它们只是多掷几次五元组，把已经存在的快路捡出来。选路模式决定**要不要继续用这条直连**：UDP 五元组再快，若稳态 RTT 仍远差于中继，智能模式会把流搬到中继。

## 选路模式（延迟优化）

落库键 `gateway_kv` `mesh.routeMode`，契约 `MeshRouteMode`：`auto` | `direct` | `relay`，缺省 / 非法值读成 `auto`（不回写）。进程内单例 `MeshRouteModeStore`（`get` / `set` / `subscribe`），HTTP `GET/PUT /api/settings/mesh-route` 与 CLI 共用，**不**走 `SETTINGS_EVENT`。设置页文案「延迟优化」，三选项：智能 / 直连 / 中继。

| 模式 | 出站拨号 | 升直连 | 入站 dc / ws-secure |
|---|---|---|---|
| `direct` | 与既有顺序相同（dc > ws-secure > relay） | 开 | 按原 rank 安装 |
| `relay` | 只拨中继（`dialRelayOnly`），无 DC / ws 腿 | 关 | **关闭、不安装**（`reason=route-relay`）；2.3.7 对端熔断自行退避 |
| `auto` | 起步同 `direct` | 降级回退期内关 | 仅**已降级**时 measure-before-install；否则立刻装（兼容 2.3.7） |

### 测量输入

| 量 | 来源 |
|---|---|
| 直连 RTT `directMs` | live 为 dc / ws-secure → live ping EWMA（`live.rttMs`）；否则该对端 30 min 窗内 `pathRtt.bestMs(['dc','ws-secure'])` |
| 中继 RTT `relayMs` | live 为 relay → `live.rttMs`；否则 `chooseRelay.scoreMs`；再否则本端 uplink + 对端 uplink；对端缺失则 **2× 本端 uplink**（`readUplinkRtt`） |

中继 RTT 是两边 uplink 心跳之和，不是未用路径上的 mux ping。`chooseRelay` / `relaysFor` 仍要求 presence `connected`；状态行 `peersOnline` 的计数口径见 [公共中继](./relay.md)。

三条选路不要混：

| 层 | 挑什么 | 输入 | 何时动 |
|---|---|---|---|
| 中继自动优选 | 哪台中继当 **主**（密钥日志写者） | uplink 心跳 RTT EWMA + pathBest + 负载 + 失败罚分 | `VIBETERM_RELAY_AUTO_SELECT`，≥ 2 条未踢中继默认开；有 `preferredUrl` 固定则冻结。自动选中后写入进程内 `autoPreferredUrl`，候选序 `preferredUrl ?? autoPreferredUrl`，避免与 `probePreferred` 互踢。见 [公共中继](./relay.md) §9 |
| 按对 `chooseRelay` | 这一对节点走哪台中继 **开流** | `rtt(本机,R)+rtt(对端,R)`，所有已连接中继 | 与谁是主中继无关，N 路都参与 |

自动优选只搬家「写者 / primary」；旧主自动变成 secondary。

### 降级（auto，live 为直连）

同时满足才把流搬到中继：

- 连续 **3** 个 ping，且首个慢样本距今 **≥ 15 s**
- `directMs > max(1.5 × relayMs, relayMs + 40 ms)`

动作：`openRelay` + `forceInstall` relay + `finishRetire(prev, 'retired')`，让 failover 搬家。日志：

```
[mesh][peer] route_switch peer=… from=dc to=relay direct_ms=… relay_ms=…
```

回退：起步 **2 min**，失败翻倍，封顶 **30 min**。进程重启或**任何 mode 变更**清零。回退期内 upgrade coordinator 不拨直连。

### 升回（auto 且已降级）

make-before-break：upgrade 拨出的直连**先 hold**，中继继续载流。≥ **3** 个 ping **全部**满足 `directMs < relayMs − max(5 ms, 20% × relayMs)` 才 `forceInstall`；否则关直连并加倍回退。加法项取 5 ms 是为了让 ~15 ms 的快中继上局域网直连仍能升回（20 ms 门槛会变成负数）。切到 `direct` 模式：立刻安装未测完的候选，并 `maybeUpgrade`。

### 本轮限制

- **每对端一条 live**：interactive / bulk 共用这条链路。`decidePath(peerId, streamClass)` 已编码 bulk 门槛（中继须同时好出 40 ms 与 20%），未接双 live。
- auto **未降级**时，2.3.7 推入的 dc / ws-secure **立刻安装**。首次竞速中继先成、直连后到也立刻升，慢 DC 再靠 15 s 滞环降下去。
- 慢 DC 降到中继仍不新增选路字段。测量隔离另有一条 ctl，见下节，不要和这里的滞环混。
- 重掷（下节）只在 live 仍是 dc 时发生；`relay` 模式先拆掉 DC live，重掷因 `transport≠dc` 不再起。

### 测量中的直连（pending-measure）

持有方在升回判定完成前，把打到这条直连上的用户流以 `rst` `pending-measure` 拒掉（请求还没进对端业务）。接收方的反应按传输分开：

- **只有直连**（`dc` / `ws-secure`）上的 `pending-measure` 才把该节点隔离 `REMOTE_HOLD_MS` = `(ROUTE_PROMOTE_SAMPLES + 1) × 5 s` = **20 s**。旧版本不发 `route-promoted` 时，也不会在第三拍 ping 之前探回这条 DC。`stale-link` / `parked` 仍可重放这一次请求，**不**隔离整节点。
- 隔离期内 **auto** 在 live DC 旁边借一条中继给用户流：不退役 DC、不标 `degraded`、不武装选路退避。这条旁路中继接对端打进来的用户流并回 ctl ping（它在对端可能已经是 live）。`direct` 模式不再为这次转发另拨一条随手丢掉的中继，这次重试直接拒绝。
- 持有方测量通过后发 ctl `{ "t": "route-promoted" }`。接收方解除隔离并收掉旁路（`reason=route-promoted`），隔离到期则是 `hold-expired`；旁路先从可用列表摘掉，在途流排空后再关，最长等 `PEER_RETIRE_MAX_MS`。DC 被拆且原因不是停机 / 吊销、旁路还在、又没有别的 live 时，旁路装成 live，而不是先拆掉再重拨。停机 / 吊销则关掉旁路。

入口 failover：同一传输上，流在 HELLO / ack 之前被拆，只允许再试 **一次**（`SAME_TRANSPORT_PRE_ACK_RETRIES`）。没有 HELLO 可等时，流至少要活过一个 RTT（夹在 50–250 ms）才算这次打开成功，避免 delay 0 的热循环。连续 3 轮拿不到 HELLO 仍整段收手。

POST 在派发前被拒（`pending-measure` / `stale-link` / `parked`）时，只有**声明了 `Content-Length` 且 ≤ 64 KiB** 的请求体会先缓冲再重放一次。没有长度、或更大的流式上传原样透传，不重放。GET / HEAD 没有请求体，按原有次数换链路。

### 现网事故（2026-09-13）

`konata-mac` ↔ `tmexhub-sh`：ICMP / TLS 443 正常，本机中继上行 ~14 ms、对端上行 ~1 ms，经中继合计 ~15 ms 且稳定。两端之间的 DataChannel 是 UDP 打洞（`srflx`），RTT 从数十毫秒抖到数秒（`reroll_result … better=false`）。终端流固定跟 DC（`failover from=dc to=dc`），出现 `[ws] backpressure enter carrier=mesh_link_stream` 与 `rst … head-timeout`，用户看到卡顿。

当时没有「DC ≫ 中继 ⇒ 把流搬到 relay」的策略；重掷只跟本对端 pathRtt 的 DC / ws-secure / tcp-connect 最佳比，不用中继 uplink。重掷 3/3 全部失败：offerer 新 attempt `stage=no-remote-sdp remote_types=[]`；answerer 把更高 epoch 的 offer **先投给 live PC 残留监听**判 `superseded` 并退订，随后 `interceptOffer` 因应答侧 request 预算耗尽拒收。链路停在坏 DC 上直到 liveness 超时（约 16 min）。次因：应答侧对旧节点 `tmex` 循环应答 offer、占 TURN。

修复分两块：本节约的选路滞环（慢 DC → 中继，不等重掷成功）；下节的重掷协议（先 intercept 再投递、接 offer 与 request 预算解耦、应答侧独立冷却）。`signal dropped cause=fake-ip` 只丢 ICE candidate 的 connection-address ∈ `198.18.0.0/15`，与本次主因无关。

## 1. WebSocket 开链竞速

拨号时同时开 `N` 条 WebSocket（不同源端口 → 不同五元组），取最先 `open` 的一条，其余立刻 `close(1000, 'ws-race-loser')`，**不发任何字节**。输家在中继鉴权之前就关掉，不会触发 `replaced` / `relay-replaced`，也不会进注册表。

覆盖面：peer **ws-secure**、中继 uplink（含副中继）的默认 factory。注入过 `wsFactory` 的调用方（测试 / harness）不竞速。

| 项 | 值 |
|---|---|
| 环境变量 | `VIBETERM_WS_DIAL_RACE` |
| 默认 | `2` |
| 范围 | 整数，夹紧到 1..4；非法 / 缺失回默认 |
| 关闭 | `1`（需重启：import 时读一次） |
| 局域网 | 回环 / RFC1918 / 链路本地 / IPv6 ULA / `localhost` 恒为 1，不打日志 |
| 入站限流 | peer 握手 `PEER_HANDSHAKE_RATE_LIMIT` = **30**/IP/min（一次拨号最多消耗 `race` 个 Upgrade 名额） |
| 线协议 | 无改动，与 2.3.1 对端兼容 |

日志（info，`[mesh][dial]`）：

```
[mesh][dial] ws race url=<host> winner_ms=<n> others_ms=<a,b|-> count=<n>
```

`url=` 只有 hostname（无端口）。`winner_ms` 是发起竞速到赢家 `open` 的毫秒。`others_ms` 是赢家出现前已结算的其它 lane，逗号分隔；正常情况赢家一出就把其余关掉，所以是 `-`。LAN 目标不打这行。

分布：`grep -o 'winner_ms=[0-9]*' <log> | sort -t= -k2 -n | uniq -c`。

## 2. 直连慢路径重掷（DC 与 ws-secure）

live 链路每个 pong 对照「该对端已知的最佳路径 RTT」。当前稳态 RTT 明显差于 best 时，由 **offerer**（`winningDialInitiator`，字典序较小的 nodeId）再拨一条新链（新 ICE 端口对 / 新 TCP 源端口），make-before-break 换上，旧链路上的在途流再搬过去。

NAT 后的应答侧往往采得到 offerer 的公网 peer 口，offerer 却采不到应答侧——只有应答侧能看出「当前 DC 比 TCP 参考慢一倍」。此时应答侧跑同一套 `decideDcReroll`（`isOfferer=false`，对端 `link.hello` 报过 `reroll` 则 `canRequest=true`），命中后发 `{ t: 'link.reroll-request', transport, currentMs, bestMs }`，由 offerer 校验后走与本地触发相同的重拨路径（`reason=peer-request`）。

### 最佳路径记忆

`PeerPathRttMemory` 按对端收集三类样本，取未过期样本的最小值：

| 来源 `kind` | 怎么来 |
|---|---|
| `tcp-connect` | 入口对对端公开 peer 口做三路并发 TCP connect（与端口可达探测同一套，5 min 一次） |
| `dc` | 活的 DataChannel ping 样本 |
| `ws-secure` | 活的 ws-secure ping 样本 |

判定用的滑动窗是 **30 min**（`PEER_PATH_RTT_WINDOW_MS`，在 `createPeerManagerState` 里作为 `ttlMs` 传入）。40 分钟前的快样本不再把 `best` 钉死、反复误触发。类默认 TTL 仍是 24 h，只给未显式传窗的调用方。

### 策略常量

DC 与 ws-secure **共用**同一套阈值与每对端每小时预算（`dc-reroll-policy.ts`）：

| 名 | 值 |
|---|---|
| 慢的定义 | `rtt > max(1.5 × best, best + 40 ms)` |
| 最少 ping 样本 | 3 |
| 最小链龄 | 60 s |
| 每对端每滚动小时 | ≤ 3 次 |
| 两次间隔 | ≥ 60 s |
| 角色 | 拨号仅 offerer；应答侧在对端报过 `reroll` 时可发 `link.reroll-request`。需已协商 `quiesce` |
| DC 额外 | 对端 `link.hello` 报过 `reroll` 能力位；熔断放行（应答侧发请求不查本端熔断；offerer 收请求时查） |
| ws-secure 额外 | 入站本就会接新连接，不依赖 `reroll` 位。已能拨 DC 时，只在 **DC 拨号在途 / `state.upgrading` / 升级协调器已 coalesced-scheduled** 让路，**熔断健康不算**。与前台 ws 拨号共享 `wsInflight`（前台复用在途 Promise，重掷遇在途则放弃）；track 前若 live 已换人，以 `reroll-stale` 关闭且不二次记预算 |
| 结算 | 新链路 `linkSinceAt` ≥ 触发时刻且攒够 3 个样本；90 s 时限 |
| 搬流 | 相对提升 ≥ 30 %（`DC_REROLL_REHOME_GAIN`）且旧 session 还带流 → `finishRetire(old, 'retired')` |

### 兼容与开关

- 2.3.1 及更早只在 `link.hello` 里报 `quiesce`，不报 `reroll`。策略因此**永不对旧节点发 DC 重掷 offer**，也**永不发 `link.reroll-request`**（旧节点即使收到未知 `link.*` ctl 也会忽略）。ws-secure 重赛不受这个位限制，但应答侧请求仍要求对端报过 `reroll`。
- 信令通道：`link.reroll-request` 走**现有 DC ctl**；live 已是 `dc` 时 offer / answer / ICE 走**中继 uplink**（`transport !== 'dc'` 才 `sendPeerCtl`）。
- 应答侧靠 `DcRerollCoordinator.interceptOffer()` 接住 **epoch 高于 `LivePeer.rtcEpoch`** 的 offer。live 已是 dc 时 `receiveRtcSignal` **先 intercept 再投给旧监听**：成功接管的更高 epoch offer 不再送给 live PC 残留 ICE 监听，因此不会被 `superseded` 吞掉并退订。握手成功后 `ignoreNewerOffers = true`，live PC 对更高 epoch offer 只 `dropped cause=established`，不 `superseded`、不退订。在途（未建成）answerer PC 仍 superseded。epoch ≤ 当前 live epoch 的迟到 offer **不接管、不起 attempt**。
- **接 offer 与 request 预算解耦**：`count=3` 且距上次 > 90 s 仍应答更高 epoch offer。预算只限制本端 `start` / `requestReroll`。未主动 request 时接 offer 仍 `count++`（避免同一小时再去 request）；应答自己发出的 request 不二次记账。真正拒绝打 info `reroll_offer_ignored peer=… reason=<epoch|inflight|not-capable|inbox-full|role|cooldown>`；`dialDcReroll` 返回 null 时丢掉刚入队的 offer，避免 inbox 黑洞。
- **应答冷却**（与 offerer 熔断分立）：同一对端连续 **3** 次 peer-initiated timeout（含原先不计入主熔断的 `no-remote-sdp`）后忽略其 offer，冷却 30 s → 2 min → 10 min，日志 `answerer_backoff`。建成 / healthy / reset 清零。回应**本端** `reroll-request` 的 offer 绕过该冷却。主熔断冷却时仍应能接合法重掷。
- 重掷 offer 尚未到达时，更高 epoch 的 ICE 候选写入 `rtcInbox`（`LivePeer.rtcEpoch`，条目 30 s TTL，候选最多 16 条），避免被旧 attempt 监听吞掉；offer 落定后清掉 epoch 不匹配的候选。
- `VIBETERM_DC_REROLL=off`：本端既不触发，也不报 `reroll` 能力位——任一端关掉，这对节点就不会 DC 重掷。采样（path RTT 记忆）不受影响。需重启。
- 手动入口：`PeerManager.rerollDc(nodeId)`（只跳过 RTT 阈值，其余门照旧）。

### 日志

```
[mesh][rtc] reroll peer=<id8> transport=dc|ws-secure reason=slow-path|peer-request cur_ms=<n> best_ms=<n> try=<k>/3
[mesh][rtc] reroll_request peer=<id8> transport=dc|ws-secure cur_ms=<n> best_ms=<n> try=<k>/3
[mesh][rtc] reroll_result peer=<id8> transport=dc|ws-secure old_ms=<n> new_ms=<n> better=<true|false>
[mesh][rtc] reroll_rehome peer=<id8> transport=dc|ws-secure streams=<n> gain_pct=<n>
[mesh][rtc] reroll_offer_ignored peer=<id8> reason=epoch|inflight|not-capable|inbox-full|role|cooldown
[mesh][rtc] answerer_backoff peer=<id8> cooldown_ms=<n> consecutive=3
[mesh][rtc] dc reroll disabled by VIBETERM_DC_REROLL=off
```

`reroll_request` 在应答侧发出请求时打（预算在此时消耗）。offerer 收到后校验（活链路、transport 一致、本端是 initiator、已协商 quiesce、无在途拨号、熔断放行、本端预算未尽、距上次重掷 ≥ 60 s）；通过则 `reroll … reason=peer-request`，`old_ms` 取请求里的 `currentMs`。两端预算各 3/小时，peer-request 也记入 offerer 的次数。接收端不论校验成败，每对端 60 s 最多处理 1 条请求（多余 debug `reroll_request_ignored reason=rate`）。

配套：`[mesh][rtc] dial start … port_range=… epoch=…`（debug，看新端口对）、`signal dropped … cause=superseded|epoch-mismatch|established`（旧 attempt 被淘汰、已建成 live 忽略更高 epoch offer、旧链路仍在）、`reroll_stale`（ws-secure 重掷 track 前 live 已换人）、`[mesh][stream] failover_start … cause=stream_close close_reason=retired` / `failover_done`（搬流生效）。

`GET /api/mesh/nodes` **不**暴露 reroll 计数；看日志即可。

## 3. 上行路径周期采样与劣化重赛

中继上行是一条长寿 WebSocket。它可能一开链就落在慢五元组上，或中途被运营商改路。节点对已配置中继行（hostname 去重，每拍懒读）做参考采样，心跳连续偏慢且链路空闲时以 `path-rerace` 关掉活链、走第 1 条的开链竞速重连。

| 名 | 值 |
|---|---|
| 采样周期 | 每 5 min |
| 每次 | 对已配置中继行里每个公网 host 并行 3 次 TCP connect（hostname 去重；目标列表每拍懒读；跳过 LAN；目标端口取 URL，https/wss 默认 443） |
| 参考 TTL | 30 min（`UPLINK_PATH_RTT_TTL_MS`） |
| 心跳样本 | 活链 RTT 记 `ws-secure`；判定用的是**写入前**的 best，避免当前样本把自己变成参考 |
| 慢的定义 | 与直连相同：`rtt > max(1.5 × best, best + 40 ms)` |
| 连续慢 | ≥ 3 次心跳（中继 15 s → ≥ 45 s） |
| 最小链龄 | 60 s |
| 空闲 | `inFlightStreams === 0`（已建立流 + 建流中 + 在途密钥日志操作）；忙只回 `busy`，连续慢计数保留，下一拍空闲再判 |
| 每 host 每滚动小时 | ≤ 3 次 |
| 两次间隔 | ≥ 2 min |
| 关链 reason | `'path-rerace'`：池不 `noteFailure`、不走会话后最小退避；client `retryAttempt = 0`；副中继 `slot.attempt = 0` 且跳过 backoff |
| 结算 | `re-race_result` 只由**同一连接**重赛后第一代结算：新链攒够 3 个心跳才打；再换代（普通重连）即作废，不让后续连接补足旧重赛 |
| 开关 | `VIBETERM_UPLINK_PATH_SAMPLING=off` 不启动采样、心跳也不触发重赛 |

日志（info，`stamp` 前缀 ISO 时间）：

```
[uplink] path re-race url=<host> cur_ms=<n> best_ms=<n> try=<k>/3
[uplink] path re-race_result url=<host> old_ms=<n> new_ms=<n> better=<true|false>
```

`url=` 只有 hostname。`better=true|false` 是 `new_ms < old_ms`。次数：`grep -c 'path re-race url=' <log>`。

## 舰队上怎么验证

1. **开链竞速是否在挑快路**：`grep '[mesh][dial] ws race' <log>`，看 `winner_ms` 分布是否出现双峰（~90 vs ~180）。
2. **直连是否在换五元组**：`grep '[mesh][rtc] reroll ' <log>`。完整「换到更快路径并把流搬过去」长这样：

   ```
   reroll_request peer=ab12cd34 transport=dc cur_ms=198 best_ms=91 try=1/3
   reroll peer=ab12cd34 transport=dc reason=slow-path|peer-request cur_ms=198 best_ms=91 try=1/3
   signal dropped ... cause=superseded expected_epoch=E received_epoch=E+1
   reroll_result peer=ab12cd34 transport=dc old_ms=198 new_ms=93 better=true
   reroll_rehome peer=ab12cd34 transport=dc streams=2 gain_pct=53
   [mesh][stream] failover_start ... cause=stream_close close_reason=retired from=dc
   ```

   `reroll_result better=true` 的占比是效果指标；重掷后 `dial failed` 集中上升，说明对端还是 2.3.1（没报 `reroll`）。
3. **上行是否在重赛**：`grep 'path re-race' <log>`。`vibeterm relay list` 在该行有 `pathBestMs` 时多一列 `BEST`（毫秒）。`GET /api/mesh/relay/status` 行可选 `pathBestMs` / `reraces`（缺省兼容 2.3.1；`reraces` 为 0 时不下发）。`vibeterm nodes` 不受影响。

## 限制与关闭

- **不能创造不存在的路径。** 两边都只有绕行时，竞速 / 重掷 / 重赛只会反复落到同一条慢路上，预算耗尽后停手。UDP 直连整体差于中继时，靠选路模式的滞环搬到中继，不要指望重掷换出一条不存在的快 UDP。
- **NAT 表压力。** `race=2` 让每次公网拨号的出站 TCP 翻倍（最多 `endpoints × race`）。现网 NAT 表紧张时设 `VIBETERM_WS_DIAL_RACE=1` 即时回退（需重启）。
- **关掉某一条**：
  - 开链竞速：`VIBETERM_WS_DIAL_RACE=1`
  - 直连重掷：`VIBETERM_DC_REROLL=off`（采样仍在）
  - 上行采样 + 重赛：`VIBETERM_UPLINK_PATH_SAMPLING=off`
- 三个键都不进 `config.ts`，mesh 模块本地读 env。
- 选路模式：设置页「延迟优化」或 `vibeterm settings mesh route-mode set auto|direct|relay`；`relay` 强制走中继，`direct` 维持只重掷 DC、不因中继更快而降级。
