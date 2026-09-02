# tmex hub / node 运维指南

本文面向把单机 tmex 扩成「一台公网入口 + 多台 NAT 后设备」的安装与日常运维。架构与威胁模型见 [hub/node 多节点架构设计](./2026082700-hub-node-architecture.md)（v3.2）。本文只描述当前已落地行为；已知限制单独列出，不把设计里尚未实现的项写成操作步骤。

鉴权已从 JWT / 管理员密码 / OIDC 改为**用户自持根钥（密码派生 Ed25519）+ 可选 passkey / TOTP**。存量 `standalone` 安装升级后仍无登录页、旧路由可用。

## 部署矩阵

`TMEX_ROLES` 只能是下列三者之一，非法值启动失败。没有纯 `hub` 角色：hub 总是与本机 node 同进程。

| 角色 | 典型用途 | 启动时构造 | 登录 | 直连 addon |
|---|---|---|---|---|
| `standalone`（默认） | 单机，未加入 mesh | 仅 `GatewayRuntime` | 无（`GET /api/auth/mode` → `{mode:'none'}`） | 不下载 |
| `node` | 已加入 hub 的设备 | Gateway + Mesh（真实 WSS uplink） | 有，`localUiGuard` | `init` / `upgrade` 默认尝试 |
| `hub,node` | 公网入口兼本机设备 | Hub + Gateway + Mesh（进程内 uplink） | 同上 | 同上 |

请求顺序（mesh 角色）：`HubRuntime`（`/api/hub/*`、`/hub/uplink`）→ mesh 本地守卫 → mesh（`/api/auth/*`、`/api/mesh/*`、`/mesh/ws`、`/n/:id/*`）→ gateway → 前端 SPA（覆盖 `/login`、`/nodes`、`/n/:id/...`）。standalone 不构造 mesh，只挂轻量 `GET /api/auth/mode`。

关停（仅 mesh 角色装 SIGINT/SIGTERM）：peer links → uplink → hub → gateway，预算 20 s。standalone 不装信号处理器。

同一 mesh 需要第二台公网入口时，把已加入的 node 配成 **standby hub**（`hub,node` + `TMEX_HUB_MODE=standby`），由人工 `promote` / `demote` 切换写者。第一阶段是主/备、单写者、有序 failover，不是自动选主。操作、围栏与切回顺序见 [多 hub 主/备](./2026090104-multi-hub-standby.md)。

生产 HTTP 默认绑定 `127.0.0.1:9883`（`init` 写入 `TMEX_BIND_HOST` / `GATEWAY_PORT`）。peer 口与 HTTP 口分离。

## 环境变量

生产变量来自安装目录 `app.env`（`init` 写入，`upgrade` **只追加缺失键**，不覆盖已有值）以及 `run.sh` 导出的路径键。改完需重启服务。开发 / 测试三套环境见 [三套环境](../env/2026061301-three-tier-env.md)，与生产安装无关。

### `init` / `upgrade` 会写入的键

| 变量 | 默认 | 说明 |
|---|---|---|
| `TMEX_ROLES` | `standalone` | 见上表 |
| `TMEX_HUB_URL` | 空 | node 连 hub 的基址（`hub join` 成功后写入）。`hub,node` 用进程内 uplink，可不填 |
| `TMEX_HUB_PUBLIC_URL` | 空 | hub 对外 HTTPS 地址，写入 join 命令与 `/api/auth/mode.hubPublicUrl`。非交互 `init --role hub,node` **必填** `--hub-public-url` |
| `TMEX_PEER_PORT` | `39001` | node↔node 信令监听口，只承载签名信令 |
| `TMEX_STUN_SERVERS` | `stun:stun.l.google.com:19302` | 逗号分隔，经 `node.list` 下发给各 node 与浏览器 ICE |

`init` 另支持 `--hub-url`、`--hub-public-url`、`--peer-port`、`--stun-servers`。

### 需手写进 `app.env` 的键

