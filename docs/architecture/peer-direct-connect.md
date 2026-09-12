# 节点直连：地址退避、WebRTC 熔断、信令代次与失败码

本文描述 node↔node 直连（ws-secure 与 WebRTC DataChannel）在拨号侧的全部保护机制，以及直连失败在接口上的表达方式；面向排查直连问题的运维与改动 `apps/gateway/src/mesh/` 的开发者。链路选择顺序与整体架构见 [多节点架构](./mesh-architecture.md)，前台拨号竞速见 [侧栏节点首屏](../development/sidebar-node-first-paint.md)。跨境运营商按五元组 ECMP 把同一对主机哈希到快慢两条路时，如何换源端口捡快路见 [路径优选](./path-selection.md)。

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

- 退避 `1min → 2min → 4min …`（`ENDPOINT_BACKOFF_MIN_MS` 起跳），上限按失败性质分两档：
  - **软失败** `timeout` / `open-timeout`：封顶 **5 min**（`ENDPOINT_BACKOFF_SOFT_CAP_MS`）。高延迟移动链路上「这次没拨通」多半是网络慢，不该被判成半天不可达。
  - **硬失败** `refused` / `unreachable` / `untrusted` / `reset`：仍是 1min 翻倍到 **6h**（`ENDPOINT_BACKOFF_CAP_MS`）。
- **只有传输可达性失败计数**：上面两档。协议 / 信任类失败（peer-id 不符、签名失败、证书问题）**不缓存**——那是配置问题，重试地址没意义，但也不该把地址标成不可达。
- 任一地址**拨通**即清空该节点的全部退避记录（不只是成功的那一条），并打一条 `endpoint recovered`。
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
- 公网候选：open 预算按观测 RTT 自适应（缺省 `PEER_CONNECT_TIMEOUT_MS = 3000` 时换成 `nestedDialBudgetsMs(rtt).connectMs`，见 [多节点架构](./mesh-architecture.md)「自适应预算」）+ 握手 10s。
- 调用方显式传入的 `connectTimeoutMs` 原样生效（单测注入短值不会被拖长），但会作为 `nestedDialBudgetsMs(rtt, connectTimeoutMs)` 的内层基准把 direct / forward 一并抬上去，嵌套不变式不会因为一个大的自定义值而倒挂。
- `DirectDialLimiter` 是进程单例，默认 4 个并发 endpoint dial（`VIBETERM_PEER_DIRECT_DIAL_CONCURRENCY`，整数 ≥ 1），在**打开 socket 之前**获取名额、`finally` 释放；ranked stagger（250ms 错开）顺序不变。单测里进程级 limiter 在并行文件之间共享，需要隔离时给 `PeerManager` 注入独立 limiter。

### 强制探测

`PeerManager.forceProbe(nodeId, endpoints?)` 绕过负向缓存直接拨（仍要求 peer 可信，仍走正常签名握手）。paused 节点直接返回 `null`，不拨。它只是 gateway 内部方法，没有 HTTP 入口，也没有设置页按钮；排查时只能改地址集合 / 重启来触发清空。

### paused 不发起

`paused` 是 **entry 本机偏好**（表 `node_local_prefs`），不是对端状态。对该 entry 而言：

- `getLink(nodeId, opts?)`：`opts.purpose` 默认 `'user'`，paused 时即使 inbound live 也抛 `NodeUnreachableError`（Forwarder 映射 503 `NODE_UNREACHABLE`）；`'management'` 不闸，给升级 / 卸载 / `/api/system/*` 用。
- pause 退役已有链路（`dropPeer(id, 'paused')` + 清 DC gate / RTC wake / backoff），**不** `deletePeer`。resume 不主动拨号。
- 后台发起方一律跳过：`maybeUpgrade` / `wantsUpgrade`（非 `userPath` / `peerInitiated`）、`forceProbe` / `forceDcProbe`、非对端发起的 RTC wake。入站 `acceptDirect` / `acceptRelay` 不闸。

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

不自动拨 DC，保持 ws-secure / relay。`armDcUpgradeRetry` 只在 `until` 时刻排**一次**探测；熔断处于 `disabled` 时不再排周期探测，
要等显式 rearm（peer 重连、指纹 / endpoint 变化、hub 切换、手动探测）。

**后台升级扫描的门闩**（`peer-dc-upgrade-gate.ts`）：熔断 `disabled`，或最近一次失败码属于重试也打不穿的永久码
（`no_srflx` / `no_candidates` / `stun_unconfigured` / `not_direct_capable` / `rtc_unavailable`）时，15 s 的 endpoint 扫描
**不再拨号**。永久码只抑制 `PERMANENT_FAILURE_HOLD_MS = 60 min`，到期放行一次探测（真拨了才算消耗），再失败重新武装——
一次瞬时的 `no_srflx` 不会把该 peer 永久钉死。前台 `getLink` 与入站 wake 走 `peerInitiated` 分支，不受这个门闩影响。

