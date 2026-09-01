# 多 hub 主/备（第一阶段）

本文描述 mesh 从「单一公网入口」扩成「一台 active 写者 + 若干 standby」的运维与行为。架构背景见 [hub/node 多节点架构设计](./2026082700-hub-node-architecture.md)。单 hub 安装与日常排障仍以 [hub / node 运维指南](./2026082800-hub-node-operations.md) 为准。

## 背景

第一阶段之前，一个 mesh 只有一台 `hub,node`：

- 所有 node 的 uplink、relay、enrollment、key log 追加都经过这一台；
- 这台机器停机、证书失效或所在网络不可达时，NAT 后的 node 无法互相发现，浏览器也无法经 hub 转发。

单写者是有意设计：`user_key_log` 是 `seq + prev_hash` 的严格链，enrollment token 一次性 redeem，node ID 与吊销状态需要单一权威。因此不能靠「两台 hub 同时接受写入」来做高可用。

## 目标与非目标

**第一阶段做：**

- 任一已加入的 node 可变成 **standby hub**（`TMEX_ROLES=hub,node` + `TMEX_HUB_MODE=standby`），仍以 node 身份 uplink 到当前主 hub；
- 主 hub 把 hub 集合随 `node.list` 广播（`hubs[]`、`writerHubId`、`writerEpoch`）；各 node 落入 `mesh_hubs`；
- node uplink **有序 failover**：active（最高 `writerEpoch`）→ standby（按 `priority` 升序）；主 hub 恢复后自动切回；
- standby 复制签名状态与注册表快照，**拒绝写操作**；
- 显式 `tmex hub promote` / `demote`；`writerEpoch` 单调递增。active 见到更高 epoch 的 active 会自动降级。

**第一阶段不做：**

- 多 primary 同时写入；
- 浏览器按 RTT 选最近 hub（浏览器仍走当前页面入口）。

节点侧按 RTT 挂载（`TMEX_UPLINK_PREFER_NEAREST`，多 hub 时默认开）与 opt-in 自动 promote（`TMEX_HUB_AUTO_PROMOTE`，默认关）已做，见下文。挂在不同 hub 上的 node 可以通过写者 uplink 做跨 hub relay。

## 拓扑

```text
                    写者 A（active, epoch=N）
                    TMEX_HUB_MODE=active
                 https://hub-a.example
                    /        |        \
                   /         |         \
            node-C        node-2      hub-B（同时也是 node）
                                         |
                                         | 已认证 standby→writer uplink
                                         v
                               备援 B（standby, priority=200）
                               TMEX_HUB_MODE=standby
                               https://hub-b.example
                               本地附着 node-D
                               C↔D 经 A↔B 的 hub-relay 转发
```

要点：

- standby 不是「另一个独立 mesh」，而是同一用户根钥下的只读副本；
- standby 自己也是 node，uplink 连的是当前写者（`TMEX_HUB_URL` 仍指向原主，作种子）；其它 hub 地址从 `node.list.hubs` 学习；
- 浏览器与 CLI 的写入仍应打到写者。standby 在写者可达时经已认证 hub uplink 转发这些写入；不可达时返回 `HUB_NOT_WRITER` 并带上写者地址；
- 两 hub 网格不另开链路：standby 的 writer uplink 同时承载复制、写入转发、`hub.attachments` / `hub.forward` 和 `hub-relay` 流。

## 数据同步机制

| 数据 | 同步方式 | 说明 |
|---|---|---|
| `user_key_log` / `node_certs` | 既有 uplink catch-up | 签名链，standby 作为 node 拉齐即可。允许应用「已经由写者接受」的后续记录 |
| 节点注册表 `nodes` | `node.list` 投影 | `HubRuntime.applyReplicatedNodeList`：只 upsert **本地已有未吊销证书** 的 node；列表里没有的标离线，不删除；忽略来源是自己的 list |
| hub 集合 `mesh_hubs` | `node.list.hubs` | `MeshHubStore.replaceAll`；缺 `hubs[]` 时由旧版单数 `hub` 合成一行 |
| enrollment token | **best-effort `hub.tokens`** | 写者在已授权 hub uplink 鉴权后发快照（按用户过滤、≤48 KiB 分页、`more` 标志），创建 / redeem / 过期时发增量。复制前剥掉 `entry_sid` 等会话元数据。非 ACK 只接受当前写者（`pickWriterHub` 且 `writerEpoch ≥` 本地已知最大值）。standby 按 `(id, revision)` 幂等应用，且不会把 `used_at` 从有改回 null。redeem / 创建仍只在写者上执行。只发给 advertised version ≥ 1.1.13 的已授权 hub。 |
| 附着路由 | 内存 `AttachmentRouter` + `hub.attachments` | 见「跨 hub relay」。不落库。 |