下列键运行时会读，但 **`init` / `upgrade` 不会写入**，缺省即关闭或走代码默认。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TMEX_PEER_BIND_HOST` | 未设 | peer 口绑定。空 / 未设 → dual-stack `::` 与 `0.0.0.0`。不进 `config.ts`，mesh 直接读 env |
| `TMEX_TURN_URL` / `TMEX_TURN_USERNAME` / `TMEX_TURN_CREDENTIAL` | 空 | 三者齐全才下发 TURN。`turns:` → TLS，`?transport=tcp` → TCP，其余 UDP |
| `TMEX_TRUST_PROXY` | `false` | 仅 **本机 Bun socket（via=self）** 信任 `X-Forwarded-Proto` / `X-Forwarded-Host`，用于公网 origin、`Secure` cookie、passkey 可用性。转发请求永不信任。Cloudflare Tunnel 等反代场景必须设 `true` |
| `TMEX_HUB_MODE` | `active`（hub 角色启用时） | hub 角色：`active` 或 `standby`。其它值启动失败 |
| `TMEX_HUB_PRIORITY` | active `100` / standby `200` | 同 mode 下越小越优先，整数 ≥ 0 |
| `TMEX_HUB_WRITER_EPOCH` | `1` | writer 世代，整数 ≥ 1，单调递增 |
| `TMEX_HUB_URLS` | 空 | 逗号分隔的备用 hub 基址，接在 `TMEX_HUB_URL` 之后去重 |
| `TMEX_HUB_PEERS` | 空 | 逗号分隔的 32-hex 节点 id：本 hub 授权的**其他** hub。未列入的节点广告不会进入 `mesh_hubs`、不能 fencing、也不能当 writer |
| `TMEX_NATIVE_DIR` | `run.sh` 导出 `<installDir>/native` | native addon 目录。未设则 loader 返回 `null`，`direct_capable=false`。不要指向本机生产安装目录去做开发验证 |
| `RTC_LIVENESS_INTERVAL_MS` | `3000` | node↔node DataChannel 空闲时发 ping 的间隔。通道上有入站流量则重置，不给忙通道加 ping |
| `RTC_LIVENESS_TIMEOUT_MS` | `10000` | 连续无任何入站（含 ping/pong 与业务帧）超过此时长则判定直连死亡，关闭 DC/PC 并回落 relay。须大于 `RTC_LIVENESS_INTERVAL_MS` |
| `TMEX_EVENT_LOOP_LAG_WARN_MS` | `250` | event loop 采样滞后超过该值时打告警（10 s 至多一条） |
| `TMEX_RTC_DIAL_BREAKER_MS` | `21600000`（6 h） | 同一 peer 连续 8 次 DataChannel 失败后跳过 DC dial 的时长；ws-secure / relay 不受影响 |
| `TMEX_FAILOVER_HISTORY_BYTES_PER_PANE` | `262144`（256 KiB） | legacy failover 每 pane 重拉历史的预算；单次 failover 合计上限 1 MiB，超出只重订订阅 |

相关但非 mesh 专有：`TMEX_MASTER_KEY`（加密落库的节点私钥等，生产必填）、`TMEX_BIND_HOST`、`GATEWAY_PORT`、`DATABASE_URL`。

## 首次搭 hub

推荐路径：一台有公网 HTTPS 的机器做 `hub,node`，内网机器 `init` 后 `hub join`。包与升级流程与单机相同（`bash install.sh` / `tmex upgrade`）。

安装目录默认：macOS `~/Library/Application Support/tmex/`，Linux `~/.local/share/tmex/`。服务由 launchd / systemd 用户单元拉起。**不要**手改正在跑的生产安装目录里的库或 `app.env` 做试验。

### 1. 在入口机安装并指定角色

```bash
bash install.sh --role hub,node
```

交互模式会询问 `TMEX_HUB_PUBLIC_URL`（浏览器与 `hub join` 使用的 HTTPS 基址，例如 `https://tmex.example.com`）。非交互：

```bash
bash install.sh --role hub,node --no-interactive \
  --install-dir "$HOME/Library/Application Support/tmex" \
  --host 127.0.0.1 --port 9883 \
  --db-path "$HOME/Library/Application Support/tmex/data/tmex.db" \
  --autostart true \
  --hub-public-url https://tmex.example.com
```

`init --role node|hub,node` 结束时默认执行 `direct enable`（下载当前平台 `.node`）；失败只打日志，不阻断安装。随后 `direct_capable=false`，数据面走 hub relay。

### 2. 创建首个用户

在 **hub 机本机**（服务已起来，命令走安装版 Bun 的 `runtime/cli-auth.js`）：

```bash
tmex hub user add <username>
```

TTY 隐藏输入密码并二次确认；非 TTY 用 `TMEX_PASSWORD`。密码经 NFKC 后再做 argon2id。成功后：

- 写入 `users`，生成本机节点证书并自签 `admit-node`（hub 机无需 `hub join`）；
- 打印根公钥指纹（sha256 hex）；
- 已有同名用户会拒绝，替换根钥请走 `mesh reset-root`，不要重复 `add`。

### 3. 签发 enrollment

任选其一。token 默认 10 分钟有效（`--ttl 10m`，如 `30s` / `5m` / `1h`）。

**CLI（任意已加入的 node，含 hub 机）：**

```bash
tmex enroll [--ttl 10m]
```

输入密码（若该用户已启用 TOTP，再输入 `TMEX_TOTP` 或交互验证码）。打印 join 串与完整 `hub join` 命令，然后等待对端 redeem：

- hub 角色：轮询本机 `enrollment_tokens` 里 redeem 回写的证书，到则自动签 `admit-node`；
- 非 hub：登录 hub 后轮询 `GET /api/hub/nodes` 的 `certificate` / `cert_sig`；
- Ctrl-C（SIGINT）结束等待，提示到 Nodes 页确认。

**UI：** 任意已登录入口打开 `/nodes` → 新增节点（密码或本 origin 的 passkey）→ 复制 join 命令。`enroll_sk` 只在内存，刷新后不再展示 join 串；pending 元数据在标签页 `sessionStorage`（不含私钥）。

join 串有两个版本：

- **v1**：`base64url(enroll_sk ‖ root_public_key ‖ key_log_head_hash)`，恰好 128 字符。
- **v2**（hub 为 self-signed HTTPS 时）：`<v1>.<64 位小写 hex>`，hex 是该 hub CA 的 SPKI SHA-256。加入端用它 pin 住 `GET /api/tls/ca.crt` 拉到的 PEM，写入本机 `hub_trust`（按 hub URL 一行）；之后对该 URL 的 hub-client HTTP 与 uplink WebSocket 都带 `tls.ca`。无 fingerprint 的旧串仍可 join，行为与 v1 相同。
- **CA 轮换**：本地 CA 剩余有效期不足 30 天时 `TlsService` 会生成新 CA 并重签叶子证书，SPKI 指纹随之改变；已加入的 node 里 `hub_trust` 仍是旧 CA，uplink 会握手失败，需在 hub 上重新生成 join 串并让各 node 重新 `hub join`（或通过设置页向导加入）。CA 有效期 10 年，正常部署内不会触发。