强制探测各有一个入口：

- gateway：`PeerManager.forceDcProbe(nodeId)`（无 HTTP 接口 / UI 按钮）。
- 浏览器：`GatewayConnection.retryDirect()` → `DirectCarrierController.retryDirect()`，冷却中恰好放行一次。`retry()` 走同一条路径，不清零失败计数；连接 ACTIVE 本身也不清零，仍要满 60s 才 reset。

### 浏览器侧：协商起点与 authorize 熔断

- **协商在 primary `READY`（收到 `HELLO_S2C`）之后才开始**。新网关在 `HELLO_S2C.capabilities` 捎带 `connection-id:<id>`（登记后的会话 id）：客户端跳过转发的 `GET /api/mesh/connection`，`rtc-config` 打 **entry** 的 `/api/mesh/rtc-config`（可与本地 `createOffer` 重叠），只剩 **1 次转发** `POST /n/:T/api/rtc/authorize`。老网关无该能力串时仍先 `GET connection`（转发）再 authorize，共 2 次转发。`/mesh/ws` 的 3 s 首屏闸门不再把直连 attempt 判失败：`signalingReady() === false` 时 REST/ICE 照开，offer 进 outbox，mesh 连上后泵一次。
- 服务端配合：`/api/mesh/connection` 带 `cid` 但尚未登记时返回 404 `NO_CONNECTION` **加 `retryAfterMs: 500`**，客户端据此退避而不是立刻重打（无 `connection-id:` 的旧路径仍走这条）。
- `/api/rtc/authorize` 返回 5xx 时进 per-node **authorize 熔断**（`direct-authorize-breaker.ts`）：连续 3 次失败后冷却 30 s 起跳、封顶 5 min，冷却中不再发起协商。熔断器是**模块级、按 nodeId 共享**的，切路由重建 controller 不会把计数清零；`retryDirect()` 仍放行一次探测。熔断 key 带**登录世代**：登出 / 重新登录（`NodeSessionGuard` 重登成功）时 `resetDirectAuthorizeBreakers()` 让世代 +1 并清空全部冷却，上一个会话留下的冷却不会压住新会话。`pageshow` / 可见恢复时若直连非 `active` 也会 `retryDirect()`。

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

每次状态迁移各一条。熔断只拦**本侧自发**的拨号：对端发起的尝试（收到签名 `wake` 或未绑定的 offer）带 `peerInitiated` 绕过 cooling / disabled 直接应答（本会被拦时打一条 `answer while cooling peer=… level=…`），否则应答方冷却时 offerer 只能等到 `no-remote-sdp`、两侧熔断错峰互锁永不收敛；应答侧的超时 / `no-remote-sdp`（从未收到 offer）不计入熔断。冷却期内跳过的自发拨号打在既有的 `dial failed` 上，带 `cause=breaker_cooling`，同一 peer 仍按 60s 聚合并带 `count=`。另有 `[mesh][rtc] summary`（每 peer 最多 60 s 一条）按 peer 聚合候选对类型的成功 / 失败与拨号耗时。同一 PeerConnection 的 `[mesh][rtc]` 行带 `attempt=` 与 `epoch=`，用来区分重叠拨号。`gather summary` 在本地 ICE gathering 完成时打一条 info，用来判断有没有 srflx。

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

### 入站端口可达性 `ports`

`GET /api/mesh/nodes` 每行（含 self）带可选 `ports?: MeshPortReach[]`：

```ts
{ purpose: PortPurpose; proto: 'tcp' | 'udp'; port?: number; range?: PortRange;
  status: 'open' | 'blocked' | 'unknown';
  code?: 'peer_refused' | 'peer_timeout' | 'no_srflx' | 'turn_unreachable';
  checkedAt?: number }
```

探测只打公网可广告 endpoint（`classifyRemoteAddress !== 'lan'`，跳过 CGNAT / fake-IP）。私网 / 容器 / `198.18` 不探。2.3.0 对端无字段 → `unknown`。从不因单次失败显示 `blocked`。

