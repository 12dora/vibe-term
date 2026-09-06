# 远程 agent 窗格授权（pane grant）

## 背景与威胁

远端窗格上的 agent 会话把 `send_input` / `capture` / `pane-info` 三个动作通过
`/api/mesh-internal/tmux/*` 发到目标节点。这三条路由此前只校验 peer 标记
（`readMeshPeerMarker`），也就是「调用方是本用户的某台已准入节点」。

这意味着：mesh 里**任意**一台已准入节点，都可以向**任意**另一台节点的**任意**窗格注入按键、
读走整屏内容。只要有一台节点被攻陷（或某台节点上跑着不受信任的代码），它就能横向拿下其余
节点上所有终端会话。准入本身不构成对具体窗格的授权，这是缺失的一层。

## 设计

目标节点 Y 为「源节点 X + 设备 + 窗格 + tmux server 世代」这一组合签发授权，X 每次 RPC 都要带上。

- **签发**：`POST /api/agent/pane-grants`（Y 上，常规节点会话鉴权）。浏览器能看到 Y 的窗格，
  就必然已经登录过 Y——授权由用户自己的 Y 会话换取，不引入新的信任关系。
  X 在建会话时用 `forwardAuthorizedHttp` 代浏览器发这一次请求（带的是浏览器的
  `tmex_s_<Y>` cookie）。
- **绑定**：授权表 `agent_pane_grants`（id、token_hash、from_node_id、device_id、pane_id、
  server_epoch、created_at、last_used_at、expires_at）。经 mesh 转发签发时，`from_node_id` 一律取
  peer 标记，请求体里的值只做一致性校验，签发方无法把授权签给别的节点。
- **窗格世代**：tmux 的窗格号在同一个 server 内不复用，但 server 重启后从 `%0` 重新开始——
  只绑窗格号等于把「同一个号」当成「同一个窗格」。因此签发时一并绑上该设备当前的
  `@tmex-server-epoch`（`ensureStableServerEpoch` 写在 tmux 全局选项里，跨 gateway 重启稳定），
  每次 RPC 拿到运行时后比对：不一致即删除授权并回 `PANE_GRANT_INVALID`，由源节点重签。
  签发时读不到世代（tmux 连不上）就不签发（503 `pane_unavailable`），绝不签一张不绑世代的。
- **存放**：token 只在签发响应里出现一次，Y 侧存 SHA-256 哈希；X 侧以主密钥加密后存进
  `agent_sessions.remote_grant`。会话 DTO 不含该字段。
- **有效期**：滑动过期，每次使用续 7 天，自签发起硬上限 30 天；过期即删。周期清扫每 6 小时一次，
  签发时也顺手清一遍。
- **失效**：`DELETE /api/agent/pane-grants/:id` 显式吊销。被顶替、被丢弃、会话已删的授权 id 进
  待吊销队列，随下一次带 cookie 的请求重试，目标明确回答「删了 / 没这张」才摘掉（冲不掉的
  最多留 64 条，其余靠自然过期）。
- **吊销节点**：`revoke-node` 记录**落库的同一个事务**里删掉该节点全部授权（`apply` 与
  `applyMany` 两条路都经过同一处投影，对端 key log 同步 / 中继补日志因此同样生效）；
  提交后的投影再就地断链并广播 `revoked` 事件。此外 `verifyPaneGrant` 自己也会查证书：
  `node_certs.revoked_log_seq` 非空即拒并清掉该节点余下的授权——链路还没断也进不来。
  `reset-root` 删光证书时同样清空全部授权。
- **替换**：同一会话的补签串行（每会话一条 Promise 链），落库前再确认绑定没被改过（密文先算好，
  检查与写入之间不留 await），被顶替的那张立刻进待吊销队列——否则旧窗格的 token 会在源节点手上
  一直有效到 30 天上限。

## 接口

| 方向 | 接口 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| 浏览器 / X → Y | `POST /api/agent/pane-grants` | 节点会话 | 体 `{fromNodeId?, deviceId, paneId}`，回 `{grantId, token, expiresAt}`；`fromNodeId` 需 32 位十六进制，经 mesh 转发时以 peer 标记为准；目标 tmux 连不上回 503 `pane_unavailable` |
| 浏览器 / X → Y | `DELETE /api/agent/pane-grants/:id` | 节点会话 | 吊销 |
| X → Y | `/api/mesh-internal/tmux/{pane-info,capture,send-input}` | peer 标记 + 授权 | 体新增 `grant: {grantId, token}` |

RPC 校验分两段：连 tmux 之前先验绑定（入参格式 → 设备存在 → 授权），拿到运行时之后再比对
server 世代——未获授权的对端不该把目标的 tmux 拉起来。失败回 403：缺授权 `PANE_GRANT_REQUIRED`，
其余（token 不符、源节点不符、设备/窗格不符、世代不符、证书已吊销、已过期）统一
`PANE_GRANT_INVALID`——不区分原因，免得成为探测别的节点或窗格的口子。

## 改绑窗格

`PATCH /api/agent/sessions/:id` 改 `paneId` 时，先按**将要写入**的窗格签一张（会话不动），
再把绑定与新密文一并提交，提交带并发校验（`updatedAt` + 绑定三要素；只比时间戳不够，
毫秒 ISO 串在同一毫秒内会撞车）。授权签不下来（浏览器没有 Y 的会话）直接回 401，库里一个字段
都没动；提交时发现别处已改绑则回 409 `apiError.agentSessionChanged`，刚签的那张进待吊销队列。

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

- 单测：`src/agent/pane-grant/store.test.ts`（滑动续期 / 30 天封顶 / 过期 / 绑定四要素 / 未绑世代 /
  证书已吊销 / 吊销 / 清扫）、`routes.test.ts`（签发与吊销、peer 标记绑定、设备不存在、世代读不到）、
  `client.test.ts`（签发结果映射、补签与落库、拒收后重签、旧节点退化、401 透传、并发补签只签一张、
  顶替与吊销重试、落库前绑定变更、prepare 只签不写）、
  `src/agent/remote-pane-runtime.test.ts`（每次 RPC 带授权、被拒重试一次）、
  `src/mesh/mesh-internal-tmux-routes.test.ts`（三条 RPC 的闸门接在真实账本上、tmux 重启即失效）、
  `src/auth/pane-grant-revocation.test.ts`（`apply` / `applyMany` / 重新 bootstrap 三条提交路径）、
  `src/mesh/key-log-projection.test.ts`（吊销落库后就地断链）、
  `src/api/agent-pane-rebind.test.ts`（改绑先签后写、401 不落库、并发改绑 409）。
- 集成：`src/mesh/integration/pane-grant.integration.test.ts`——真实 mux 链路上验证
  「无授权对端 403」「浏览器建会话即换授权、随后 send-input 放行」「授权绑死窗格」
  「旧目标节点退化路径」「缺 Y 会话回 401」「目标 tmux 重启后旧授权失效、重签即恢复」。
- 迁移：`src/db/agent-pane-grants.migration.test.ts`（0051 老库补表与补列，既有会话不受影响）；
  0053 只加 `agent_pane_grants.server_epoch` 一列，未绑世代的旧授权按无效处理（自动重签）。
