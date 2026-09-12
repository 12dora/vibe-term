# 侧栏节点首屏：冷启动后远端节点如何尽快出现

本文描述冷启动（重开 PWA）时侧栏远端节点分节的渲染策略：pending 占位、mesh 节点首帧缓存、有界重试、静默登录、mesh WS 重连唤醒，以及后端的前台拨号竞速与 hub presence 陈旧窗口；面向改动 `apps/fe/src/node/` 与 `apps/gateway/src/mesh/peer-manager*.ts` 的开发者。

## 背景

渲染一个远端节点分节要串起四个条件：`meshEnabled`（`/api/auth/mode` 返回 mesh）→ `/api/mesh/nodes`
已返回 → 节点 online 且已登录 → `/n/<id>/api/devices` 已返回。任何一环没落地，分节就整体消失（不是「显示为离线」，而是连节点名一起没有）。2.0.8 起 `apps/fe` 有应用壳 service worker（见 [前端流畅度](./performance-frontend.md) §4），静态壳可离线秒开，但数据仍要重新拉取。会拖慢这四环的因素：

| 编号 | 因素 |
|---|---|
| H1 | 设备列表 pending 期间 `shouldHideSidebarNodeSection` 对非 self 返回 true，整节 `return null`，连骨架都没有 |
| H2 | `dial()` 先 `await tryDc`，DC 超时 15 s；熔断因网络指纹变化 rearm 后立刻又 15 s；forwarder 的 GET 重试 4 次无总 deadline |
| H3 | uplink 不在线时 `listHubOnline()` 返回空集，节点整批判离线；uplink 20 s 超时 + 60 s 退避会留下分钟级空档 |
| H4 | 无首屏缓存，且 `/api/auth/mode` 与 `/api/mesh/nodes` 串行两次往返；`ensureAuthMode` 失败被永久记住 |
| H5 | 首次 `/api/mesh/nodes` 失败后 5 min 内不重试 |
| H6 | 18 h 会话过期后分节退化成手动「登录此节点」按钮 |
| H7 | mesh WS 重连退避在页面恢复时不重置，无 `visibilitychange` / `online` 监听 |

## 前端（H1 / H4 / H5 / H6 / H7）

**H1 —— pending 不再整节隐藏**

- `device-tree-selectors.ts`：`SidebarDeviceStats` 加 `pending`，`shouldHideSidebarNodeSection` 在
  `pending === true` 时一律返回 false。
- `use-sidebar-device-stats.ts`：返回 `pending`（`isPending || isPlaceholderData`）、`devices` 与
  `succeeded`（`isSuccess && !isPlaceholderData`）。
- `sidebar-device-list-runtime.tsx`：pending 时渲染**分节头 + 占位设备行**（有本地快照就灰显上次的设备名，
  一台都不知道时给两条骨架），落地后才挂真实设备树。
- `sidebar-node-section.tsx`：首帧占位取自 `offlineDevices(runtimeNodeId, inventory)`
  （`vibeterm:device-snapshot:*`），并在真实列表落地时回写快照——**此前只有设备页写快照**，从没进过设备页的
  用户永远没有首帧数据。回写只认 `succeeded`：一次网络故障不再把成功过的快照覆盖成空数组
  （成功返回的空列表照常保存）。

**H4 —— 首帧缓存 + mode 不再「失败即永久记住」**

- 新增 `mesh-nodes-cache.ts`：localStorage `vibeterm:mesh-nodes`（版本号 + `savedAt`，7 天过期、≤64 行、
  读写全部 try/catch）。**只落身份、在线态与 `paused: true`**（否则冷启动侧栏会闪出已暂停节点），链路现场（reach / transport / rttMs / peerAddress /
  linkSinceAt / directFailure）一律清空——它们描述上一次会话的那条链路，冷启动后必然是错的。
  也不落整份 `mode`（含 `passkeySecondFactorWaived` 等鉴权语义字段），只留 `mesh: boolean` 与 `entryNodeId`。
