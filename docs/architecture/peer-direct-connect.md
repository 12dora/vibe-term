# 节点直连：地址退避、WebRTC 熔断、信令代次与失败码

本文描述 node↔node 直连（ws-secure 与 WebRTC DataChannel）在拨号侧的全部保护机制，以及直连失败在接口上的表达方式；面向排查直连问题的运维与改动 `apps/gateway/src/mesh/` 的开发者。链路选择顺序与整体架构见 [多节点架构](./mesh-architecture.md)，前台拨号竞速见 [侧栏节点首屏](../development/sidebar-node-first-paint.md)。

## 1. 直连地址的负向缓存与退避

节点通过 hub 的 `node.list`（或中继的 `relay.list`）拿到对端广播的 LAN 地址，直连时把这些地址并行 race 一遍。没有记忆时，一批**永远不可达**的地址（docker 网桥 `172.17.x`、CGNAT `100.64/10`、IPv6 ULA）会在每次升级尝试时被全量重打，日志刷屏且拖慢回落 relay。为此有四层刹车：广播端少发、拨号端记住失败、LAN 候选设总预算、进程级限制并发。

### 广播端过滤（`enumeratePeerEndpoints`）

枚举网卡时保留网卡名，按名字跳过容器向网卡：`docker*`、`veth*`、`br-*`、`virbr*`、`lxdbr*`、`lxcbr*`、`cni*`、`flannel*`、`podman*`。**不跳过** `utun*` / `tun*`（Tailscale、WireGuard 要用）。

地址族规则：

- IPv6 ULA `fc00::/7` 与废弃的 site-local `fec0::/10` 默认不广播。
- CGNAT `100.64/10` 默认不广播，仅当本机自己有非 internal 的 `100.64/10` 地址时才广播（Tailscale 场景）。
- 普通网卡上的 RFC1918（`10.x`、`192.168.x`、`172.16–31.x`）照常广播。

真正挡住 docker 网桥的是**网卡名过滤**；地址段规则只是补漏。运营商把 `100.64` 配在 `en0` / `ppp0` 上时仍会广播，由接收侧退避消化。**两侧都升级才彻底干净**：广播端升级后别人才看不到它的 docker 地址；接收端的退避用来保护面对尚未升级的旧广播者。

### 拨号端负向缓存（`PeerEndpointBackoff`）

key 是 `(nodeId, canonical host, port)`——canonical 会把 IPv4-mapped 形式归一，同一地址的不同写法算同一条。

- 退避 `1min → 2min → 4min …`，上限 **6h**（`ENDPOINT_BACKOFF_MIN_MS` / `ENDPOINT_BACKOFF_CAP_MS`）。
- **只有传输可达性失败计数**：`timeout`、`open-timeout`、`refused`、`unreachable`、`reset`。协议 / 信任类失败（peer-id 不符、签名失败、证书问题、`not-trusted`）**不缓存**——那是配置问题，重试地址没意义，但也不该把地址标成不可达。
- 成功即清除该地址；此前有过失败时打一条 `endpoint recovered`。
- 清空时机：对端广播的 endpoint 集合（canonical host+port 排序集）**实际发生变化**时清该节点；节点被吊销时清该节点；15s 扫描发现本机非 internal 地址指纹变化时 `resetAll()`（同时重置 uplink 退避）。
- 空闲超过 24h 的条目被修剪。

日志（`[mesh][peer]` 前缀），在 fails = 1、3，以及之后每次翻倍（6、12、24…）打一条：

```
endpoint backoff node=<id> addr=<host:port> fails=<n> next=<iso>
endpoint recovered node=<id> addr=<host:port>
```

`dialWsSecure()` 先按退避过滤候选再 race，每个候选的成功 / 失败都回记。**全部候选都在退避中**时立即返回，让上层直接回落 relay，失败码为 `backoff`（见 §4）。

### LAN 预算与并发

- LAN 候选（`classifyRemoteAddress === 'lan'`）总预算 `PEER_LAN_DIAL_TIMEOUT_MS = 4000`，**open + 握手合计**；超时 abort 并关闭 socket。
- 公网候选：open 3s（`PEER_CONNECT_TIMEOUT_MS`）+ 握手 10s。
- 显式传入更短的 `connectTimeoutMs` 仍然生效（取 `min(connect, total)`）。
- `DirectDialLimiter` 是进程单例，默认 4 个并发 endpoint dial（`VIBETERM_PEER_DIRECT_DIAL_CONCURRENCY`，整数 ≥ 1），在**打开 socket 之前**获取名额、`finally` 释放；ranked stagger（250ms 错开）顺序不变。单测里进程级 limiter 在并行文件之间共享，需要隔离时给 `PeerManager` 注入独立 limiter。