## 跨 hub relay

挂在不同 hub 上的 node 通过已认证的 standby→writer uplink 互达，不新增独立 hub TCP/WS。

**路由表：** 每台 hub 保存内存映射 `nodeId → { hubId, version, lastSeen }`。本地附着来自本进程 `NodeRegistry`；standby 在（重新）鉴权后向写者发送全量本地集合，attach/detach 发增量。写者合并后把 union 再广播给所有 advertised version ≥ 1.1.13 的已授权 hub。条目 5 分钟无刷新过期；每 2 分钟重发本机全量，且对端 hub uplink 心跳会刷新该 hub 名下全部路由，避免安静但仍在线的远端节点过期。表容量 4096；单帧 ≤48 KiB，全量/union 按 `{snapshotId, page, final}` 分页，接收端在 final 页原子应用。未授权对端的 `hub.attachments` 丢弃。节点重新挂到别处时，更高 `lastSeen` 覆盖。某 hub 的 uplink 断开后，指向它的条目删除，进行中的跨 hub 流 RST（不迁移）。`node.list` 的 `online` 为本机 registry **或** 仍有效的附着路由。

**控制帧（hub-only，追加在 `UPLINK_CTL_TYPES` 末尾）：**

- `hub.attachments { revision, entries: [{ nodeId, attached, hubId? }], full?, snapshotId?, page?, final? }`：standby→写者报本地集合；写者→各 hub 广播 union（带 `hubId`）。分页快照在 `final` 页一次性应用。
- `hub.forward { kind: 'rtc.signal', originHubId, returnHubId, visitedHubIds, signal }`：跨 hub 封装 `rtc.signal`。目标 hub 注入本地信令；回程走 `returnHubId`。session→hub 映射 TTL 10 分钟。

**数据面：** 本地 `onIncomingStream` 找不到目标但路由表给出 hub `H` 时，在本 hub 与 `H` 的已认证 uplink 上打开 `hub-relay` 流（OPEN `{ kind, to, from, originHubId, visitedHubIds, hop }`），双向 pump。对端校验 `isAuthorizedHub(origin)`、`hop ≤ 2`、`visitedHubIds` 无重复、目标本地且同用户、源证书未吊销后，再泵进本地目标，形状与同 hub relay 相同。Hub 只转发端到端加密的 relay payload，不终止 node↔node handshake。

**环路守卫：** `visitedHubIds` 不得重复；`hop ≤ 2`（两 hub 拓扑足够，第三台经写者中转最多两跳）。不把客户端提供的 `attachedHubId` 当授权依据。

**投影：** 写者把路由表投影到 `node.list.nodes[].attachedHubId`（旧节点 legacy 剥离）。`GET /api/mesh/nodes` 的 `MeshNode.attachedHubId?` 同源。

**故障切换：** 节点改挂后由新 hub 的 delta 覆盖。旧 writer 恢复后仍受 epoch fencing，不会把过期 route 重新当成写者。正在传输的跨 hub stream 不随 failover 迁移，调用方重新 dial。

`POST /api/hub/enrollments` 成功响应带 `replicatedTo: string[]`（2 s 内 ack 的 hub id；空数组表示尚未复制）。写者在复制 ACK 前崩溃时，该 token 不保证存在于 standby。

## 故障切换与切回

候选顺序（`MeshHubStore.orderedEndpoints()`，再合并 `TMEX_HUB_URL` / `TMEX_HUB_URLS` 种子）：

1. `mode=active`，按 `writerEpoch` 降序，再按 `priority` 升序；
2. `mode=standby`，按 `priority` 升序；
3. 尚未学到 `hubNodeId` 的种子 URL（priority 从 1000 起）。

同一 URL 去重。写者由 `pickWriterHub` 决定：最高 epoch 的 active；并列则 priority 更小；再并列则 `hubNodeId` 字典序。写者选择不被 RTT 覆盖。