- 模块加载时 `hydrateMeshNodesFromCache()` 同步把上次列表读回来并标 `stale: true`；`meshEnabledOf(state)`
  在 mode 未落地时退回缓存值，于是**冷启动第一帧就能渲染聚合视图，`/api/mesh/nodes` 与 `/api/auth/mode`
  并发发出**（原本串行两次往返）。远端门闸在 `meshEnabledOf` 下若缓存/列表**已有这一行**，按 `loggedIn` 当场判定（`true` → `ready`，不等 `loadedAt` / mode；在线且未登录 → 静默登录；离线 → `ready`）。缓存和列表都没有这一行才 `pending` 等 REST。
- 缓存作废的唯一入口：mode 落地为 standalone、或 entry nodeId 与缓存不一致，外加 7 天过期。
- `ensureAuthMode` 的 catch 里清掉 `modePromise` 并排一次有界重试。

**H5 —— 首拉失败有界重试**

`mesh-recovery.ts` 的 `createRetryScheduler`：**1 / 3 / 10 秒三次**（有界，可注入定时器）。
`refreshMeshNodes` 在 `loadedAt === null` 的失败路径上排这一套；已经拿到过列表的失败仍交给兜底轮询。

**H6 —— 会话还在时替用户点一次登录**

`SidebarNodeSignIn` 在有可见设备（或正浏览该 node 的设备）时先 `restoreSessionKey()`，恢复得出会话才打开
静默登录。防循环：模块级 `claimEagerSignIn(nodeId)` 每个 node 每次页面加载只放行一次；失败后退回手动按钮。

**H7 —— mesh WS 重连**

`mesh-events.ts` 新增 `visibleMaxDelayMs`（缺省 5 s）：页面可见时退避上限压到 5 s（后台仍走 60 s）；
`start()` 订阅 `onPageRecovery`（`visibilitychange` → 可见、`online`），恢复信号到达且未连上时
attempt 清零 + 撤在途定时器 + 立刻 open；已连上或正在连时不动。

结构调整：`mesh-nodes.ts` 把宿主级 store 整段搬到 `mesh-nodes-store.ts` 并原样再导出（对外 API 一字未变），
以满足复杂度门禁的「只降不升」。

## 后端（H2 / H3）

**H2-a 前台拨号竞速**（新文件 `mesh/peer-dial-race.ts`）

`PeerManager.dial()` 增加 `opts.foreground`，只有 `getLink()` 传 true；后台升级扫描仍走顺序拨号，
DC 照拿满 `CONNECT_TIMEOUT_MS = 15 s`。前台预算全部进 `nestedDialBudgetsMs(rtt)`（无样本按 800 ms，不是 LAN）：

| 常量 | 无样本 | 含义 |
|---|---|---|
| `FOREGROUND_DC_BUDGET_MS` | `nestedDialBudgetsMs(undefined).foregroundDcMs` = **2400** | DC 先独跑，到点并行开 ws-secure；DC 提前失败也立刻开。LAN 样本 50 ms 时为 1000 ms |
| 直连墙钟 `directMs` | 5300 | 整段直连上限，到点去中继。LAN 仍 4 s |
| `RECENT_DC_FAILURE_MS` | 10 min | `lostDirect` 命中或此窗口内 DC 失败过 → `wsFirst`，两条腿同时起跑 |
| 取链 `forwardMs` | 6900 | forwarder 取链路总 deadline。LAN 仍 5 s |

已知该 peer 在中继 presence 上（`peerKnownRelayOnline`）且前台无 live 时，直连与中继**并行**：直连先成 abort 中继；中继先成让直连继续，晚到 DC/ws-secure 走 `track()` 升级。无 presence 时仍「直连竞速 → 再中继」。

赢家采纳、输家 abort（`DOMException('dial-race-lost','AbortError')`）；晚到的会话走 discard。
命中直连截止时**不砍腿**：还在跑的直连腿交回 `dial()`，中继成功就让它稍后自己升级，中继也不通才回头
await——否则「只有 DC 可达、没有中继」的对端会永远连不上。`dialDc()` 被取消时晚到的 `pc` 自己 `close()`，
晚到的失败照记进熔断器（否则「取消」会把 DC 坏掉这件事从账上抹掉，熔断器永远不 trip）。
熔断因 `local-fingerprint` rearm 后不再有 15 s 前台惩罚：前台永远只用短预算。