### 强制探测

`PeerManager.forceProbe(nodeId, endpoints?)` 绕过负向缓存直接拨（仍要求 peer 可信，仍走正常签名握手）。它只是 gateway 内部方法，没有 HTTP 入口，也没有设置页按钮；排查时只能改地址集合 / 重启来触发清空。

## 2. WebRTC 直连熔断器

熔断针对的病灶是**通道能打开但立刻死掉**（`datachannel closed/error`、liveness timeout、missed pong）：只在拨号 catch 里计数的熔断器永远熔断不了这类链路，`dropPeer` 还会直接排下一轮升级重试。gateway 与浏览器两侧使用同一套策略。

### 策略

| 项 | 值 |
| --- | --- |
| 触发阈值 | 连续 **3** 次失败 |
| 冷却阶梯 | 30s → 60s → 120s … 上限 **30min** |
| 复位条件 | 通道保持健康 **≥ 60s** |

- `cooldownLevel` 在冷却过期后**仍然保留**，下次再触发直接用更长的一档。短命通道（开了不到 60s 就死）计一次失败，不会把 level 降回去。
- 复位只认「健康满 60s」。`noteSuccess()` 是 no-op；`notePeerChanged()`（endpoints / inventory / `direct_capable` 变化）只清掉在途 attempt 标记，不清零计数。
- 失败按 attempt / session id 去重：同一次尝试从多条路径报错只计一次。
- 熔断器 `skipKinds` 排除本地信令状态错误；到达永久禁用阈值后每 10 min 允许一次 `forceProbe`。

**算失败**：拨号失败，以及通道打开后的异常关闭——`liveness-timeout`、`missed-pong`、`timeout`、`ice`、`channel-error`、`channel-closed`、`protocol`、`transport-lost`。

**不算失败**（有意的关闭）：`stopped`、`revoked`、`idle`、`replaced`、`stale`、`not-trusted`、`lower-priority`、`simultaneous-dial`、`superseded`。`dialDc` 对 `AbortError` 及消息里含 `abort` 的错误也不计，避免 `stop()` 与竞态 abort 误触发。注意被取消的拨号若晚到失败仍照记进熔断器——否则「取消」会把 DC 坏掉这件事从账上抹掉。同一 `peer+attemptId` 的 `beginAttempt` / `noteFailure` 幂等，竞速 abort 后 `settleAbandonedDcDial` 不会再记一笔。熔断器只活在进程内存里，gateway 重启即清零。

### 冷却期间

不自动拨 DC，保持 ws-secure / relay。`armDcUpgradeRetry` 只在 `until` 时刻排**一次**探测。强制探测各有一个入口：

