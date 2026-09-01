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

- 自动选主（没有 quorum、没有 lease）；
- 多 primary 同时写入；
- hub 之间互相 relay（node 故障切换后都应挂到同一写者）；
- 浏览器按 RTT 选最近 hub。

这些属于后续阶段。

## 拓扑

```text
                    写者（active, epoch=N）
                    TMEX_HUB_MODE=active
                 https://hub-a.example
                    /        |        \
                   /         |         \
            node-1         node-2      node-s
                                         |
                                         | 本机同时跑 hub 角色
                                         v
                               备援（standby, priority=200）
                               TMEX_HUB_MODE=standby
                               https://hub-b.example
                               只读：node.list / key log catch-up
                               拒写：enroll / redeem / rename / revoke
```

要点：

- standby 不是「另一个独立 mesh」，而是同一用户根钥下的只读副本；
- standby 自己也是 node，uplink 连的是当前写者（`TMEX_HUB_URL` 仍指向原主，作种子）；其它 hub 地址从 `node.list.hubs` 学习；
- 浏览器与 CLI 的写入仍应打到写者。standby 返回 `HUB_NOT_WRITER` 并带上写者地址。

## 数据同步机制

| 数据 | 同步方式 | 说明 |
|---|---|---|
| `user_key_log` / `node_certs` | 既有 uplink catch-up | 签名链，standby 作为 node 拉齐即可。允许应用「已经由写者接受」的后续记录 |
| 节点注册表 `nodes` | `node.list` 投影 | `HubRuntime.applyReplicatedNodeList`：只 upsert **本地已有未吊销证书** 的 node；列表里没有的标离线，不删除；忽略来源是自己的 list |
| hub 集合 `mesh_hubs` | `node.list.hubs` | `MeshHubStore.replaceAll`；缺 `hubs[]` 时由旧版单数 `hub` 合成一行 |
| enrollment token | **不复制** | 第一阶段 standby 不能 redeem；token 仍只存在于写者 |

不把 enrollment token 当普通行复制：一次性 `used_at` 条件无法在两台机器上安全 LWW。

## 故障切换与切回

候选顺序（`MeshHubStore.orderedEndpoints()`，再合并 `TMEX_HUB_URL` / `TMEX_HUB_URLS` 种子）：

1. `mode=active`，按 `writerEpoch` 降序，再按 `priority` 升序；
2. `mode=standby`，按 `priority` 升序；
3. 尚未学到 `hubNodeId` 的种子 URL（priority 从 1000 起）。

同一 URL 去重。写者由 `pickWriterHub` 决定：最高 epoch 的 active；并列则 priority 更小；再并列则 `hubNodeId` 字典序。

**切走（failover）：**

- 当前候选连续 3 次连接/鉴权失败，或 20 s 内未进入已认证状态，则试下一个；
- 全部失败后沿用既有指数退避（1 s → 60 s，带抖动）再绕回。

**切回（failback）：**

- 当前挂的不是最优先候选时，每 60 s 探测更优先 hub 的 `GET <publicUrl>/healthz`（按 URL 的 CA pin，超时 5 s）；
- 探测成功后 **make-before-break**：先打开新 uplink，等它鉴权成功再关旧链路，然后重发 `node.status`。

**generation 守卫：** 每条 uplink 有世代号。被替换的链路上迟到的 `node.list` / `key.log` / `rtc.signal` 直接丢弃，并取消该链路的 key-log catch-up，避免旧主的过期快照盖住新主。

## 写入围栏

standby 对下列请求返回 HTTP 409，body 为：

```json
{
  "code": "HUB_NOT_WRITER",
  "writerHubId": "<32-hex 或 null>",
  "writerPublicUrl": "<url 或 null>",
  "writerEpoch": 1
}
```

覆盖：`POST /api/hub/enrollments`、`POST /api/hub/enrollments/redeem`、`POST /api/hub/nodes/:id/rename`、`POST /api/hub/nodes/:id/revoke`，以及会在本机发起 **新的** key log 追加的 ctl。只读（节点列表、enrollment 查询、uplink 鉴权、`node.list`、relay、RTC 信令、key log 拉取）在 standby 上仍可用。

**epoch 围栏：** 本机 `mode=active` 时，若收到**已授权**的另一台 `mode=active` 且 `writerEpoch` **更大** 的广告，立即日志 `[hub] fenced: higher writerEpoch=… from hub=…`，`setMode('standby')`，把本机在 `mesh_hubs` 的行写成 standby。**不会自动 promote。**

围栏必须跨重启存活：被 fence 的 hub 下次启动会读 `mesh_hubs` 里更高 epoch 的已授权 active，仍以 standby 起来（日志 `[hub] starting fenced: …`），即使 `app.env` 里 `TMEX_HUB_MODE=active` 也一样。要重新当写者，必须显式 `tmex hub promote`。

**脑裂告警：** 两台 active 的 epoch **相等** 时，每 60 s 打一条 `split-brain` 警告，两边继续服务。必须人工 `demote` 其中一台。

## 授权 allowlist（为何必须有）

威胁模型是「任意一点失陷只影响该点」（见 [架构 §2 / §5](./2026082700-hub-node-architecture.md)）。普通 node 的 uplink 证书只证明「这台机器已加入 mesh」，**不**证明它可以当 hub。

若 writer 无条件接受 `node.status.hub` 广告，失陷的普通节点可以自报 `mode=active` 和极大 `writerEpoch`，把真写者 fence 成 standby，并把全网 uplink 引到攻击者。这会把「只能影响本机」升级成控制面接管。