**`enroll_sk` 不经过 hub。** CA pin 只约束那一台 hub 的 URL，换 hub 要重新 enroll / join。

### 4. 各机加入

在每台要加入的机器上（可先 `init --role standalone` 或 `--role node`）：

```bash
tmex hub join https://tmex.example.com --token <join 串> [--name 书房]
```

约束：

- 只接受 `https:`；HTTP 重定向一律拒绝（`redirect: 'error'`）；
- `http://127.0.0.1` / `http://localhost` 仅非 production 且加 `--insecure-local`；
- 以 join 串里的根公钥与 `key_log_head_hash` 为锚点校验全链，再原子写入 users / 日志 / 证书 / `node_identity`（v2 串还会把 CA PEM 写入 `hub_trust`），然后写 `TMEX_HUB_URL`、`TMEX_ROLES=node`（已是 `hub,node` 则保留）并重启服务；指纹对不上则 `join_failed: ca_fingerprint_mismatch`，不落库；
- 本机若已有同名用户但 uid / 根钥不同（hub 重建或对端 `reset-root` 后再 join），校验通过后原子替换该用户的本地状态：删旧 `user_key_log`、`user_keys`、`node_sessions`、旧根签发的 `node_certs`、旧 hub 的 `peer_cache` / `nodes`，再写入新用户。本机 nodeId 密钥对保留。同一 uid 再次 join 为幂等 upsert，不会重复行；
- 同一 nodeId + 同一节点公钥再次 `hub join`（新 enrollment token，同一 hub epoch）是幂等的：redeem 消耗新 token，但**不签发新的节点证书**，响应里的 `node_certs` 仍是已 admit 的那张（`already_admitted: true`）。enroll 侧发现该 `node_id` 已在 keylog 中则跳过第二次 `admit-node`，打印 `already admitted`（不是 `node admitted`）。uplink 继续用原证书。`node_exists`（HTTP 409）只在该 nodeId 已被**另一把公钥**占用时出现。不必 `hub user reset` 清掉半途失败留下的 registry 行；
- 已吊销节点用**同一身份**再 join：redeem 返回 HTTP 409 `node_revoked`，`hub join` 失败并提示 `this node identity was revoked; use a fresh identity (mesh reset / re-init)`。不能靠再 admit 解吊销。换钥重装须先 `revoke-node` 再 enroll **新身份**（新 nodeId / 新密钥，或 `mesh reset` / 重新 `init`）；
- 不必先 `hub leave`：从角色 `node` 直接 join 另一台 hub 即可，`leave` 只清角色与 `TMEX_HUB_URL`；
- 成功后提示在内网防火墙放行 `TMEX_PEER_PORT`（仅内网直连需要）。替换了旧账号时会打印一条明确日志。

加入后各入口侧边栏自动出现新 node，无需手动添加设备。退出 mesh：`tmex hub leave`（清 `hub_url`，角色改回 `standalone`，重启）。

## Nodes 页

路由 `/nodes`，任意已登录的 mesh 入口可用。standalone 整页不渲染。

表格：在线 / 离线、到达路径、版本、直连能力、登录状态、公钥指纹（sha256 前 16 hex）。self 行不能吊销当前入口。

`GET /api/mesh/nodes` 除兼容字段 `reach`（`lan` / `relay` / `null`，`lan` 不区分 WS 与 DataChannel）外还有 `transport`：`ws-secure` | `relay` | `dc` | `null`。要确认跨 NAT 直连是否真的建起来，看对端 `transport === "dc"`，不要只看 `reach=lan` 或 `direct_capable=true`（后者只表示允许尝试 DC）。

node↔node WebRTC 由 **nodeId 字典序较小的一侧发 offer**。业务请求只发生在较大 id 一侧时，该侧会经已认证的 hub `rtc.signal` 通道发一条签名 wake（`sdp` 内 `type=rtc.wake`，对 `{domain:tmex-rtc-wake, from, to, rtcSession, nonce, issued_at}` 用发送方节点 Ed25519 私钥签名）唤醒较小 id 去 `getLink`；hub 只转发、不解释、不验签。接收端用 `node_certs` 验签，拒绝坏签名、时钟偏差 > 60s、重放 nonce，以及自己并非该对 offerer 的 wake；每对端有接收冷却。发送侧 5s 冷却若挡住了仍需要的 wake，会在 `nextEligibleAt` 补发（DC 到达或本次拨号结束则取消）。已是 `dc` 的忽略。`node.list` / 对端 `direct_capable` 翻成 true 时两边都会 `maybeUpgrade()`。已打开的 node↔node stream 留在旧链路上，**不会**随 carrier-switch 迁到 DC（carrier-switch 只服务浏览器 `sess`）；新 stream 在 `waitForTransport(id, 'dc')` 成功后再开才会走 DC。

