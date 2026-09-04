# 1.1.24

_2026-09-04_

## English

### New

- A machine can join an existing Hub mesh with the Hub URL and the mesh account password (`tmex hub join <url> --password`, or setup `method: 'password'`). No join token is typed; the client derives the root key, creates a normal enrollment, and the Hub accepts `POST /api/hub/enrollments/by-password`.
- A machine can join an existing relay tenant the same way from setup or `tmex relay join <url> --tenant <id> [--password]`.

### Fixes

- The terminal's minimum peer version is now 1.1.23, the version that actually speaks the current state stream — 1.1.22 was never interoperable. When a peer is too old, the message now says which side it is: the node (named by id) and its version, the Gateway and its version, or this page, which just needs a reload. The notice also stops repeating on every reconnect.

---

## 中文

### 新增

- 可用 Hub 地址与 mesh 账户密码加入既有 Hub（`tmex hub join <url> --password`，或 setup `method: 'password'`），不必再输入加入码。客户端派生根钥并创建普通 enrollment，Hub 以 `POST /api/hub/enrollments/by-password` 验收。
- 同样可用中继地址、租户编号与密码加入既有租户（setup 或 `tmex relay join <url> --tenant <id> [--password]`）。

### 修复

- 终端的最低对端版本改为 1.1.23——真正能跑当前状态流的是这一版，1.1.22 从来就互通不了。对端过旧时提示会说明是哪一端：节点（点名节点编号）及其版本、Gateway 及其版本，或本页面（刷新即可）。该提示也不再随每次重连重复弹出。

---

# 1.1.23

_2026-09-04_

## English

### New

- **Public relay role.** A machine can now run as a `relay` (or `relay,node`): a shared, multi-tenant relay that takes the hub's job of connecting your nodes without being able to read anything about them. The relay only ever sees a tenant id, your root public key, node ids with their link keys, online state and byte counters; node names, device lists, addresses, key-log contents and WebRTC signalling are all encrypted with tenant keys the relay never holds. Set it up with `tmex init --role relay` and manage it with `tmex relay status | passwd | tenants | quota | kick | remove | label`, or from the new “Relay” tab in Settings on a `relay,node` machine.
- **Joining a relay as a tenant.** From the Nodes page (or `tmex relay enroll <url>`) you enter the relay's password once and your mesh switches from the hub to the relay — existing nodes follow automatically, nothing has to be re-added. The same page lets you re-enter a rotated password, add a second relay for ordered failover, remove one, or leave. Adding a node in relay mode produces a new-style join code that the CLI accepts with `tmex hub join --token …` — no relay URL needed.
- **Relay operator controls.** Site-wide relay password with “kick everyone” or “keep existing tenants” on rotation, per-tenant node/stream/bandwidth quotas with a global default, traffic metering, tenant labels, kick and delete, and an unauthenticated health endpoint for monitoring.
- **Revocation really locks a node out.** In relay mode, revoking a node or rotating your root key automatically re-keys the tenant metadata key for the remaining nodes, so a removed node can no longer decrypt anything new even if it keeps talking to the relay.

### Improvements

- The terminal now uses one state stream end to end. Browsers and nodes older than 1.1.22 are refused with a clear “please upgrade” message instead of silently falling back; custom device-tree ordering travels with the normal metadata and no longer needs a separate snapshot.
- Sizing is more precise: the gateway can tell a real viewport change from a re-declaration after a reconnect or tab switch, ignores stale size messages, and no longer forces a redundant resize when you simply select a pane.
- After a hub failover, your terminal keeps its size ownership and selection instead of dropping out of size arbitration until the next resize.

### Fixes

- Joining a mesh (hub or relay) from the CLI no longer fails when the key log contains passkey-signed records.
- Fixed several connection leaks on the entry gateway when a node was rejected or failover ran out of attempts, and a hub timer that could keep firing after shutdown.
- Restoring the default device-tree order after clearing a custom order now actually returns to tmux's own order.

### Housekeeping

- Removed three HTTP routes that had no callers outside tests (`/api/tmux/tree`, `/api/settings/theme`, `POST /api/hub/nodes/:id/revoke`), the legacy terminal state stream, and the `tailwind-merge` dependency. Settings, security and node-page copy was tightened.

---

## 中文

### 新增

- **公共中继角色。** 一台机器现在可以以 `relay`（或 `relay,node`）运行：这是一个多租户共享的中继，承担 Hub 连接节点的职责，但看不到你的任何内容。中继只掌握租户编号、根公钥、节点编号与链路公钥、在线状态和流量计数；节点名称、设备清单、地址、密钥日志内容和 WebRTC 信令全部用中继拿不到的租户密钥加密。用 `tmex init --role relay` 安装，用 `tmex relay status | passwd | tenants | quota | kick | remove | label` 管理，或在 `relay,node` 机器的设置页新增的「中继」标签里操作。
- **以租户身份接入中继。** 在「节点」页（或 `tmex relay enroll <url>`）输入一次中继口令，整个多节点互联就从 Hub 切换到中继——现有节点自动跟随，无需重新加入。同一页面还可以重输改过的口令、追加第二个中继做有序失效转移、移除其中一个或离开中继。中继模式下添加节点会生成新格式的加入码，命令行用 `tmex hub join --token …` 即可，不再需要中继地址。
- **中继运营者控制。** 全站中继口令，改密时可选「踢掉所有租户」或「保留现有租户」；按租户的节点数 / 并发流 / 带宽配额与全局默认值；流量计量；租户备注；踢出与删除；以及无需鉴权的健康探针便于监控。
- **吊销即真正锁死。** 中继模式下吊销节点或轮换根密钥时，会自动为剩余节点更换租户元数据密钥，被移除的节点即便仍连着中继也解不开任何新内容。

### 改进

- 终端全程只用一条状态流。低于 1.1.22 的浏览器和节点会收到明确的「请升级」提示而不是静默降级；设备树的自定义顺序随普通元数据下发，不再需要单独的快照。
- 尺寸处理更精确：网关能区分真实的视口变化与重连 / 切标签后的重新声明，忽略过期的尺寸消息，选中 pane 时也不再多做一次无谓的 resize。
- Hub 失效转移后，你的终端会保留尺寸归属与选中状态，不再退出尺寸仲裁直到下一次 resize。

### 修复

- 从命令行加入多节点互联（Hub 或中继）时，密钥日志里含通行密钥签名的记录不再导致加入失败。
- 修复入口网关在拒绝节点或失效转移用尽时的多处连接泄漏，以及 Hub 停止后仍可能触发的定时器。
- 清除自定义设备树顺序后，现在能真正退回 tmux 自身的顺序。

### 整理

- 删除三条只有测试在用的路由（`/api/tmux/tree`、`/api/settings/theme`、`POST /api/hub/nodes/:id/revoke`）、旧版终端状态流与 `tailwind-merge` 依赖；精简了设置、安全与节点页的文案。