| 行 | purpose | `open` | `blocked` | 否则 |
|---|---|---|---|---|
| peer | `peer-signaling` | 最近探测成功 | 连续两次失败（`peer_refused` / `peer_timeout`）或 `directFailure.wsCode === 'refused'` | 无公网 endpoint / 单次失败保持原状 → `unknown` |
| peer | `rtc-ice` | 当前 DC 或 24 h 内曾 DC | 从不 | `unknown` |
| self | `peer-signaling` | 任一成员报 `ok` | 本机 PeerServer bind 失败；或 ≥2 人报 refused/timeout 且无人 ok | `unknown`（单样本不够） |
| self | `rtc-ice` | 本进程曾有 srflx 或曾 DC | STUN 探针成功且最近 3 次 gather 都无 srflx → `no_srflx` | `unknown` |

成员互报走 relay 状态块 / hub `node.status` 的可选 `peer_reach`（键为 nodeId 前 8 hex，≤32 条）。`POST /api/mesh/nodes/:id/ports/probe`（`requireSession`）立刻重探并回 `{ ports }`。进程内结果，peer TCP 探测 3 s 截止、每 peer 至多 5 min 一次。节点表只在 `status === 'blocked'` 时警告；详情框可「重新检测」。

## 3. 信令代次、ICE 配置、链路活性与在途流保护

### 信令

陈旧信令重放曾是直连建不起来的主因：`rtcSession = dc:<lo>:<hi>` 对同一对节点恒定，offerer 拨号失败后注销监听，answerer 仍按重试产生新 answer 进入 `rtcInbox`；冷却结束后新 PeerConnection 在 `bindSignaling` 时同步重放 inbox，把 answer 打在 `stable` 状态的 PC 上抛错，或同一次尝试收到两个 answer 导致 PC 绑错 ufrag → `datachannel open timeout`。现在：

- SDP / candidate 的 JSON 信封带可选 `epoch`（offerer 每次拨号生成，answerer 从 offer 回显）；`rtcSession` 字符串不变（hub 路由按 `dc:<a>:<b>` 解析）。收到 `epoch` 已定义且不匹配的消息直接丢弃；`epoch` 未定义视为旧节点，退回按类型过滤。
- Answerer 已绑定 epoch N 时，若再收到 offer N+1：打 `signal dropped cause=superseded`，关掉当前 PC（计为有意关闭，不记熔断），inbox 这条 offer 并立刻开一台新的 answerer PC。更旧的 epoch、`duplicate-answer` 仍直接丢弃。
- Offerer 的 epoch 以**秒级时间基**分配：`rtcAttemptEpochBase(now) = floor(now/1000) * 4096`，进程启动时取一次，之后 `base + 本进程第 n 次拨号`（`rtcAttemptEpochBase` / `nextRtcAttemptEpoch`）。这样 epoch **跨进程重启仍单调递增**（一秒的 uptime 抵得过 4096 次拨号，现实中不可能跑满），重启前的迟到 offer 数值必然更小，不会 supersede 掉重启后新起的 attempt。结果始终是安全整数，对 2.1.x / 2.2.x 的 `isValidOptionalEpoch` 合法。
- Answerer 记住每个 peer 见过的最高 offer epoch（`OfferEpochMemory`），用来丢弃被取代的旧 attempt 留下的在途信令。**这份记忆有 30 s 有效期**（`RTC_OFFER_EPOCH_TTL_MS`），且只有不低于已记住值的 epoch 才续期。TTL 是兜底：给 epoch 计数器从 0 重来的旧版本对端（≤2.2.2）留恢复路径——否则一旦记住旧高位，对端重启后的每个 offer 都会被判 `epoch-mismatch` 永久拒收，现象是应答侧 `dial timeout … stage=gathering local_types=[] remote_types=[]`、offerer 侧同时 `stage=no-remote-sdp`，该 peer 再也建不起 DC（round40 现网实测）。
- Answerer 在 offer 到达前收到的 candidate 按其 `epoch` 入队（不再直接丢弃），offer 落地后只 flush 与最终 epoch 一致的那些，其余打 `signal dropped cause=epoch-mismatch`；低于已记住 epoch 的 candidate 仍在入队前就丢弃。队列每 attempt 上限 `RTC_PENDING_CANDIDATE_MAX = 64` 并按 `candidate+mid+epoch` 去重，超出打 `signal dropped cause=pending-overflow|duplicate dropped=<累计>`（首条与每 64 条各一次），防止对端在 offer 前灌爆队列。
- 未绑定信令进 `rtcInbox` 时：该 peer 的 inbox 非空即视为「尝试正在建立」，紧随 offer 之后到达的 candidate 不会被当成无主信令丢掉。
- `bindSignaling` 带 `expect: 'offer' | 'answer'`，错类型丢弃，offerer 每次尝试只应用一个 answer；`setRemoteDescription` 失败打 info 且不再把 candidate 喂给 libdatachannel（先排队，等远端描述应用成功再 flush）。
- `bindSignaling` 与 `trackPc` 纳入 `connectToPeer` 统一清理区；inbox 重放走 microtask 且先返回 unsubscribe；inbox 条目带 `receivedAt`，30 s 过期；offerer 无监听时不缓存 answer，无尝试时不缓存 candidate。
- `PeerDialer` 对每个 peer 只有一条在途 `connectToPeer`（single-flight）：前台 `getLink` 复用 in-flight Promise，后台升级看到 in-flight 就跳过 DC、不另开 PC。single-flight 只去重 DC，不挡住 ws-secure；后台升级 DC 与 ws-secure 并行。前台直连截止不 abort DC 腿，以便中继也失败时还能吃到 late winner；`getLink` 在 live 已建立时清掉 `pending`（DC 去重交给 `dcInflight`）。
- 测试假件 `FakePeerConnection` 实现 `stable / have-local-offer / have-remote-offer` 状态机并复现 libdatachannel 的异常。