**按 RTT 挂载（仅节点 uplink）：** `TMEX_UPLINK_PREFER_NEAREST` 默认在已知已授权 hub 多于一台时开启，可设 `0`/`off` 强制关闭。对 `/healthz` 的周期探测做 EWMA；至少 2 个样本后，健康且 advertised version ≥ 1.1.13 的已授权 hub 按平滑 RTT 排序。切换还要同时满足：新候选比当前快 ≥30% 且 ≥15 ms；两次 RTT 动机切换间隔 ≥10 分钟（make-before-break，generation 守卫不变）。没有足够 RTT 样本时 failover 仍走上面的 epoch/priority。不支持转发/relay 的旧版 hub 不会排到写者前面。写者始终是最后兜底。浏览器 `/mesh/ws` 与相对 URL 仍走当前页面 origin，不随节点挂载切换。

本机角色含 `hub` 时 **禁止** RTT 切换 uplink：standby 的写者 uplink 是控制面（复制、`hub.attachments` / `hub.forward` / `hub.write-forward` / `hub-relay`），必须始终挂在当前写者上。RTT 选近只作用于纯 node 进程。

**切走（failover）：**

- 当前候选连续 3 次连接/鉴权失败，或 20 s 内未进入已认证状态，则试下一个；
- 全部失败后沿用既有指数退避（1 s → 60 s，带抖动）再绕回。

**切回（failback）：**

- 当前挂的不是最优先候选时，每 60 s 探测更优先 hub 的 `GET <publicUrl>/healthz`（按 URL 的 CA pin，超时 5 s）；
- 收到 `node.list` 且更优先 hub 由 offline/unknown 变为 online、`writerHubId`/`writerEpoch` 变化、或当前挂载已不是最优候选时，立即再探一次（5 s 内合并重复触发；探测仍须 `/healthz` 成功、CA pin 与 generation 守卫后才 `switchTo`）；60 s 定时器仍作兜底；
- 探测成功后 **make-before-break**：先打开新 uplink，等它鉴权成功再关旧链路，然后重发 `node.status`。

**generation 守卫：** 每条 uplink 有世代号。被替换的链路上迟到的 `node.list` / `key.log` / `rtc.signal` / `hub.tokens` / `hub.attachments` / `hub.forward` / write-forward ACK / relay 回调直接丢弃，并取消该链路的 key-log catch-up，避免旧主的过期快照盖住新主。handler 使用实际发送该帧的 `{hubNodeId, generation}`，writer-only 帧再核对来源与 epoch。

## 写入围栏

写者可达且 advertised version ≥ 1.1.13 时，standby 把下列写入经**已认证 hub↔hub uplink** 发成控制帧 `hub.write-forward { id, method, path, headers（仅 content-type 与 X-Tmex-Force-Keylog）, body, uid?, writerHubId?, writerEpoch? }`，写者执行前校验 `isWriter()`、本机 ID 与当前 epoch，不匹配则 409 `HUB_NOT_WRITER` ack。执行后回 ack（status / body）；超 48 KiB 的 ACK 按 `{id, part, final, bytes}` 分片，standby 重组。请求体发送前做尺寸检查，超限返回 413 `payload_too_large`。写者按 `(fromHubId, id)` 做有界幂等缓存：同摘要重放原 ACK，不同摘要拒绝。响应加 `X-Tmex-Forwarded-By: <standbyHubId>`。帧里**不带** `cookie` / `authorization`。已带该响应头的请求不再转发（环路守卫）。无活的写者 uplink 或对端版本不够时，仍 409 `HUB_NOT_WRITER`。

写者把请求归到转发 hub：enrollment create 的用户签名、redeem 的 enroll-key 证书、revoke / keylog 的签名记录均自认证。**rename** 额外带 `uid`：standby 断言「该用户已在本机通过会话认证」，写者接受该 uid **仅因为发送方是已授权 hub**（不复验 standby 侧会话）。失陷的已授权 standby 可以冒用其已认证用户做 rename。

写者未知或不可达时，仍返回 HTTP 409：

```json
{
  "code": "HUB_NOT_WRITER",
  "writerHubId": "<32-hex 或 null>",
  "writerPublicUrl": "<url 或 null>",
  "writerEpoch": 1
}
```

覆盖：`POST /api/hub/enrollments`、`POST /api/hub/enrollments/redeem`、`POST /api/hub/nodes/:id/rename`、`POST /api/hub/nodes/:id/revoke`，以及 `POST /api/auth/keylog?hub=sync` 的 hub 追加。挂在 standby 上的 node 发来的 uplink `key.log.append` 经 standby 自己的写者 uplink 转发，并把 ack/error 回传；无活的写者 uplink 时仍是 `HUB_NOT_WRITER`。转发成功后 standby 立即触发 key-log catch-up，不等下一轮 `node.list`。

只读（节点列表、enrollment 查询、uplink 鉴权、`node.list`、本 hub 与跨 hub relay、RTC 信令、key log 拉取）在 standby 上仍可用。