**H2-b forwarder 墙钟上限**：`forwardHttp` 的 GET 4 次重试循环每轮判 deadline，`linkBefore()` 用剩余时间给
`peers.getLink()` 封顶，超时抛 `ForwardDeadlineError` 并**不再重试**，直接 503 `NODE_UNREACHABLE`
（`reason` 判为 `timeout` 而非 `no_link`）。`handleRemoteWs()` 同样受限。

**H3 hub presence 陈旧窗口**：`HUB_PRESENCE_STALE_MS = 90_000`。uplink 掉线时 `hubPresenceLive` 照旧立刻置
false，但**不再立刻补发离线事件**，而是记 `hubPresenceStaleUntil = now + 90 s`；`listHubOnline()` 改为
「本代 node.list 已到达 → 用；否则仍在陈旧窗口内 → 继续用最后一次 presence；出窗口 → 空集」。
定时器到点若本代 node.list 已回来就什么都不做，否则退化成只认 peer 可达性并补发合成离线事件。
日志各一条：`[mesh] hub presence stale hold_ms=…` / `[mesh] hub presence decayed to peer reachability`。

**H3-b 指纹变化重置 uplink 退避**：`UplinkClient.resetBackoff()` / `UplinkPool.resetBackoff()`，
由 `PeerManager.syncLocalFingerprint()` 在 `endpointBackoff.resetAll()` 旁调用。

顺带修掉两个会被新竞速踩到的 bug：`getLink()` 拿到活链路后立刻从 `pending` 摘掉本次 attempt
（否则败者收尾期间会一直挡住 `forceDcProbe` 与后台升级）；`DcUpgradeCoordinator.maybeUpgrade()` 因
`pending`/`upgrading` 合并时补排一次 `scheduleCoalescedUpgrade()`（否则合并后的重试可能丢）。

## 陈旧窗口与验证

- 首帧缓存：7 天过期、entry nodeId 变化即作废；显示的是**身份、上次在线态与 paused**，链路徽标一律「测量中」。paused 行不进侧栏聚合。
- hub presence：uplink 抖动 90 s 内维持原判，超时才降级到 peer 可达性。
- 设备行占位：只在 `/n/<id>/api/devices` pending 期间出现，落地即替换；占位数据不会触发 `ensureDeviceSubscribed`。

**怎么验**

1. 冷启动首帧：清 localStorage 前后各开一次 PWA。有缓存时第一帧就应看到全部节点头（设备行可以是灰的）；
   `/api/auth/mode` 与 `/api/mesh/nodes` 在 Network 面板里应并发发出。
2. 弱网设备列表：给 `/n/<id>/api/devices` 加延迟（devtools 限速），分节头必须立刻在、设备行是占位。
3. 断网重连：断网 → 等 mesh WS 断 → 恢复网络，重连应在 5 s 内发生（而不是 60 s）。
4. 拨号预算：`bun test src/mesh/peer-dial-race.test.ts src/mesh/peer-manager.test.ts`；实机看
   `[mesh][rtc] dial race won`。无样本前台 DC 独跑约 2.4 s，不要按 2.5 s 常量对拍。
5. hub 抖动：`bun test src/mesh/mesh-runtime.test.ts`（陈旧窗口内仍 online，超窗才转 offline）。

## 遗留

- 折叠着的远端在线分节与未登录分节仍以「至少开过一台设备」为门槛，是「节点不出现」的另一类原因。
- 全新浏览器（或清过站点数据）的第一次冷启动仍没有兜底数据，只能靠并发化省掉一次串行往返。
- `FORWARD_LINK_DEADLINE_MS` 与前台直连上限贴得较近：极端情况下 forwarder 会在取链路期限处判死而中继
  刚要接上。2.2.0 把两者一起接到 `nestedDialBudgetsMs`，嵌套不变式（connect < direct < forward）保证了
  高 RTT 下不会倒挂，但 LAN 档的 4 s / 5 s 仍然贴得近。

## 相关

[节点直连：退避、熔断、信令与失败码](../architecture/peer-direct-connect.md)、[前端流畅度与浏览器链路韧性](./performance-frontend.md)。