### DataChannel 握手

通道打开到 mux 接管之间有一段自定义握手（hello / sig / done）。旧实现在 `waitChannelOpen` 之后才挂接收回调，对端在这之前发来的
hello 全落进 fanout 的 8 槽 dump 缓冲，跨 NAT、offerer 先 connected 的一对能稳定把它撑爆并关掉 PeerConnection。现在：

- `runPeerHandshake` 在等待通道打开 / 本地指纹**之前**就 `attachHandshakeRecv`，早到的帧进握手队列。
- 握手队列按类型去重（`hello` / `sig` / `done` 各只留最新一条），上限 `DC_HANDSHAKE_MAX_QUEUE = 64`。
- hello 重发间隔 `DC_HANDSHAKE_HELLO_INTERVAL_MS = 500`（旧版是 40 ms），收到对端 hello 或 sig 即停。
- 非握手的 ctl JSON（如 `{t:'ping'}`）不占握手槽，按原顺序进 payload 缓冲，握手完成后 reinject 给 `DataChannelLink`，
  不会让认为握手已完成的旧对端丢掉 mux 控制帧；无法解析的帧直接丢弃。
- fanout 的 `onOpen` 去重：通道已 open 时同步触发一次，native 再回调忽略。

兼容：≤ 2.2.x 的 offerer 仍按 40 ms 狂发 hello，新的 answerer 靠「先挂队列 + 按类型去重」吞得下；线格式没变。

### ICE / 拨号

- ICE 服务器列表按「节点自定义 > 节点禁用 > hub/中继下发的自定义列表 > 发行版内置列表」求解，并按 STUN 探针 RTT 排序（新鲜可达的靠前，失败只降权不删除）。浏览器读 `GET /api/mesh/rtc-config`，回包带 `source` 字段说明这四档里的哪一档；语义与排查见 [mesh 运维](../operations/mesh-operations.md)。
- **TURN 按条门控**：hub / 中继下发的 TURN 可能有多条（每台中继至多一条，中继角色自带 TURN）。每个 URL 各做一次 STUN Binding 可达探测（并发 2），**只有探测 `ok` 的条目**按 RTT 升序取前两条进 `iceServers`；探测失败、尚未探测、`turns:` / `?transport=tcp`（libjuice 不支持）一律排除。日志 `[mesh][rtc] turn gate configured=N reachable=M used=[…]`（used 集合变化才打）。`GET /api/mesh/rtc-config` 的 `turn` 是实际进 ICE 的数组，`turnConfigured` 是全部已知条目，`turnProbes` 每条 configured URL 一份探测记录（`turnProbe` 保留第一条，兼容旧前端）。
- **丢弃 fake-IP 候选**：地址落在 `198.18.0.0/15`（Surge / Clash 增强模式的 fake-IP）的 host 候选**收发两侧**都丢弃，日志 `signal dropped … cause=fake-ip`；RFC1918（`10/8`、`192.168/16` 等）保留，局域网直连不受影响。单边升级即生效。
- `buildRtcIceConfig`：`enableIceTcp`、`enableIceUdpMux`（**仅当列表里真有可达 TURN 时才为 false**：libjuice mux 不支持 TURN。没有可达 TURN 就保持 mux 并把 TURN 全部从 `iceServers` 剥掉——早期「先纳入、探测后再说」会让 gathering 挂死、srflx 一起消失。Binding 探测只证明 UDP 通，不能代替带凭证的 Allocate，见 [KI-4](../known-issues.md)）、`mtu: 1200`；`peerBindHost` 为单一具体地址时写入 `bindAddress`；`VIBETERM_RTC_PORT_RANGE=begin-end` 映射 UDP 端口范围（非中继缺省 `40000-40099`，中继主机 `40050-40099`，见 `@vibeterm/shared/net`；**未设该键时 ICE 仍走系统临时口**。`init` / `upgrade` 按角色写入。node-datachannel 0.33 无网卡过滤 API，未做接口过滤，见 [已知问题](../known-issues.md) KI-3）。`connectToPeer` 走 `buildRtcIceConfigResolved`：STUN/TURN 主机名先系统 DNS、再在 fake-IP 时 DoH，把 IP 字面量交给 libdatachannel，避免 Surge 增强模式把 STUN 打进 TUN（见 [隧道边缘与 STUN 的 fake-IP 绕行](../operations/tunnel-edge-fake-ip.md)）。
- **ws-secure 开链竞速**：公网目标同时开 `VIBETERM_WS_DIAL_RACE` 条（默认 2，夹紧 1..4），取最先 `open` 的一条，其余不发字节即关（`close(1000, 'ws-race-loser')`）。局域网不竞速。日志 `[mesh][dial] ws race url=<host> winner_ms=… others_ms=… count=…`。入站握手限流因此从 10 提到 **30**/IP/min。hub / 中继上行同一套。详见 [路径优选](./path-selection.md)。
- **慢路径重掷**：live DC / ws-secure 的稳态 RTT 明显高于该对端 30 min 窗内的 best 时，offerer 再拨一条新链（DC 需对端报 `reroll` 能力位，2.3.1 不报则不发起），make-before-break 换链，提升 ≥ 30 % 时把在途流搬过去。日志 `reroll` / `reroll_result` / `reroll_rehome`。`VIBETERM_DC_REROLL=off` 关闭。详见 [路径优选](./path-selection.md)。