| 动作 | 行为 |
|---|---|
| 新增节点 | 凭据对话框（密码或本 origin 的 passkey）签 enrollment 授权，POST hub；展示 join 命令。签名者进入 5 分钟复用窗口 |
| 自动 admit | 对端 `hub join` redeem 后，`/mesh/ws` 推 `ENROLL_REDEEMED`（只给创建该 enrollment 的会话），并按 enrollment id 轮询 `GET /api/hub/enrollments/:id` 兜底。**仅根钥签名者**会在证书到达时后台自动签 `admit-node`；passkey 必须用户点「确认」（浏览器 user activation） |
| 待确认 / 重试 | 页面已关、窗口过期、或 `POST /api/auth/keylog?hub=sync` 未拿到 `hubAck:true` 时保留 pending。409 / 504 不当成成功 |
| 重命名 | hub 在线时可改 `nodes.name` |
| 吊销 | 每次都要当场确认凭据（不进复用窗口），只走 `keylog?hub=sync` 写 `revoke-node`。hub 未确认则告警、不刷新列表 |

hub 不可达（`mode.hubNodeId` / `isHub` 学不到）：顶栏提示，新增 / 重命名 / 吊销禁用。非 hub 机在 `peer_cache` 学到 hub 元数据之前也是这种降级。

侧边栏：在线已登录懒建该 node 运行时；在线未登录只显示「登录此节点」，不建连接；离线灰显缓存的设备名。

## 远程卸载

入口「设置 → 多节点互联 → 节点管理」可对已登录的远程节点执行「卸载 tmex」。入口不能卸载自己（`UNINSTALL_SELF_BLOCKED`）。

流程：

1. 入口 `POST /api/mesh/nodes/:id/uninstall` 要求本机会话、目标已在该入口登录（否则 `NODE_LOGIN_REQUIRED`）且 peer 可达（否则 `NODE_UNREACHABLE`），再经 peer link 转发 `POST /api/system/uninstall`，body 为 `{ mode: "full" }`。
2. 目标必须是 CLI 安装（`installedViaCli` 且 `deployment` 为 `launchd` / `systemd`）。容器、手动部署或 managed 构建返回 409 `UNINSTALL_NOT_ALLOWED`；正在升级返回 409 `UPGRADE_IN_PROGRESS`。旧版本没有该接口（404/405）→ 501 `UNINSTALL_UNSUPPORTED`。`GET /api/system/info` 的 `upgradeCapabilities` 含 `uninstall`，入口用来区分旧目标。
3. 目标把 `current/cli`（解析 `current` 符号链接到 `versions/<v>`）整目录拷到 `tmpdir/tmex-uninstall-<id>/`，再 detached 拉起 `tmex uninstall --yes --purge --install-dir <installDir> --delay-ms 1500`，立刻 202 `{ state: "scheduled" }`。`--delay-ms` 让 202 先刷出再停服务。随后卸载器停 launchd/systemd 用户服务、删安装目录（`versions/`、`current`、`staging`、`backups`、`app.env`、`data/` 含 SQLite `-wal`/`-shm`）、带 tmex 标记的 shim（`~/.local/bin/tmex`、`~/.bun/bin/tmex`），并尽量删掉这份临时拷贝。不会碰安装目录、unit/plist 和已标记 shim 以外的路径。
4. 入口把长事务记在 `gateway_kv` 键 `mesh.node-op.<nodeId>`（`MeshNodeOperation`）：`requested`（转发前）→ `uninstalling`（目标 202）→ `failed`（带 `error`）。`GET /api/mesh/nodes` 每行带 `operation`（无则 `null`），页面刷新仍显示卸载中。记录自 `updatedAt` 起 TTL 30 分钟；节点从列表消失（吊销 / 移除）时在列表投影里惰性清除；也可 `DELETE /api/mesh/nodes/:id/operation`。`GET /api/mesh/nodes/:id/operation` 返回该记录或 404。
5. 前端随后走既有签名 `revoke-node` 从 hub 去掉该节点。卸载不代替吊销。

本机手动卸载仍用 `tmex uninstall [--yes] [--purge] [--delay-ms <n>]`。

## 账号安全：passkey 与 TOTP

页面 `/account/security`（登录页底部也有入口）。standalone 整页不渲染。持久变更（改密、TOTP、增删 passkey、admit / revoke）都要根钥或 passkey 当场签一条 `user_key_log` 记录，浏览器临时钥 `sk_sess` 签不了这些记录。

### passkey

- WebAuthn：RP ID 必须是域名或 `localhost`，**IP origin 不可用**。每个凭证绑定注册时的精确 origin（scheme + host + port）。
- `passkeyAvailable` = 安全上下文且 host 为域名或 localhost。反代后若服务端看到的是 `http://127.0.0.1`，按钮不会出现——见下文 `TMEX_TRUST_PROXY`。
- 登录：本 origin 有凭证才显示按钮；passkey 登录不需要 TOTP。
- 注册 / 删除：凭据对话框，密码或已有 passkey 均可授权。

同一 node 可从多个域名 origin 各注册一把，无需额外配置。

### TOTP

- 防远程猜密码 / 旁观，**不是**独立于口令的第二因素（与根钥同源派生）。需要独立第二因素时用 passkey。
- UI 两段式：先生成密钥与 otpauth URI（不写日志）→ 扫码并输入 6 位码 → 本地校验通过才追加 `set-totp`。取消或离开页面会清零密钥。
- **启用 TOTP 只能用密码**（需要 seed）。关闭 TOTP、增删 passkey 可用 passkey 授权。
- CLI：`tmex hub user totp <username>` 打印 otpauth URI（无 ASCII QR）。