**epoch 围栏：** 本机 `mode=active` 时，若收到**已授权**的另一台 `mode=active` 且 `writerEpoch` **更大** 的广告，立即日志 `[hub] fenced: higher writerEpoch=… from hub=…`，`setMode('standby')`，把本机在 `mesh_hubs` 的行写成 standby。默认**不会**自动 promote；见下节 opt-in 自动 promote。

围栏必须跨重启存活：被 fence 的 hub 下次启动会读 `mesh_hubs` 里更高 epoch 的已授权 active，仍以 standby 起来（日志 `[hub] starting fenced: …`），即使 `app.env` 里 `TMEX_HUB_MODE=active` 也一样。要重新当写者，必须显式 `tmex hub promote`。

**脑裂告警：** 两台 active 的 epoch **相等** 时，每 60 s 打一条 `split-brain` 警告，两边继续服务。必须人工 `demote` 其中一台。

## hub 间状态探测

`node.status.hub` 广告只在 uplink 连上对端时发送。被 promote 的 standby 会把自己排到候选第一并 **in-memory 挂到自己**，于是不再向旧写者广告；旧写者带着旧 epoch 回来时同样没人告诉它已被取代。这两种情况都会永久脑裂。

因此每台 hub 暴露公开接口 `GET /api/hub/status`（无需 session，与 `/healthz` 同级），返回 `ownHubSnapshot()` 的元数据：`hubNodeId`、`publicUrl`、`mode`、`priority`、`writerEpoch`、`name?`、`caFingerprint?`、`now`。这些字段本来就会出现在 `node.list.hubs[]` 里。

启动 2 s 后，以及之后每 60 s（±20% 抖动），本机对 `mesh_hubs` 里 **已授权**（id ∈ `TMEX_HUB_PEERS`）且不是 self 的行拉取 `<publicUrl>/api/hub/status`（超时 5 s）。TLS 使用 `HubTrustStore` 的 per-URL CA pin（与 uplink 相同）；没有 pin 的 https 走系统 CA。返回的 32-hex `hubNodeId` 必须等于该行 id，否则丢弃并警告。通过校验后走与授权 `node.status.hub` 相同的 upsert / fencing / 脑裂告警路径（更高 epoch 的 active 会把本机降为 standby，日志 `[hub] fenced by peer status …`）。连续 3 次不可达则把该行标 `online: false`，不删行。`setMode`（promote/demote）以及新授权 hub 行出现时立刻再探一次。

探测结果可信，当且仅当 URL 经 TLS 认证（pin 或系统 CA）**并且** hub id 在本机 allowlist 中。未授权的 URL / id 不能 fencing 本机。

`GET /api/hub/status` 可选带 `writerView: { hubNodeId, writerEpoch, reachable, observedAt }`：本机对当前写者的最新观测。供自动 promote 做 quorum，不单独作为信任根。

## 自动 promote（opt-in）

默认关闭。`TMEX_HUB_AUTO_PROMOTE=1` 才允许 standby 在写者长时间不可达时把自己提成写者。超时 `TMEX_HUB_AUTO_PROMOTE_TIMEOUT_MS`（默认 600_000，即 10 分钟）：本机对写者的探测必须在该窗口内连续失败（一次成功即清零计时）。

同时必须满足：

- 本机是所有已授权 standby 里 priority 最低者（相同则 node id 更小）；
- 已授权 hub **恰好 2 台**时，不做 quorum（只靠开关 + 长超时）。两 hub 分区时无法区分「写者挂了」和「链路断了」，这是文档化的脑裂风险，恢复靠更高 epoch 围栏；
- **≥3 台**时，其它已授权 hub（不含 self、不含写者）里，新鲜（≤2× 探测间隔，以**本机收到该票的时间**为准，不用对端 `observedAt`）且 `writerView.writerEpoch` 与当前写者 epoch 一致的票，必须有严格多数报告写者不可达。过期或 epoch 不匹配的 view 不计入。写者不可达计时按 `(writerHubId, writerEpoch)` 跟踪，epoch 变化即清零。

Promote 复用 `POST /api/hub/role` 的过渡：写 `TMEX_HUB_MODE=active` 与 `TMEX_HUB_WRITER_EPOCH=max(已知)+1`，`operationId=auto-<ts>`，然后重启。日志 `[hub] auto-promote: …`。旧写者回来后被更高 epoch fence。

## 授权 allowlist（为何必须有）