因此第一阶段用本机 env `TMEX_HUB_PEERS`（逗号分隔的 **其它** 已授权 hub 的 32 位 hex node id）做 allowlist：

- 未在名单中、也不是 self 的广告一律丢弃，不进 `mesh_hubs`、不参与 `pickWriterHub`、不触发 fencing、不广播其 CA 指纹；
- standby 必须先被当前 active 执行 `tmex hub allow <nodeId>`，才会出现在 `hubs[]` 里。

这是运维层的短期控制。第二阶段应把授权做成用户签名的 key-log 记录（例如 `admit-hub`），随链复制、可吊销，而不是各 hub 各自改 env。

## 操作手册

命令都跑在**目标机器本机**，要求已 `tmex init`。`hub join` 行为不变（只写一个种子 `TMEX_HUB_URL`）；其它 hub 靠 `node.list` 学习，不必改 join。

### 两步启用 standby（必须先 allow）

standby 自己改角色还不够：当前 active **不会**把未授权的 hub 广告写入 `hubs[]`。顺序是：

1. 在已加入的 **node** 上执行 `tmex hub standby --public-url https://hub-b.example`。命令结束时打印本机 32 位 hex node id，以及要在 active 上跑的命令：`tmex hub allow <thisNodeId>`。在这一步完成前，active 会忽略该 standby。
2. 在 **当前 active hub** 上执行打印出来的 `tmex hub allow <nodeId>`（写入 `TMEX_HUB_PEERS` 并重启，除非 `--no-restart`）。
3. 之后 `tmex hub list` / `node.list.hubs[]` 才会出现这台 standby。`AUTH` 列为 `yes` 表示该 id 在本机 `TMEX_HUB_PEERS` 中，或就是 self。

反过来：新写者 `promote` 之后，**旧写者**也必须 `tmex hub allow <新写者 nodeId>`，否则旧写者不会承认它，也无法被它 fence。

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

### 降为备援（demote）

```bash
tmex hub demote
```

只改 `TMEX_HUB_MODE=standby` 并重启。原主恢复上线前必须先做这一步。

### 查看 hub 集合

```bash
tmex hub list
```

读本机 `mesh_hubs`：短 node id、name、mode、priority、writerEpoch、authorized、publicUrl、online、lastSeen。写者行以 `*` 标记（规则与运行时 `pickWriterHub` 相同）。`AUTH=yes` 当且仅当该 id 在本机 `TMEX_HUB_PEERS` 中，或就是本机 self。表空表示还没从 `node.list` 学到集合（旧 hub、尚未 uplink，或对端尚未被 allow）。

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

- [ ] 已加入的 node 上 `tmex hub standby --public-url https://…` 后角色为 `hub,node`、mode=`standby`，`TMEX_HUB_URL` 未改，服务重启；输出含本机 node id 与 `tmex hub allow <id>`。
- [ ] 未加入 / 已是 active hub 的机器执行 standby 被拒绝。
- [ ] 未 `allow` 前，active 的 `hubs[]` 不含该 standby；active 执行 `tmex hub allow <id>` 后才出现。
- [ ] `tmex hub allow` / `disallow` 校验 32 位 hex、去重保序、非 `hub,node` 拒绝、`--no-restart` 不重启。
- [ ] 主 hub 的 `node.list` 含 `hubs[]`；各 node `tmex hub list` 能看到主与备，写者打 `*`，`AUTH` 列对 self / 已 allow 的为 yes。
- [ ] 停主 hub 后，node 在阈值内切到 standby；`GET /api/mesh/hubs` 的 `attached` 指向备机。
- [ ] 备机 enroll / redeem / rename / revoke 返回 409 `HUB_NOT_WRITER`，带写者 URL。
- [ ] 主 hub 按「先 demote 再启动」恢复后，node 切回主；跳过 demote 会看到 fence 或 split-brain 日志。
- [ ] `tmex hub promote --yes` 把 epoch 提到 `max(env, db)+1`；无 `--yes` 且非 TTY 拒绝。
- [ ] 旧节点（v1.1.5）仍能解码 `node.list` 并保持单 hub uplink。

## 已知限制

1. 没有自动选主。主挂了只靠 node 侧有序 failover；要把 standby 变成写者必须人工 `promote`。
2. 两台 active 且 epoch 相同不会自动决出胜负，只打脑裂告警。
3. enrollment token 不复制，standby 不能发 join 串、不能 redeem。
4. 注册表复制只覆盖「本地已有未吊销证书」的 node，不会凭空插入未知 id。
5. 不做 hub 间 relay：挂在 standby 上的 node 只能跟同样挂在这台 standby 上的节点互相 relay。
6. 浏览器仍走当前入口；不会按 RTT 选 hub。
7. 混合版本下，旧节点看不到 `hubs[]`，只会连 `TMEX_HUB_URL` 那一个种子。
8. `promote` 的 epoch 以**本机** env 与 `mesh_hubs` 为准。若本机表是旧快照，可能算出偏小的 epoch；以实际跑起来后的 fence 日志为准，必要时再 promote 一次。
9. 被 fence 的 hub 重启后仍是 standby，直到显式 `promote`。不要指望改回 `TMEX_HUB_MODE=active` 再启动就能夺回写者。
10. `TMEX_HUB_PEERS` 是各 hub 本机 env，不会随 `node.list` 复制。第二阶段应改为用户签名的 `admit-hub` key-log 记录。