### 改密

日常改密走 `rotate-root-keep`（旧根钥签）：更新根公钥、KDF 与 `root_epoch`，**保留** passkey、已启用的 TOTP（随记录按新 epoch / 新 seq 重封装）以及当前入口会话。未使用的 enrollment token 会立即失效，须重新签发。写入前所有未吊销节点须 ≥ 1.1.16，否则 409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`；该类型不允许 `x-tmex-force-keylog` 绕过，以免旧节点按未知类型丢弃记录、造成状态分裂。

`rotate-root` 仍是破坏性改密：撤销全部 `node-session`、清空 passkey 与 TOTP，须在各入口重新注册。`tmex hub user passwd <username>` 若仍走 `rotate-root`，语义与此相同。非 TTY：旧密码 `TMEX_PASSWORD_OLD`，新密码 `TMEX_PASSWORD`。灾难恢复仍用 `reset-root` / `mesh reset-root`，不要用日常改密代替。

登录体验：输入一次密码（或一次 passkey）生成 18 小时 `delegation`，先登当前入口 `self`，再用 `tmex_s_self` 拉 `/api/mesh/nodes`，对在线未登录的 node 并行登录。cookie `tmex_s_<nodeId>` / `tmex_s_self`：`HttpOnly; SameSite=Lax; Max-Age=64800`（18 h），HTTPS 加 `Secure`。滑动续期 18 小时，绝对上限 7 天。

## 直连：`direct enable|disable`

直连是同一逻辑 WS 会话的第二条载体（浏览器↔目标 node 的 `sess` DataChannel），失败自动回落 hub relay，功能不变。

```bash
tmex direct enable
tmex direct disable
```

`enable` 按 `platform / arch / libc` 查 pinned manifest，从 npm 拉单平台 tarball，校验 sha512 后解出 `node_datachannel.node` 到 `<installDir>/native/`，并写 `native/manifest.json`。`disable` 删除整个 `native/` 目录。`upgrade` 在部署 runtime 后若已有 native 且版本变化则重下；standalone 无 `native/` 则跳过。

**v1 支持的平台：** macOS arm64 / x64，Linux glibc x64 / arm64。**musl、Windows、其它 arch 不支持**（`lookupNativePin` 返回 `null`，enable 失败且不阻断）。缺失或装载失败 → `direct_capable=false`，authorize 返回 503 `DIRECT_UNAVAILABLE`，浏览器退避最多 5 次后停在 failed。

ICE 顺序（自动）：同内网 host → IPv6 → IPv4 STUN → TURN → hub relay。未实现 UPnP / NAT-PMP。空 ICE 服务器列表在 PoC 中会长时间超时，因此默认带 STUN；可按网络换成可达的 STUN/TURN。

设备页（非 `self`）两枚徽标：浏览器↔node 路径（`lan` / `v6` / `v4-p2p` / `turn` / `relay` 与 RTT）和 entry↔node 的 `reach`。直连断开时切回 primary，并对已订阅 pane 做一次 resume；浏览器→node 方向在断开瞬间可能丢最近输入，界面提示「直连已断开，最近输入可能未送达」。

**entry↔目标 node 的转发流（`/n/:id/ws` 与幂等 HTTP）同样会 failover。** 打开的 pane 订阅绑定在当前 peer link（`dc` / `ws-secure` / `relay`）上；DataChannel 断开后，entry 保持浏览器侧 WebSocket 不关，在当前最优链路上重开同一逻辑流，并回放 HELLO、已连接 device、pane 订阅。**canonical 订阅**（`SetPaneSubscriptions`）带上最后收到的 `PaneData.terminalSeq` 游标，新链路上按游标精确续传。**legacy 订阅**（`TMUX_SUBSCRIBE_PANES`）协议没有 cursor：回放 subscribe 之后会对每个已订阅 pane 发 `TMUX_FETCH_PANE_HISTORY`，用 `TERM_HISTORY` 快照重建终端视图，再接上 live `TERM_OUTPUT`；旧 session 死亡到新订阅完成之间的输出不会按字节精确续传。failover 期间到达的浏览器帧会排队，canonical 的 generation 会抬到回放帧之后，避免同 generation 冲突。若短时间内没有任何备用链路，entry 按有界退避重试并保持浏览器连接；用尽后才关掉浏览器 WS，由前端走既有重连。日志：`[mesh][stream] failover stream=… from=dc to=relay|ws-secure resumed=<n panes>`。GET/HEAD 在拿到响应头之前也会按同样策略换链路重试。

node↔node DataChannel 另有应用层存活探测：空闲时每 `RTC_LIVENESS_INTERVAL_MS`（默认 3 s）发一帧 ping/pong；任意入站流量都会重置计时。连续 `RTC_LIVENESS_TIMEOUT_MS`（默认 10 s）无入站则关闭该 DC/PeerConnection，`transport` 从 `dc` 回落（既有 carrier-switch / `getLink` 路径），日志为 `[mesh][rtc] liveness timeout peer=… idle_ms=…`。不要只等 ICE `disconnected`→`closed`（实测约 35 s）。浏览器 `sess` 载体识别并回复 ping，但不主动探测（浏览器侧尚未发 ping）。回连走既有 RTC wake 冷却（`PEER_RTC_WAKE_COOLDOWN_MS`，5 s），避免直连抖动时打爆信令。

## Cloudflare Tunnel 与反代

Cloudflare Tunnel / Access 可放在 hub 或任一 node 前面。推荐：

1. `TMEX_BIND_HOST=127.0.0.1`，cloudflared 指到本机 `9883`；
2. `TMEX_HUB_PUBLIC_URL` 写成隧道的 `https://` 域名；
3. **`app.env` 增加 `TMEX_TRUST_PROXY=true` 后重启**，否则：
   - cookie 可能缺 `Secure`；
   - passkey 的 origin / `passkeyAvailable` 按 `http://127.0.0.1` 计算，公网域名下无法注册或登录。