威胁模型是「任意一点失陷只影响该点」（见 [架构 §2 / §5](./2026082700-hub-node-architecture.md)）。普通 node 的 uplink 证书只证明「这台机器已加入 mesh」，**不**证明它可以当 hub。

若 writer 无条件接受 `node.status.hub` 广告，失陷的普通节点可以自报 `mode=active` 和极大 `writerEpoch`，把真写者 fence 成 standby，并把全网 uplink 引到攻击者。这会把「只能影响本机」升级成控制面接管。

权威来源是用户签名的 key-log 记录 `admit-hub` / `retire-hub`（root 或 passkey 签名，随严格链复制）。本机 env `TMEX_HUB_PEERS` 仍作 bootstrap / 回退。

合并规则（对指定 mesh 用户的派生状态）：

- 已有 `admit-hub` 且未 `retire-hub`：授权（`signed`），与 env 无关；
- 已 `retire-hub`：拒绝，**压过** `TMEX_HUB_PEERS` 和 self；
- 无签名记录：回退到 `id == self || id ∈ TMEX_HUB_PEERS`。

因此：

- 未授权的广告一律丢弃，不进 `mesh_hubs`、不参与 `pickWriterHub`、不触发 fencing、不广播其 CA 指纹；
- 新版本只需在 UI 提交 `admit-hub`，standby 即可出现在 `hubs[]`，不必每台机器手写 env；
- `tmex hub allow` / `disallow` 仍改 env，但签名授权优先，且由 UI 管理。

**兼容门：** 旧节点无法解码新记录类型，链回放会停在 `malformed_payload`。写者在追加 `admit-hub` / `retire-hub` 前，若 `nodes` 里任一未吊销节点的 last-reported version `< 1.1.13` 或为空/无法解析，则拒绝：HTTP 409 `{ code: KEYLOG_TYPE_UNSUPPORTED_BY_NODES, minVersion, nodes }`（uplink `key.log.append` 同样返回该 error code）。HTTP 可用 `X-Tmex-Force-Keylog: 1` 强制写入并打警告。

## 操作手册

命令都跑在**目标机器本机**，要求已 `tmex init`。`hub join` 行为不变（只写一个种子 `TMEX_HUB_URL`）；其它 hub 靠 `node.list` 学习，不必改 join。

### 两步启用 standby（standby 自动授权主 hub；主 hub 仍须手动 allow）

standby 自己改角色还不够：当前 active **不会**把未授权的 hub 广告写入 `hubs[]`。顺序是：

1. 在已加入的 **node** 上执行 `tmex hub standby --public-url https://hub-b.example`。命令会：
   - 把本机写成 `hub,node` + `standby`；
   - **自动把当前主 hub 的 node id 写入本机 `TMEX_HUB_PEERS`**（来源：本地 `mesh_hubs` 的 active 行，找不到则退到 `peer_cache` 哨兵行 `node_id='hub'` 的 `inventory_json.nodeId`）。找不到时打印警告，须手动 `tmex hub allow`。
   - 打印本机 32 位 hex node id，以及要在 active 上跑的命令：`tmex hub allow <thisNodeId>`。
2. 在 **当前 active hub** 上执行打印出来的 `tmex hub allow <nodeId>`（写入 `TMEX_HUB_PEERS` 并重启，除非 `--no-restart`）。**主 hub 不会自动授权备用 hub。**
3. 之后 `tmex hub list` / `node.list.hubs[]` 才会出现这台 standby。`AUTH` 列为 `signed` / `env` / `self` / `no`：签名授权优先于 env。首选在 UI 提交 `admit-hub`，env 仅作 bootstrap。

反过来：新写者 `promote` 之后，**旧写者**也必须 `tmex hub allow <新写者 nodeId>`，否则旧写者不会承认它，也无法被它 fence。`promote` / `demote` **不改** `TMEX_HUB_PEERS`，但会打印当前名单。

### 把已加入的 node 变成 standby

```bash
tmex hub standby --public-url https://hub-b.example [--priority 200]
```

写入：

| 键 | 值 |
|---|---|
| `TMEX_ROLES` | `hub,node` |
| `TMEX_HUB_MODE` | `standby` |
| `TMEX_HUB_PUBLIC_URL` | 参数 URL |
| `TMEX_HUB_PRIORITY` | `--priority`，缺省 `200` |
| `TMEX_HUB_URL` | **保持不变**（当前主 hub 种子） |
| `TMEX_HUB_PEERS` | **追加当前主 hub 的 node id**（已有名单去重保序；找不到主 hub 则不改） |

约束：