- `connectToPeer` 四阶段共用一个 15 s deadline（后台升级扫描）；前台 `getLink()` 走更短的竞速预算（`nestedDialBudgetsMs(rtt).directMs`），见 [侧栏节点首屏](../development/sidebar-node-first-paint.md)。已知该 peer 在中继 presence 上时，前台无 live 链路会**并行**开中继：直连先成则 abort 中继；中继先成则让直连继续，晚到 DC/ws-secure 走 `track()` 升级。无 presence 时仍「直连竞速 → 再 `completeRelayDial`」。`waitLocalFingerprint` 为回调扇出。
- node↔node 由 nodeId 字典序较小的一侧发 offer；业务请求只发生在较大 id 一侧时，该侧经 hub `rtc.signal` 发签名 wake（详见 [mesh 运维](../operations/mesh-operations.md)「Nodes 页」）。

### 活性与在途流

- ws-secure / relay 链路 ping 5 s × 3 次；`LinkMux.lastFrameAt` 让任意入站帧重置漏计。
- node↔node DataChannel 空闲时每 `RTC_LIVENESS_INTERVAL_MS`（默认 3 s）发 ping/pong，任意入站流量重置计时；连续 `RTC_LIVENESS_TIMEOUT_MS`（默认 10 s）无入站则关闭该 DC/PeerConnection 并回落，日志 `[mesh][rtc] liveness timeout peer=… idle_ms=…`。不能只等 ICE `disconnected`→`closed`（约 35 s）。
- `dropPeer` 的 `missed-pong` / `idle` 在 `live.streams > 0` 时走退休宽限（保留原因），`revoked` / `stopped` 仍立即关闭。
- **DC 取代中继 / ws-secure 是 make-before-break**：新 session 立刻成为 live（新流走新链路），旧 session 标 `retiring` 并排空。
  旧实现同一毫秒就 `stream.reset('replaced')`，而 `replaced` 会让 hub / 中继侧 `abortBoth`，正在跑的终端流当场断——「一升级直连就掉」
  的直接成因。现在只要 `streams > 0` 就不结束退役，按 quiet / min / max 规则等排空；防泄漏硬上限
  `PEER_RETIRE_STREAM_LEAK_MS = 30 min`，到点强制关闭且原因改成 `retired`（不再用 `replaced` 砸整条 uplink）。
  心跳失活 / 闲置这类退役仍有 `PEER_RETIRE_MAX_MS = 30 s` 的硬截止，先于流数判断。
- **DC 空闲拆链 30 min**（`PEER_DC_IDLE_MS`），relay / ws-secure 仍是 `PEER_IDLE_MS = 5 min`：5 min 对「用户刚用过、马上还要用」
  太短，反复重建 DC 本身就是抖动源。DC 因 idle 结束时只关它自己那条 session，仍在排空的中继会被 promote 回 live。
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