该开关只作用于本机 UI 的 origin 计算，**不会**把转发来的 `X-Forwarded-*` 当成客户端 IP。

### 连接器健康

cloudflared 进程存活不等于边缘连通。本机代理 / TUN 抖动时进程常驻，日志里会出现 `TLS handshake with edge error` / `Unable to establish connection with Cloudflare edge`，公网地址随之不可达。

权威信号是连接器本地 metrics：`GET http://127.0.0.1:<port>/ready`（`--metrics`、启动日志 `Starting metrics server on 127.0.0.1:20241/metrics`，缺省扫描 `20241–20245`）。`readyConnections === 0` 时状态为 `degraded`，连通性检查返回 `connector_down`（HTTP 503），即使 hostname 被 Cloudflare Access 302 拦截也不能当成成功。Access 拦截且连接器已验证有连接 → `access_protected`；找不到 metrics → `access_protected_unverified`。外部托管的 cloudflared 会读 `--logfile` 尾部（脱敏）填 `status.log`。`GET /api/tunnel/status` 对连接器探测最多等待约 800ms，过期则后台刷新。

## hub 离线

登录不经过 hub，流程与在线相同。`node.list` 里的 hub 元数据会落入 `peer_cache` 哨兵行，重启后 `/api/auth/mode` 与节点列表在 uplink 断开时仍可回答。

同内网互操作依赖 `peer_cache` 里上次上报的地址（`os.networkInterfaces()` 的非 internal IPv4/IPv6 + `TMEX_PEER_PORT`）。**v1 不做局域网发现**：hub 不可达期间若对端 IP 变了，缓存失效，须等 hub 恢复。peer link 仍然活着时，地址变化会立刻互相更新。

Nodes 页的管理动作（enroll / 改名 / 吊销）在 hub 离线时禁用。普通终端 / 文件走已有 peer link 或缓存 LAN 信令，不依赖 hub。

hub 恢复后无需重新登录（cookie 仍有效）。

## 灾难恢复

两条都是**本机**命令，不接受远程触发。拥有机器 root = 拥有该点。

### `mesh reset-root`（任意 mesh 机器）

```bash
tmex mesh reset-root
```

`TMEX_ROLES=standalone` 会拒绝。输入新密码后保留用户名，在本机重建根钥并自签 `admit-node`。用于「密码在失陷入口上泄露、攻击者抢先 `rotate-root`」这类无法依赖旧根钥的场景。

之后：**每台机器都要再执行一次**；其它机器需重新 `enroll` / `hub join`。hub 侧配合下面的 registry 清空。其它机器本地即使仍留着同名旧用户（uid / 根钥已变），`hub join` 也会原子替换该账号，不必先 `hub leave`。

### `hub user reset`（仅 hub 机）

```bash
tmex hub user reset
```

停服务 → 删除 `nodes` 与 `enrollment_tokens`（**保留 `node_certs`**）→ 再启动。日志提示：失陷节点在重新注册前须先 `revoke-node`。这只清注册表，不是改密。

日常改密用 `hub user passwd` / 账号安全页，不要用这两条。

## 常见排障