- 未加入（无 `node_identity`）会拒绝；
- 已经是 `hub,node` 且 `TMEX_HUB_MODE=active`（缺省即 active）会拒绝，须先 `demote`；
- URL 必须 `https:`。本机回环 HTTP 仅非 production 且加 `--insecure-local`（与 `hub join` 相同）；
- 写完重启服务。`--no-restart` 只改 `app.env`，须手动重启。

`--priority` 越小越优先（同为 standby 时）。建议备机用 `200`，主用 `100`（active 缺省）。

### 管理授权名单（allow / disallow）

仅 `hub,node` 安装可用。

```bash
tmex hub allow <nodeId> [<nodeId>...]
tmex hub disallow <nodeId>
```

- node id 必须是 32 位十六进制（大小写不敏感，写入时小写）；非法值拒绝，不改 env；
- `allow` 追加到 `TMEX_HUB_PEERS`，去重且保持原有顺序；
- `disallow` 从名单删除；
- 两者都打印变更后的名单，并重启服务（`--no-restart` 除外）。

### 提升写者（promote）

```bash
tmex hub promote --yes
```

- 仅 `hub,node` 安装可用；
- 设 `TMEX_HUB_MODE=active`；
- `TMEX_HUB_WRITER_EPOCH = max(当前 env, max(mesh_hubs.writer_epoch)) + 1`；本地库不可读时退化为 `env + 1`（env 缺省按 1）；
- **一定**打印红字警告：原写者必须先 `demote` 或停机，否则脑裂；
- 必须 `--yes`，或在 TTY 交互确认。非 TTY 不加 `--yes` 会拒绝；
- 提醒原写者执行 `tmex hub allow <本机 nodeId>`。若本机 `TMEX_HUB_PEERS` 为空，额外警告：本机未授权任何对端，旧写者无法 fencing 本机（可以接受），但旧写者仍须把本机加入它的名单。
- **不改** `TMEX_HUB_PEERS`，结束时打印当前名单。

### 降为备援（demote）

```bash
tmex hub demote
```

只改 `TMEX_HUB_MODE=standby` 并重启。**不改** `TMEX_HUB_PEERS`，结束时打印当前名单。原主恢复上线前必须先做这一步。

### 远程切换（UI）

FE 在节点表的「主 Hub / 备 Hub」标签旁提供「切换」。入口把请求转发到目标 hub 的 `POST /n/<hubNodeId>/api/hub/role`（现有 `/n/<nodeId>/api/...` 转发器，无新协议）。目标若回答 404/405，入口/FE 映射为 `HUB_ROLE_UNSUPPORTED`（旧版本没有该接口）。

契约：`packages/shared/src/contracts/hub-role.ts`。`POST /api/hub/role` body 为 `{ mode, writerEpoch?, operationId }`，鉴权与 `/api/hub/nodes/*` 相同；成功 202 `HubRoleTransition`。`GET /api/hub/role/status?operationId=` 回读指定过渡，无 id 则回读最新一条。

目标机执行顺序：

1. 校验：已安装 hub 角色（否则 `HUB_NOT_HUB`）；`operationId` 为 UUID；同一 `operationId` 幂等返回既有记录；同时只允许一条 in-flight（`HUB_ROLE_BUSY`）；`mode=active` 要求 `writerEpoch > max(env epoch, 本机 mesh_hubs, 全部已知 mesh_hubs)`（否则 `HUB_EPOCH_STALE`）；本机必须已授权（self 默认可，但若存在针对 self 的签名 `retire-hub` 则 `HUB_NOT_AUTHORIZED`）。无 `app.env` 补丁能力的独立 gateway 进程返回 `HUB_ROLE_UNSUPPORTED`。
2. 持久化过渡 `accepted` → `persisting`：原子写入 `TMEX_HUB_MODE`（`active` 同时写 `TMEX_HUB_WRITER_EPOCH`），更新本机 `mesh_hubs` 行，并立刻 `setMode` / `setWriterEpoch`，使 demote 立即停止接受写入。
3. `restarting`：约 1 s 后走既有自重启（`RuntimeController.requestRestart()`，与 `POST /api/settings/restart` 相同），以便 202 先刷出。
4. 下次启动读 env：若最新过渡为 `restarting` 且 env 与目标一致则标 `complete`，否则 `failed`。过渡存在独立表 `hub_role_transitions`，不会被 `mesh_hubs.replaceAll()` 清掉。