- gateway：`PeerManager.forceDcProbe(nodeId)`（无 HTTP 接口 / UI 按钮）。
- 浏览器：`GatewayConnection.retryDirect()` → `DirectCarrierController.retryDirect()`，冷却中恰好放行一次。`retry()` 走同一条路径，不清零失败计数；连接 ACTIVE 本身也不清零，仍要满 60s 才 reset。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VIBETERM_RTC_DIAL_BREAKER_MS` | `30000` | **起始**冷却时长（阶梯第一档）。指数上限仍是 30min，失败阈值不受影响 |

`init` / `upgrade` 不写这个键，只有手动配置才出现。

### 日志

```
[mesh][rtc] breaker trip peer=<id> fails=<n> level=<n> cooldown_ms=<ms> until=<iso>
[mesh][rtc] breaker reset peer=<id> healthy_ms=<ms>
[mesh][rtc] gather summary peer=<id> attempt=<id> host=<n> srflx=<n> relay=<n> stun_count=<n> turn=<bool>
[mesh][rtc] dial timeout peer=<id> stage=<gathering|no-remote-sdp|checking|dtls|handshake> local_types=[…] remote_types=[…] stun_count=<n> turn=<bool>
[mesh][rtc] dial failed peer=<id> reason=… stun_count=<n> turn=<bool> attempt=<id>
```

每次状态迁移各一条。冷却期内跳过的拨号打在既有的 `dial failed` 上，带 `cause=breaker_cooling`，同一 peer 仍按 60s 聚合并带 `count=`。另有 `[mesh][rtc] summary`（每 peer 最多 60 s 一条）按 peer 聚合候选对类型的成功 / 失败与拨号耗时。同一 PeerConnection 的 `[mesh][rtc]` 行带 `attempt=` 与 `epoch=`，用来区分重叠拨号。`gather summary` 在本地 ICE gathering 完成时打一条 info，用来判断有没有 srflx。

### 对外字段

`GET /api/mesh/nodes` 的行上有可选字段：

```ts
MeshNode.dcBreaker?: {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
} | null
```

本机（self）为 `null`。**WS `NODE_EVENT` 帧不带 `dcBreaker`**：borsh schema 未升版，进程内的 `NodeEventPayload.dcBreaker` 只用于 gateway 侧事件去重。前端若只订阅 WS 事件，要等下一次 REST 刷新才能看到熔断状态变化。浏览器侧 `DirectDiagnostics` 带可选的 `cooling` / `until` / `failures` / `level` / `lastFailureKind`，由 `DirectCarrierController` 快照填充。

熔断只关 DataChannel 这一档，不改 transport 优先级，也不改 `directCapable !== false` 的门闩：ws-secure 与 relay 不受影响，用户看到的是链路徽标从「直连」退到「局域网 / 中继」。UI 不单独展示熔断状态，排查请看日志或直接读 REST。

## 3. 信令代次、ICE 配置、链路活性与在途流保护

### 信令

陈旧信令重放曾是直连建不起来的主因：`rtcSession = dc:<lo>:<hi>` 对同一对节点恒定，offerer 拨号失败后注销监听，answerer 仍按重试产生新 answer 进入 `rtcInbox`；冷却结束后新 PeerConnection 在 `bindSignaling` 时同步重放 inbox，把 answer 打在 `stable` 状态的 PC 上抛错，或同一次尝试收到两个 answer 导致 PC 绑错 ufrag → `datachannel open timeout`。现在：

- SDP / candidate 的 JSON 信封带可选 `epoch`（offerer 每次拨号生成，answerer 从 offer 回显）；`rtcSession` 字符串不变（hub 路由按 `dc:<a>:<b>` 解析）。收到 `epoch` 已定义且不匹配的消息直接丢弃；`epoch` 未定义视为旧节点，退回按类型过滤。
- Answerer 已绑定 epoch N 时，若再收到 offer N+1：打 `signal dropped cause=superseded`，关掉当前 PC（计为有意关闭，不记熔断），inbox 这条 offer 并立刻开一台新的 answerer PC。更旧的 epoch、`duplicate-answer`、以及 epoch 尚未确定时提前到达的 candidate 仍直接丢弃。
- `bindSignaling` 带 `expect: 'offer' | 'answer'`，错类型丢弃，offerer 每次尝试只应用一个 answer；`setRemoteDescription` 失败打 info 且不再把 candidate 喂给 libdatachannel（先排队，等远端描述应用成功再 flush）。
- `bindSignaling` 与 `trackPc` 纳入 `connectToPeer` 统一清理区；inbox 重放走 microtask 且先返回 unsubscribe；inbox 条目带 `receivedAt`，30 s 过期；offerer 无监听时不缓存 answer，无尝试时不缓存 candidate。
- `PeerDialer` 对每个 peer 只有一条在途 `connectToPeer`（single-flight）：前台 `getLink` 复用 in-flight Promise，后台升级看到 in-flight 就跳过 DC、不另开 PC。single-flight 只去重 DC，不挡住 ws-secure；后台升级 DC 与 ws-secure 并行。前台 4 s 竞速截止不 abort DC 腿，以便中继也失败时还能吃到 late winner；`getLink` 在 live 已建立时清掉 `pending`（DC 去重交给 `dcInflight`）。
- 测试假件 `FakePeerConnection` 实现 `stable / have-local-offer / have-remote-offer` 状态机并复现 libdatachannel 的异常。

### ICE / 拨号

- `buildRtcIceConfig`：`enableIceTcp`、`enableIceUdpMux`、`mtu: 1200`；`peerBindHost` 为单一具体地址时写入 `bindAddress`；`VIBETERM_RTC_PORT_RANGE=begin-end` 映射 UDP 端口范围（node-datachannel 0.33 无网卡过滤 API，未做接口过滤，见 [已知问题](../known-issues.md) KI-3）。`connectToPeer` 走 `buildRtcIceConfigResolved`：STUN/TURN 主机名先系统 DNS、再在 fake-IP 时 DoH，把 IP 字面量交给 libdatachannel，避免 Surge 增强模式把 STUN 打进 TUN（见 [隧道边缘与 STUN 的 fake-IP 绕行](../operations/tunnel-edge-fake-ip.md)）。

- `connectToPeer` 四阶段共用一个 15 s deadline（后台升级扫描）；前台 `getLink()` 走更短的竞速预算，见 [侧栏节点首屏](../development/sidebar-node-first-paint.md)。`waitLocalFingerprint` 为回调扇出。
- node↔node 由 nodeId 字典序较小的一侧发 offer；业务请求只发生在较大 id 一侧时，该侧经 hub `rtc.signal` 发签名 wake（详见 [mesh 运维](../operations/mesh-operations.md)「Nodes 页」）。

### 活性与在途流

- ws-secure / relay 链路 ping 5 s × 3 次；`LinkMux.lastFrameAt` 让任意入站帧重置漏计。
- node↔node DataChannel 空闲时每 `RTC_LIVENESS_INTERVAL_MS`（默认 3 s）发 ping/pong，任意入站流量重置计时；连续 `RTC_LIVENESS_TIMEOUT_MS`（默认 10 s）无入站则关闭该 DC/PeerConnection 并回落，日志 `[mesh][rtc] liveness timeout peer=… idle_ms=…`。不能只等 ICE `disconnected`→`closed`（约 35 s）。
- `dropPeer` 的 `missed-pong` / `idle` 在 `live.streams > 0` 时走退休宽限（保留原因），`revoked` / `stopped` 仍立即关闭。
- relay client / pool 双层追踪在途隧道流；就近切换、回切、reconfigure 等待排空（每 3 s 复查，10 min 硬上限，到期剩余流被 reset）；`retireClient` 停止接新流并排空后再 `stop()`；死链仍立即处理。
- 中继 registry 记录 `lastByteAt`，心跳期间有流量不累加 miss；令牌桶按逻辑流独立排队、4 KiB quantum 轮转，≤ 4 KiB 帧走优先通道；`pumpMetered` 单向失败先 half-close，RST 原因细化为 `relay-rst:src-read` / `relay-rst:dst-write` / `relay-rst:peer-abort`（保留 `relay-rst` 前缀）。
- 发送分片 16 KiB（接收上限仍 64 KiB，向后兼容）；`MAX_LINK_UNACKED` 为 65 × 1 MiB，覆盖默认 64 条中继流——代价是单 mux 最坏内存占用上升（KI-5）。
- forwarder failover 退避序列末尾追加 3200 / 6400 ms（总预算约 15 s）。

兼容：≤ 1.1.30 的节点省略 `epoch`，新节点退回类型过滤；ping / pong 载荷不变，只是发送周期缩短；RST 原因保持前缀；分片只降发送端。

## 4. 直连失败码与链路信息窗

链路徽标的信息窗（`apps/fe/src/node/device-node-badges.tsx`，`data-testid="ice-diagnostics"`）里的未直连原因、ICE 状态、候选类型与候选对都按稳定码翻译，原文只作兜底。

服务端把两类原因收敛成**稳定错误码**（`DirectFailureCode`）连同插值参数一起下发，原文保留给旧前端兜底；前端按码翻 `nodes.badge.failure.<code>`，码缺失或不认识就显示原文。码表是对外契约：`packages/api-client/src/auth/types.ts` 的 `DIRECT_FAILURE_CODES`；网关不依赖 `@vibeterm/api-client`，在 `apps/gateway/src/mesh/peer-manager-types.ts` 镜像一份——**改码表要两边一起改，并同步三语文案**。

25 个码：`timeout`、`refused`、`unreachable`、`reset`、`tls`、`handshake`、`revoked`、`untrusted`、`backoff`、`no_endpoints`、`ice_failed`、`no_candidates`、`dc_open_timeout`、`dc_closed`、`liveness_timeout`、`signal_dropped`、`signaling_state`、`rtc_unavailable`、`not_direct_capable`、`breaker_cooling`、`breaker_paused`、`aborted`、`no_srflx`、`stun_unconfigured`、`other`。

DTO（`MeshNodeDirectFailure`）：

```ts
{ at, ws?, wsCode?, wsParams?: { url?, seconds? }, dc?, dcCode?, dcParams?: { until? } }
```

`ws` / `dc` 是原文，`*Code` / `*Params` 是结构化字段；旧网关不下发 code，前端自动回落原文。

### 映射表

映射与 `dcFailureReason` 都在 `apps/gateway/src/mesh/direct-failure-codes.ts`。

ws 侧：分类器是 `peer-ws-race.ts` 的 `classifyWsDialKind`（`PeerHandshakeError.code === 'revoked'` 单独成 `revoked`；证书类报文成 `tls`；`not-trusted` 类成 `untrusted`）。

| kind | 码 |
|---|---|
| `timeout` / `open-timeout` | `timeout` |
| `refused` | `refused` |
| `unreachable` | `unreachable` |
| `reset` | `reset` |
| `protocol` | `handshake` |
| `tls` / `revoked` / `untrusted` / `aborted` / `other` | 同名 |

`raceWsSecureEndpoints` 返回 `WsSecureRaceResult`，带 `lastKind` 与 `lastUrl`。三个记录点（`peer-direct-attempt.ts`）：

| 场景 | 记录函数 | 码 | 参数 |
|---|---|---|---|
| 一个地址都没公布 | `noteNoEndpoints` | `no_endpoints` | — |
| 全部地址在退避中 | `noteWsBackoff` | `backoff` | `seconds` |
| 竞速失败 | `noteWsRaceFailure` | `wsFailureCode(lastKind)` | `url` |

DataChannel 侧：`dcFailureReason` 返回 `{ text, code, params? }`，分类复用熔断器的 `classifyRtcDialFailure`；分类前先摘出「no (ice) candidates / candidates exhausted」→ `no_candidates`。

| 分类 | 码 |
|---|---|
| `signal-dropped` | `signal_dropped` |
| `liveness-timeout` / `missed-pong` | `liveness_timeout` |
| `timeout` | `dc_open_timeout` |
| `ice` | `ice_failed` |
| `abort` | `aborted` |
| `protocol` | `handshake` |
| `channel-error` / `channel-closed` / `transport-lost` | `dc_closed` |
| `signaling-state` | `signaling_state` |
| `no srflx candidates` | `no_srflx` |
| `stun unconfigured` | `stun_unconfigured` |
| 其余 | `other` |

前置判定（不进分类器）：`directCapable === false` → `not_direct_capable`；WebRTC 不可用 → `rtc_unavailable`；熔断未放行 → `breaker_cooling` / `breaker_paused`。

### `breaker_cooling` 与 `breaker_paused`

`dial()` 把 `dcBreaker.shouldTry()` 的 `until` 记进 `dcCoolingUntil` 传给 `finishDirectAttempt`。`coolingUntil !== undefined` 表示这轮压根没拨号（`undefined` 才是「拨了但失败」）：

| 情况 | 码 | 参数 | 文案 |
|---|---|---|---|
| 熔断冷却，有解除时刻 | `breaker_cooling` | `until`（epoch ms） | 「暂停至 {{until}}」 |
| 熔断生效但无解除时刻（永久禁拨） | `breaker_paused` | — | 「直连已暂停」 |

分成两个码是因为 `breaker_cooling` 的三语模板都要 `{{until}}`。前端对不下发新码的旧网关也兼容——`dcCode === 'breaker_cooling'` 且没有 `until` 时按 `breaker_paused` 显示。

### 前端渲染

`directFailureRows(failure)`（`device-node-badges.tsx`）：码缺失（旧网关）或不在 `DIRECT_FAILURE_CODES` 里（新网关配旧前端）一律显示原文并用等宽字体——等宽只留给机器措辞；`until` 在前端按本地时区格式化成 `HH:MM` 再插值；`direct-diagnostics.ts` 的 `normalizeDirectFailure` 先校验一遍码与参数，组件侧再兜一层。

ICE 明细同样按枚举翻译：`connectionState` / `iceConnectionState` → `nodes.badge.ice.<state>`（W3C 枚举 8 个），候选类型 → `nodes.badge.candidate.<host|srflx|prflx|relay>`，浏览器方言原样展示。`selectedPair` 保持 `本端 → 对端` 形状、两端各自翻译，两端都取不到时退回整串原文。RTT 单位仍是 `ms`，`peerAddress` 保留原文。

文案：`nodes.badge.failure.*`（25）、`nodes.badge.ice.*`（8）、`nodes.badge.candidate.*`（4），三语同步。

## 测试

- `apps/gateway/src/mesh/direct-failure-code.test.ts`、`peer-direct-attempt.test.ts`：码表全表映射、记录与清空。
- `apps/gateway/src/mesh/peer-manager.test.ts`、`peer-dial-race.test.ts`、`rtc/liveness.test.ts`：退避、熔断、竞速与活性。
- `apps/fe/src/node/device-node-badges.test.tsx`：按码翻译、`until` 格式化、回落原文。
- 信令代次、ICE-TCP 与端口范围只有 fake / 内存传输的测试，缺真实 NAT 环境的集成验证（KI-6）。