| 现象 | 含义 | 处理 |
|---|---|---|
| node 角色无 `[uplink]` 日志、或一直连不上 hub | `runLoop` 连 hub 失败会吞掉错误并退避；现每次尝试打 `[uplink] connect failed hub=<host:port> attempt=<n> reason=<code> next_retry_ms=<delay>`（同一 reason 最多 30 s 一条），成功为 `[uplink] online hub=… after_ms=…`，掉线为 `[uplink] offline reason=…`。不打 URL / token。hub 侧每次鉴权失败打 `[hub][uplink] auth rejected node=<id> reason=<cert_not_admitted\|revoked\|bad_sig\|bad_cert\|timeout\|…>`（同一 node+reason 最多 10 s 一条，后续带 `suppressed=`） | 看 node 的 `reason`：`tls` 证书链不被系统信任；`dns` 解析失败；`refused` 端口未开或防火墙；`timeout` TLS/WS/auth 握手超过 `UPLINK_CONNECT_TIMEOUT_MS`（默认 20 s）；`http_4401` / `http_403` 升级被拒；`auth_rejected` 证书未 admit / 已吊销 / 签名失败。对照 hub 的 `reason`：`cert_not_admitted` 尚未 admit 或证书不在 `node_certs`；`revoked` 已吊销（须换新身份）；`bad_sig` 签名失败（含 hubHost 不一致）；`bad_cert` 证书损坏。进程内 `UplinkClient.lastConnectError` 保留最近一次原因与时间 |
| `[uplink] connect failed reason=timeout` 反复出现 | 20 s 内未完成 WS 打开 + auth 握手（TLS 卡住、hub 无响应、无 `auth.challenge`） | 确认 `TMEX_HUB_URL` 可达、反代支持 WebSocket、证书有效。必要时把 `UPLINK_CONNECT_TIMEOUT_MS` 调大后重启 |
| WS 关闭码 **4401** | 无 `node-session`、会话过期或 logout。`/ws`、`/n/:id/ws`、`/mesh/ws` 升级后以此码关闭；`/mesh/ws` 每 5 分钟复验失败同样 4401 | 本机入口：跳 `/login?next=`。其它 node：不跳全局登录，侧边栏「登录此节点」（内存里还有 `sk_sess` 则静默补登）。前端对 4401 **停止重连**，避免 open→close 循环 |
| HTTP 401 `NODE_LOGIN_REQUIRED` | 目标 node 未登录或票的 `via` 不是当前 entry | 只在该 node 行登录，不要当整站掉登录 |
| HTTP 503 `NODE_UNREACHABLE` | entry 到目标的 peer link 与 hub relay 都失败 | 查目标是否在线、防火墙是否放行 `TMEX_PEER_PORT`、hub uplink、`TMEX_HUB_URL`。hub 离线时确认 `peer_cache` 地址是否仍达 |
| HTTP 409 `node_exists` | 该 nodeId 已登记，但公钥与本次 join 不一致（身份冲突） | 同一身份重 join（半途失败后再 enroll）不应再出现此错误。确认本机 `node_identity` 是否被换钥；换钥须先 `revoke-node` 再 enroll 新身份。不要用 `hub user reset` 清半途失败的 registry 行 |
| HTTP 409 `node_revoked` / join 提示 `this node identity was revoked` | 该 nodeId 的证书已被 `revoke-node`，同一身份不能再加入 | 换新身份：`mesh reset` 或重新 `init` 后再 enroll。不能靠新 token 解吊销 |
| enroll 打印 `already admitted` | 该 nodeId 已在 keylog 中 admit，二次 enroll 被跳过 | 预期行为。不应再出现 `node admitted`。若 uplink 仍 `auth_rejected`，对照 hub 的 `[hub][uplink] auth rejected` |
| enroll `admit-node failed: node_id_reused`（或其它 keylog 错误） | 试图再 admit 一个已占用的 nodeId，或记录未通过 keylog | 不要把失败当成已 admit。同一身份重 join 应走 `already admitted`；换钥须新 nodeId |
| HTTP 409 `KEY_LOG_FORK` | 同一 `seq/prev_hash` 出现两个不同后继，硬失败，hub 不选胜 | 不要强行重放。核对是否两条入口同时改密 / admit。无法收敛则走灾难恢复 |
| HTTP 504 `HUB_TIMEOUT` | `keylog?hub=sync` 等 hub ACK 超时，且对不上已提交记录 | 本地不落库；Nodes 页保留 pending，点「重试」。hub 恢复后再试 |
| 503 `DIRECT_UNAVAILABLE` | native 未装载、authorize 登记满（64）或 RTC 不可用 | `direct enable`；看 `TMEX_NATIVE_DIR` 与 `native/manifest.json`；装不了的平台接受 relay |
| 直连降级到 relay | ICE 失败、一端 `direct_capable=false`、或 `direct disable`、或 DC 存活超时 | 预期行为。功能应仍可用，徽标变为 `relay` / `turn`。UDP 被丢后 `transport` 应在约 10 s 内离开 `dc`（日志 `liveness timeout`）；若仍卡 ~35 s 才变，说明存活探测未生效 |
| 两边 `direct_capable=true` 但 `transport` 不是 `dc` | 只走了 hub relay / LAN WS，或升级尚未完成 | 日志前缀 `[mesh][rtc]`。应先有 `dial start role=offerer\|answerer`，较大 id 侧有 `kind=wake`，随后 `signal send/recv kind=sdp`。没有 `dial start` 说明没人拨号；只有 answerer 没有 wake/offer 是旧 bug。`ice failed … local_types=[host] remote_types=[…]` 且无 `srflx` → STUN 不可达；两边都有 `srflx` 仍失败 → 对称 NAT，需要 `TMEX_TURN_*`。`datachannel open` 才算 DC 握手成功。不要把完整 SDP / ICE 密码打进日志 |
| 终端数秒停顿、日志有 `[mesh][stream] failover` | Forwarder 在重建 mux stream 并 replay | 行首 ISO 时间戳可对齐。`failover_start` 的 `cause=stream_close\|send_failed`、`close_reason`、`from`、`queued_input_bytes` 区分 RST/发送失败；`failover_attempt` 的 `getLink_ms` / `open_stream_ms` / `hello_wait_ms` / `resume_wait_ms` 区分建链慢还是 HELLO/snapshot 等待；`failover_summary` 的 `duration_ms`、`replay_bytes`、`event_loop_lag_ms` 给出总耗时。`[ws] backpressure enter\|skip\|drain` 与 `terminate reason=backpressure_gap` 带 `carrier=physical_browser_ws\|mesh_link_stream` 以及 session/cid/node，用来判断背压在浏览器 socket 还是 mesh carrier。`[mesh][mux] rst send/recv` 现含 `muxStreamId` 与 `nodeId`/`transport`。`[ws-metrics] gateway_activity` 的 `event_loop_lag_ms` / `max_lag_ms` 判断主线程是否卡住 |
| `[mesh][rtc] dial failed` 刷屏、hub 入站 UDP 被滤 | 对 `direct_capable≠false` 的 peer 会反复拨 DC | 连续 8 次 DataChannel 失败后打一条 `[mesh][rtc] breaker open peer=… fails=8 until=…`，6 h 内跳过该 peer 的 DC（可用 `TMEX_RTC_DIAL_BREAKER_MS` 调整）。`dial failed` 同一 peer 60 s 至多一条并带 `count=`。成功或对端 endpoints/`direct_capable` 变化会复位。不改 transport 优先级，也不改 `directCapable !== false` 门闩 |
| `PROTOCOL_MISMATCH` | `/api/auth/mode` 缺 `rootEpoch` / `rootPublicKey` 等 mesh 必填字段 | 服务角色不是 mesh，或旧进程未起来 |
| join 失败 `https` / `--insecure-local` | 非 HTTPS，或 production 用了 insecure | 换成系统信任链下的 HTTPS |
| join `key log rejected` / `epoch_changed` | 签发 token 之后发生了 `rotate-root` / `rotate-root-keep` / `reset-root` | 重新 enroll |
| enroll 一直「待确认」 | 证书未到本会话，或 passkey 路径需手动确认，或 hubAck 未到 | 等 join 完成再点确认；查 hub 是否在线；根钥路径才自动 admit |
| 登录页没有 passkey | `passkeyAvailable=false` 或本 origin 无凭证 | 用域名 HTTPS（加 `TMEX_TRUST_PROXY`）；先在本入口注册 |
| TOTP 登录 `TOTP_INVALID` | epoch 与派生盐不一致，或验证码过期 | 确认用的是当前 epoch 的密码；日常改密会重封装 TOTP，无需重设；破坏性 `rotate-root` 后须重设 |
| HTTP 409 `HUB_NOT_WRITER` | 打到了 standby hub 的写接口（enroll / redeem / rename / revoke） | 改打 body 里的 `writerPublicUrl`。要把这台变成写者，先让原主 `tmex hub demote`，再 `tmex hub promote --yes`。见 [多 hub 主/备](./2026090104-multi-hub-standby.md) |
| 两台 hub 同时 `mode=active` | epoch 围栏未生效或旧主恢复时没先 demote | 立即把其中一台 `demote` 或停机。日志会有 `split-brain` 或 `fenced: higher writerEpoch`。切回顺序见 [多 hub 主/备](./2026090104-multi-hub-standby.md) |