**把 X 设为写者的顺序：** 当前写者为 A、目标为 X。A 可达时先 demote A（`mode=standby`），再 promote X（`mode=active`，`writerEpoch = max(已知 epoch)+1`）。A 不可达时不能声称 HTTP demote 成功，只能依赖 X 的更高 epoch 把 A fence 成 standby；同 epoch 双 active 仍会脑裂。CLI `tmex hub promote/demote` 在本机库可写时也会落一条 `hub_role_transitions`（`phase=restarting`），`tmex hub list` 打印最新过渡 phase。

### 查看 hub 集合

```bash
tmex hub list
```

读本机 `mesh_hubs`：短 node id、name、mode、priority、writerEpoch、authorized、publicUrl、online、lastSeen。写者行以 `*` 标记（规则与运行时 `pickWriterHub` 相同）。`AUTH=yes` 当且仅当该 id 在本机 `TMEX_HUB_PEERS` 中，或就是本机 self。表空表示还没从 `node.list` 学到集合（旧 hub、尚未 uplink，或对端尚未被 allow）。

`GET /api/mesh/hubs` 的 `candidates[]` 现为对象（前端忽略多余字段）：`publicUrl`、`lastError`（最近一次拨号失败原因，没有则为 `null`）、`lastAttemptAt`（epoch 毫秒）。用于确认 failover 是否真的试过备用 hub、以及 TLS / CA pin 失败原因。

节点 uplink 诊断日志（`console.info`，同一 URL 相同失败行 60 s 内只打一次）：

```text
[uplink] try hub=<url> mode=<active|standby> epoch=<n> idx=<i>/<n> transport=<ws|memory>
[uplink] candidate failed hub=<url> err=<msg> fails=<k>
[uplink] failover → hub=<url>
[uplink] probe ok hub=<url>
[uplink] probe fail hub=<url>
[uplink] switch-back → hub=<url>
[uplink] ca pin stored url=<url> fp=<64-hex>
[uplink] ca bootstrap failed url=<url> err=<msg>
[uplink] no CA pin for <url> and no advertised fingerprint
```

### 主 hub 恢复：先 demote，再启动

错误顺序：旧主带着原来的 `TMEX_HUB_MODE=active` 和旧 epoch 直接开机 → 与新主 epoch 相等或旧主更大 → 脑裂或把新主 fence 掉。

正确顺序：

1. 确认新主已经 `promote` 且 node 已切过去（`tmex hub list` / `GET /api/mesh/hubs`）；
2. 在**旧主**上 `tmex hub demote`（或停机并手改 `TMEX_HUB_MODE=standby`）；
3. 新主若尚未 `tmex hub allow <旧主 nodeId>`，先补上；再启动旧主。它会以 standby 身份 uplink 到新写者、复制注册表，并出现在 `hubs[]` 里；
4. 若要把写者切回旧主：旧主 `tmex hub promote --yes`，且新主必须已 allow 旧主（否则无法 fence）。仍建议先把现写者 demote，再 promote 旧主。

## 环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `TMEX_HUB_MODE` | `active` | `active` 或 `standby`；其它值启动失败 |
| `TMEX_HUB_PRIORITY` | active `100` / standby `200` | 同 mode 下越小越优先，整数 ≥ 0 |
| `TMEX_HUB_WRITER_EPOCH` | `1` | 写者世代，整数 ≥ 1，只增不减 |
| `TMEX_HUB_URLS` | 空 | 逗号分隔的备用种子，接在 `TMEX_HUB_URL` 后按字面去重 |
| `TMEX_HUB_PEERS` | 空 | 逗号分隔的 **其它** 已授权 hub 的 32 位 hex node id。空名单 = 只信任 self。由 `tmex hub allow` / `disallow` 维护 |
| `TMEX_HUB_PUBLIC_URL` | 空 | 本机 hub 对外 HTTPS 基址 |
| `TMEX_HUB_URL` | 空 | 种子主 hub。`hub join` 写入；standby **不要改掉** |

`init` / `upgrade` 不会写入 mode / priority / epoch / URLS / PEERS。由 CLI 或手改 `app.env` 后重启。

启动日志（hub 角色）：

```text
[hub] mode=standby priority=200 writerEpoch=1 publicUrl=https://hub-b.example
```

## 兼容性

- 当前解码器与 v1.1.5 都不按 key 白名单拒收。`node.list` 多出来的 `hubs` / `writerHubId` / `writerEpoch`，以及 `node.status.hub` 广告，旧节点会忽略未知字段，只要字符串/数组长度仍在既有上限内（hub URL ≤ 512，最多 16 个 hub）。
- 单数 `hub` 字段仍表示**当前写者**（不一定是发 list 的那台）。旧节点只认这个字段。
- 编码器仍支持 `{ legacy: true }`，可按节点版本剥掉新字段；v1.1.5 存活不依赖它。
- `hub join` 仍只接受一个 URL。

