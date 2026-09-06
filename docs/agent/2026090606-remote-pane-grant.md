# 远程 agent 窗格授权（pane grant）

## 背景与威胁

远端窗格上的 agent 会话把 `send_input` / `capture` / `pane-info` 三个动作通过
`/api/mesh-internal/tmux/*` 发到目标节点。这三条路由此前只校验 peer 标记
（`readMeshPeerMarker`），也就是「调用方是本用户的某台已准入节点」。

这意味着：mesh 里**任意**一台已准入节点，都可以向**任意**另一台节点的**任意**窗格注入按键、
读走整屏内容。只要有一台节点被攻陷（或某台节点上跑着不受信任的代码），它就能横向拿下其余
节点上所有终端会话。准入本身不构成对具体窗格的授权，这是缺失的一层。

## 设计

目标节点 Y 为「源节点 X + 设备 + 窗格」这一组合签发授权，X 每次 RPC 都要带上。

- **签发**：`POST /api/agent/pane-grants`（Y 上，常规节点会话鉴权）。浏览器能看到 Y 的窗格，
  就必然已经登录过 Y——授权由用户自己的 Y 会话换取，不引入新的信任关系。
  X 在建会话时用 `forwardAuthorizedHttp` 代浏览器发这一次请求（带的是浏览器的
  `tmex_s_<Y>` cookie）。
- **绑定**：授权表 `agent_pane_grants`（id、token_hash、from_node_id、device_id、pane_id、
  created_at、last_used_at、expires_at）。经 mesh 转发签发时，`from_node_id` 一律取 peer 标记，
  请求体里的值只做一致性校验，签发方无法把授权签给别的节点。
- **存放**：token 只在签发响应里出现一次，Y 侧存 SHA-256 哈希；X 侧以主密钥加密后存进
  `agent_sessions.remote_grant`。会话 DTO 不含该字段。
- **有效期**：滑动过期，每次使用续 7 天，自签发起硬上限 30 天；过期即删。周期清扫每 6 小时一次，
  签发时也顺手清一遍。
- **失效**：`DELETE /api/agent/pane-grants/:id` 显式吊销（删 agent 会话时尽力而为地调用一次）；
  节点被吊销时（`emitNodeEvent` 的 `revoked`）删掉它名下全部授权。

## 接口

| 方向 | 接口 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| 浏览器 / X → Y | `POST /api/agent/pane-grants` | 节点会话 | 体 `{fromNodeId?, deviceId, paneId}`，回 `{grantId, token, expiresAt}`；`fromNodeId` 需 32 位十六进制，经 mesh 转发时以 peer 标记为准 |
| 浏览器 / X → Y | `DELETE /api/agent/pane-grants/:id` | 节点会话 | 吊销 |
| X → Y | `/api/mesh-internal/tmux/{pane-info,capture,send-input}` | peer 标记 + 授权 | 体新增 `grant: {grantId, token}` |

RPC 校验顺序：入参格式 → 设备存在 → 授权。失败回 403：缺授权 `PANE_GRANT_REQUIRED`，
其余（token 不符、源节点不符、设备/窗格不符、已过期）统一 `PANE_GRANT_INVALID`——不区分原因，
免得成为探测别的节点或窗格的口子。

## 兼容

- **新 X → 旧 Y**：签发路由 404（`device_not_found` 的 404 不算），X 退化成不带授权继续，
  旧 Y 本来也不校验。该判定按 node 缓存 10 分钟，不会每次发消息都去探一次；Y 升级后一旦回过
  `PANE_GRANT_*`，这条记忆立即作废，下一次请求就补签，不必等缓存到期。
- **旧 X → 新 Y**：被 403 拒。X 升级后首次用户操作即自愈，无需人工干预（见 KI-10）。
- **授权失效后的自愈**：RPC 拿到 `PANE_GRANT_*` 时标记该会话待重签；若期间别的请求刚补签过，
  当场用新的重试一次。真正的补签发生在下一次带用户 cookie 的会话请求里（发消息 / 入队 / 改绑窗格），
  改绑窗格时 `paneId` 与授权不匹配也会触发重签。
- **浏览器没有 Y 的会话**：签发回 401 `NODE_LOGIN_REQUIRED`，X 原样透给前端，
  由既有的节点登录提示接手（`session-interceptor` → `mesh-nodes` 标记未登录），无新增文案。

## 验收

- 单测：`src/agent/pane-grant/store.test.ts`（滑动续期 / 30 天封顶 / 过期 / 四项绑定 / 吊销 / 清扫）、
  `routes.test.ts`（签发与吊销、peer 标记绑定、设备不存在）、`client.test.ts`（签发结果映射、
  补签与落库、拒收后重签、改绑窗格重签、旧节点退化、401 透传）、
  `src/agent/remote-pane-runtime.test.ts`（每次 RPC 带授权、被拒重试一次）、
  `src/mesh/mesh-internal-tmux-routes.test.ts`（三条 RPC 的闸门接在真实账本上）。
- 集成：`src/mesh/integration/pane-grant.integration.test.ts`——真实 mux 链路上验证
  「无授权对端 403」「浏览器建会话即换授权、随后 send-input 放行」「授权绑死窗格」
  「旧目标节点退化路径」「缺 Y 会话回 401」。
- 迁移：`src/db/agent-pane-grants.migration.test.ts`（老库补表与补列，既有会话不受影响）。