限速：每个 node 对同一 `uid` 或 IP 每分钟 10 次登录，超出 429。转发登录的限速桶目前是 `peer:<entryNodeId>`，不是浏览器真实 IP。

## 安全边界摘要

完整表格见设计文档 [§5 安全边界](./2026082700-hub-node-architecture.md)，此处不复制。运维上只需记住：

- **失陷一台未在其上登录的 node 或 hub 机，不能换取其它机器的用户级访问。** hub 签不出凭证，未 admit 的节点被忽略；relay 只搬密文；掉包公钥 / 篡改 DTLS 信令会被登录签名与指纹绑定挡住。
- **正在使用的 entry** 在 `node-session` 窗口内（18 小时滑动、7 天封顶）是流量代理，这是 web 架构固有信任点。密码登录会在该入口露出密码；passkey 登录只泄露该窗口（临时钥不能签持久记录）。
- TOTP 不防「已拿到某 node 库 + 离线爆破弱口令」。口令强度与 argon2id 成本是底线；独立第二因素用 passkey。
- 目标 node 经 entry 转发的响应有 CSP sandbox 与 MIME allowlist，失陷 node 不能在 entry origin 跑脚本。

## 已知限制（v1）

1. hub 离线时只用缓存地址，无 mDNS / 签名 UDP 信标；对端换 IP 须等 hub。
2. 直连不支持 musl、Windows。
3. passkey 不能在纯 IP 入口使用。
4. 文件直连 `bulk` 失败即整次改走 REST 重传。
5. IPv6 ICE 候选未做现场实测。
6. `TMEX_TRUST_PROXY` / `TMEX_TURN_*` / `TMEX_PEER_BIND_HOST` 不会被 `init` 写入，必须手改 `app.env`。
7. TURN 只支持 UDP：node 侧 ICE 由 node-datachannel（libjuice）实现，`turn:…?transport=tcp` / `turns:` 不会产生 relay 候选（2026-08-28 实测，两端均无 relay 候选）。hub 机若被上游过滤入站 UDP（部分 VPS 默认如此，`tcpdump` 在网卡上看不到任何 UDP），则 node↔hub 机的直连与 TURN 兜底都不可用，只能走 relay；需换有 UDP 入站的机器部署 TURN。
8. 对称 NAT（同一 socket 对不同目标映射出不同端口，如 Docker Desktop 出口）之间无法打洞，必须 TURN；macOS 上 TUN 模式代理会吞掉 UDP，做直连验证时要给 hub/TURN 的 IP 加主机路由绕过（`sudo route -n add -host <ip> <网关>`）。

## 参考

- [架构设计 v3.2](./2026082700-hub-node-architecture.md)
- [多 hub 主/备（第一阶段）](./2026090104-multi-hub-standby.md)
- [部署指南（安装 / 服务 / SSH 设备）](../2026021000-tmex-bootstrap/deployment.md)
- [自更新](../update/2026061406-self-update.md)
- [服务进程与 tmux 存活](../service/2026061400-process-survival.md)
- [库与 MASTER_KEY 不匹配](../operations/2026021200-db-key-mismatch-journald.md)