## 验收清单

- [ ] 已加入的 node 上 `tmex hub standby --public-url https://…` 后角色为 `hub,node`、mode=`standby`，`TMEX_HUB_URL` 未改，服务重启；输出含本机 node id 与 `tmex hub allow <id>`；本机 `TMEX_HUB_PEERS` 已含当前主 hub（或打印找不到主 hub 的警告）。
- [ ] 未加入 / 已是 active hub 的机器执行 standby 被拒绝。
- [ ] 未 `allow` 前，active 的 `hubs[]` 不含该 standby；active 执行 `tmex hub allow <id>` 后才出现。
- [ ] `tmex hub allow` / `disallow` 校验 32 位 hex、去重保序、非 `hub,node` 拒绝、`--no-restart` 不重启。
- [ ] 主 hub 的 `node.list` 含 `hubs[]`；各 node `tmex hub list` 能看到主与备，写者打 `*`，`AUTH` 列对 self / 已 allow 的为 yes。
- [ ] 停主 hub 后，node 在阈值内切到 standby；`GET /api/mesh/hubs` 的 `attached` 指向备机。
- [ ] 写者可达时，备机 enroll / redeem / rename / revoke 转发到写者并成功；写者不可达时仍 409 `HUB_NOT_WRITER`，带写者 URL。
- [ ] 主 hub 停机后 node 日志出现对备用 hub 的 `[uplink] try` / `candidate failed`（而不只是 `offline reason=stopped`）；`GET /api/mesh/hubs.candidates[].lastError` 能看到失败原因。
- [ ] 主 hub 按「先 demote 再启动」恢复后，node 切回主；跳过 demote 会看到 fence 或 split-brain 日志。
- [ ] `tmex hub promote --yes` 把 epoch 提到 `max(env, db)+1`；无 `--yes` 且非 TTY 拒绝。
- [ ] 旧节点（v1.1.5）仍能解码 `node.list` 并保持单 hub uplink。

## 已知限制

1. 自动选主默认关闭。未设 `TMEX_HUB_AUTO_PROMOTE=1` 时，主挂了只靠 node 侧有序 failover，要把 standby 变成写者必须人工 `promote`。两 hub 开启自动 promote 无法从理论上消除脑裂。
2. 两台 active 且 epoch 相同不会自动决出胜负，只打脑裂告警。
3. enrollment token 是 best-effort 复制：只发给 ≥ 1.1.13 的已授权 hub；写者在 ACK 前崩溃则 standby 可能没有该 token。redeem 仍只在当前写者上执行。
4. 注册表复制只覆盖「本地已有未吊销证书」的 node，不会凭空插入未知 id。
5. 跨 hub relay 已做（`hub.attachments` / `hub-relay`）；旧版（低于 1.1.13）仍只能同 hub relay。
6. 节点可按 RTT 挂到最近的已授权 hub；浏览器仍走当前入口，不会按 RTT 选 hub。
7. 混合版本下，旧节点看不到 `hubs[]`，只会连 `TMEX_HUB_URL` 那一个种子。
8. `promote` 的 epoch 以**本机** env 与 `mesh_hubs` 为准。若本机表是旧快照，可能算出偏小的 epoch；以实际跑起来后的 fence 日志为准，必要时再 promote 一次。
9. 被 fence 的 hub 重启后仍是 standby，直到显式 `promote`。不要指望改回 `TMEX_HUB_MODE=active` 再启动就能夺回写者。
10. `TMEX_HUB_PEERS` 仍是各 hub 本机 env，不会随 `node.list` 复制；签名 `admit-hub` / `retire-hub` 才随 key-log 复制。旧节点未升级前写者会拒绝追加这两类记录（见上文兼容门）。
11. **节点会话即目标机完全控制权**（升级 / 卸载 / 终端同模型）。远程破坏性操作不再叠加独立用户签名；攻陷一台已加入的 node 等于控制该机上的管理面。
12. **被 admit 的 hub 获得围栏权**：`writerEpoch` 仍可自报，更高 epoch 的 active 广告即可 fence 其他 hub。这正是 hub 授权必须走用户签名 `admit-hub` / `retire-hub` 的原因。失陷的已授权 hub 影响范围是 hub 控制面（角色围栏、写入转发归因、token 复制），不是普通 node。
