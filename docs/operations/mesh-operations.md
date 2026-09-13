# VibeTerm hub / node 运维指南

本文是多节点互联（mesh）的安装与日常运维手册：角色矩阵、环境变量、首次搭 hub、加入 / 吊销、Nodes 页、账号安全、直连、反代、hub 离线、灾难恢复与常见排障；面向把单机 VibeTerm 扩成「一台公网入口 + 多台 NAT 后设备」的运维。架构与威胁模型见 [多节点架构](../architecture/mesh-architecture.md)。本文只描述已落地行为。

鉴权已从 JWT / 管理员密码 / OIDC 改为**用户自持根钥（密码派生 Ed25519）+ 可选 passkey / TOTP**。存量 `standalone` 安装升级后仍无登录页、旧路由可用。

## 部署矩阵

`VIBETERM_ROLES` 只能是下列五者之一，非法值启动失败。没有纯 `hub` 角色：hub 总是与本机 node 同进程。
`hub` 与 `relay` **不能同机**（`VIBETERM_ROLES is invalid: relay cannot be combined with hub`）。

| 角色 | 典型用途 | 启动时构造 | 登录 | 直连 addon |
|---|---|---|---|---|
| `standalone`（默认） | 单机，未加入 mesh | 仅 `GatewayRuntime` | 无（`GET /api/auth/mode` → `{mode:'none'}`） | `init` 默认安装并启用 |
| `node` | 已加入 hub 或中继的设备 | Gateway + Mesh（真实 WSS uplink） | 有，`localUiGuard` | `init` 默认安装并启用 |
| `hub,node` | 公网入口兼本机设备 | Hub + Gateway + Mesh（进程内 uplink） | 同上 | 同上 |
| `relay` | 只给别人转发的公共中继 | Relay + Gateway（无 mesh、无用户、无前端） | 无（管理走 `VIBETERM_RELAY_ADMIN_TOKEN`） | 同上 |
| `relay,node` | 公共中继兼本机设备 | Relay + Gateway + Mesh | 有，管理面另接受本机会话 | 同 `node` |

所有角色初始化都默认安装并启用直连插件，下载最多等待 60 秒；离线、不支持的平台或下载失败均不阻断初始化。CLI 加入 hub／relay 时会补装缺失插件，已安装则跳过；Web setup 省略 `directEnable` 时默认启用，显式 `false` 可跳过。存量安装从未安装插件时，升级不要求补装。

事后管理：设置 → 节点管理 → 某节点「更多」的详情框里有一枚两态按钮——未安装时「安装直连插件」（安装即启用），已安装时「删除直连插件」（需确认）。状态取自 `GET /api/local/status`，动作走 `POST /api/local/direct`，远端节点经入口的 `/n/<id>/api/local/*` 转发到目标节点（需已登录该节点；peer 入站不享受 standalone 免密）。两种动作都要重启目标网关才生效，详情框提供「立即重启」（`POST /api/settings/restart`）并轮询 `/api/local/status` 直到目标恢复。本机卡片上的安装 / 启用 / 停用 / 删除四个控件不变。

中继角色详见 [公共中继（relay）角色](../architecture/relay.md)。

请求顺序（mesh 角色）：`HubRuntime`（`/api/hub/*`、`/hub/uplink`）→ mesh 本地守卫 → mesh（`/api/auth/*`、`/api/mesh/*`、`/mesh/ws`、`/n/:id/*`）→ gateway → 前端 SPA（覆盖 `/login`、`/nodes`、`/n/:id/...`）。standalone 不构造 mesh，只挂轻量 `GET /api/auth/mode`。

关停（仅 mesh 角色装 SIGINT/SIGTERM）：peer links → uplink → hub → gateway，预算 20 s。standalone 不装信号处理器。

同一 mesh 需要第二台公网入口时，把已加入的 node 配成 **standby hub**（`hub,node` + `VIBETERM_HUB_MODE=standby`），由人工 `promote` / `demote` 切换写者。第一阶段是主/备、单写者、有序 failover，不是自动选主。操作、围栏与切回顺序见 [多 hub 主/备](./multi-hub-standby.md)。

生产 HTTP 默认绑定 `127.0.0.1:9883`（`init` 写入 `VIBETERM_BIND_HOST` / `GATEWAY_PORT`）。peer 口与 HTTP 口分离。

## 环境变量

生产变量来自安装目录 `app.env`（`init` 写入，`upgrade` **只追加缺失键**，不覆盖已有值）以及 `run.sh` 导出的路径键。改完需重启服务。开发 / 测试三套环境见 [三套环境](../development/environments.md)，与生产安装无关。

### `init` / `upgrade` 会写入的键

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIBETERM_ROLES` | `standalone` | 见上表 |
| `VIBETERM_HUB_URL` | 空 | node 连 hub 的基址（`hub join` 成功后写入）。`hub,node` 用进程内 uplink，可不填 |
| `VIBETERM_HUB_PUBLIC_URL` | 空 | hub 对外 HTTPS 地址，写入 join 命令与 `/api/auth/mode.hubPublicUrl`。非交互 `init --role hub,node` **必填** `--hub-public-url` |
| `VIBETERM_PEER_PORT` | `39001` | node↔node 信令监听口，只承载签名信令 |
| `VIBETERM_STUN_SERVERS` | **不写入** | 只有 `init --stun-servers <list>` 显式给出才写入。未设置 = 用随发行版分发的内置列表，见下节 |
| `VIBETERM_RELAY_PUBLIC_URL` | 空 | **仅 relay 角色写入**，且必填。中继对外地址，uplink 认证签名绑定其 host |
| `VIBETERM_RELAY_ADMIN_TOKEN` | 首启生成 | **仅 relay 角色写入**。管理令牌；缺失时首启生成一枚并写回 `app.env`，库里只存 sha256 |

`init` 另支持 `--hub-url`、`--hub-public-url`、`--peer-port`、`--stun-servers`、`--relay-public-url`。

### STUN 列表：内置随版分发

2.2.0 起 STUN 列表**不再冻进 `app.env`**。内置列表写在发行版代码里（`packages/shared/src/net/stun-defaults.ts` 的 `BUILTIN_STUN_SERVERS`：`stun:stun.miwifi.com:3478`、`stun:stun.chat.bilibili.com:3478`、`stun:stun.l.google.com:19302`、`stun:stun.cloudflare.com:3478`），升级即换新列表，不需要人工改 env。

单机 env 语义（`parseStunServersEnv`）：

| `VIBETERM_STUN_SERVERS` | 来源 | 生效列表 |
|---|---|---|
| 未设置 / 空白 | `builtin` | 内置列表 |
| `none` 或 `off`（忽略大小写） | `disabled` | 空（本节点不用 STUN） |
| 其它逗号串 | `custom` | 按逗号切开、去空白去重 |

整个 mesh 的有效列表按优先级求解（`resolveEffectiveStun`）：**节点自定义 > 节点禁用 > hub/中继下发的自定义列表 > 内置列表**。hub / 中继**只在自己是 `custom` 时**才经 `node.list` / `relay.list` 下发列表，否则下发空数组；空数组表示「我没有自定义」，节点回到自己的内置列表，不会被清空。TURN 与之相反：hub / 中继一旦下发过配置就以它为准，节点不再回落到本机 `VIBETERM_TURN_*`。多中继时**撤回按台计**：
某台下发 `turn: null` 或掉线只撤回它那一条，其余中继的条目仍在；节点把各台的条目合成数组，逐条探测后最多取两条进 ICE
（见下面「中继内置 TURN 与多中继」）。

生效列表还会按 STUN 探针结果排序：新鲜且可达的按 RTT 提前，失败只降权不删除（探针口径见 [隧道边缘与 STUN 的 fake-IP 绕行](./tunnel-edge-fake-ip.md#stun-自检)）。

排查用：

- `GET /api/mesh/rtc-config` 回包带 `source`（`node-custom` / `node-disabled` / `hub-custom` / `builtin`），`stun` 是排序后的生效列表。
- 启动与 `node.list` 变化时打日志 `[mesh][rtc] stun config source=… count=… list=…`。
- 安装版 `vibeterm doctor` 会报「使用发行版内置列表 / 自定义（app.env）/ 已禁用」。
- 升级：`vibeterm upgrade` 在升级事务内识别 `VIBETERM_STUN_SERVERS`（含遗留 `TMEX_STUN_SERVERS`）是否等于**历史内置默认串**，是则删除该键让新内置列表生效；自定义值原样保留。详见 [升级事务](./upgrade-transaction.md)。

### 需手写或由 upgrade 补齐的键

下列键运行时会读。**`init` 按角色写入** `VIBETERM_RTC_PORT_RANGE`（中继主机 `40050-40099`，其余 `40000-40099`）；中继角色另写 `VIBETERM_TURN_PORT=40000` 与 `VIBETERM_TURN_RELAY_PORT_RANGE=40001-40049`。跨版本 `upgrade` 在 backup 阶段：空值或恰好等于旧默认才改写（RTC 空 → 角色缺省；中继上 RTC `40000-40099` → `40050-40099`；TURN 空 / `3478` → `40000`，空 / `49160-49259` → `40001-40049`）。`0` / `off` / 其它自定义值不动。详情见 [升级事务](./upgrade-transaction.md)。

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIBETERM_PEER_BIND_HOST` | 未设 | peer 口绑定。空 / 未设 → dual-stack `::` 与 `0.0.0.0`。不进 `config.ts`，mesh 直接读 env |
| `VIBETERM_TURN_URL` / `VIBETERM_TURN_USERNAME` / `VIBETERM_TURN_CREDENTIAL` | 空 | **外部** TURN，三者齐全才下发。hub 角色只有这一种；中继角色配了它就不启动内置 TURN。节点侧只用 UDP（`turns:` / `?transport=tcp` 不产生候选） |
| `VIBETERM_TURN_PORT` | `40000` | **仅中继角色**：内置 TURN 的控制口（UDP），同口也应答 STUN Binding。`0` / `off` 关闭。旧默认 `3478` |
| `VIBETERM_TURN_RELAY_PORT_RANGE` | `40001-40049` | **仅中继角色**：内置 TURN 的中继端口段，每个 allocation 占一个 UDP 端口。旧默认 `49160-49259` |
| `VIBETERM_TURN_EXTERNAL_IP` | 未设 | **仅中继角色**：写进 `XOR-RELAYED-ADDRESS` 的公网 IPv4；未设时自动解析（DNS + STUN 自检） |
| `VIBETERM_TURN_HOST` | 未设 | **仅中继角色**：广告出去的 host；未设时广告解析到的公网 IPv4 字面量 |
| `VIBETERM_TURN_BIND_HOST` | `auto` | **仅中继角色**：控制口与分配口绑定的本机地址。`auto` = 主出站 IPv4；也可写 IPv4 或 `0.0.0.0`（TUN 宿主上通配会吞 Binding 回包，见 [KI-4](../known-issues.md)） |
| `VIBETERM_TRUST_PROXY` | `false` | 仅 **本机 Bun socket（via=self）** 信任 `X-Forwarded-Proto` / `X-Forwarded-Host`，用于公网 origin、`Secure` cookie、passkey 可用性。转发请求永不信任。Cloudflare Tunnel 等反代场景必须设 `true` |
| `VIBETERM_HUB_MODE` | `active`（hub 角色启用时） | hub 角色：`active` 或 `standby`。其它值启动失败 |
| `VIBETERM_HUB_PRIORITY` | active `100` / standby `200` | 同 mode 下越小越优先，整数 ≥ 0 |
| `VIBETERM_HUB_WRITER_EPOCH` | `1` | writer 世代，整数 ≥ 1，单调递增 |
| `VIBETERM_HUB_URLS` | 空 | 逗号分隔的备用 hub 基址，接在 `VIBETERM_HUB_URL` 之后去重 |
| `VIBETERM_HUB_PEERS` | 空 | 逗号分隔的 32-hex 节点 id：本 hub 授权的**其他** hub。未列入的节点广告不会进入 `mesh_hubs`、不能 fencing、也不能当 writer |
| `VIBETERM_NATIVE_DIR` | `run.sh` 导出 `<installDir>/native` | native addon 目录。未设则 loader 返回 `null`，`direct_capable=false`。不要指向本机生产安装目录去做开发验证 |
| `RTC_LIVENESS_INTERVAL_MS` | `3000` | node↔node DataChannel 空闲时发 ping 的间隔。通道上有入站流量则重置，不给忙通道加 ping |
| `RTC_LIVENESS_TIMEOUT_MS` | `10000` | 连续无任何入站（含 ping/pong 与业务帧）超过此时长则判定直连死亡，关闭 DC/PC 并回落 relay。须大于 `RTC_LIVENESS_INTERVAL_MS` |
| `VIBETERM_RTC_PORT_RANGE` | 非中继 `40000-40099`；中继主机 `40050-40099`（`init` / upgrade 写入；未设时 ICE 走临时口） | `begin-end`，限制 WebRTC 的 UDP 端口范围。格式非法或越界启动失败。自定义段原样保留 |
| `VIBETERM_WS_DIAL_RACE` | `2`（夹紧 1..4） | 公网 WebSocket 开链竞速条数：peer ws-secure / hub / 中继上行同时开 N 条，取最先 `open` 的一条。`1` = 关闭。回环 / RFC1918 / 链路本地恒为 1。import 时读一次，改完需重启。见 [路径优选](../architecture/path-selection.md) |
| `VIBETERM_DC_REROLL` | 开（任意非 `off`） | `off` 关闭直连慢路径重掷（DC 与 ws-secure），且本端不报 `reroll` 能力位。采样不受影响 |
| `VIBETERM_UPLINK_PATH_SAMPLING` | 开（任意非 `off`） | `off` 关闭中继 / hub 上行的周期 TCP 采样与 `path-rerace` 劣化重连 |
| `VIBETERM_EVENT_LOOP_LAG_WARN_MS` | `250` | event loop 采样滞后超过该值时打告警（10 s 至多一条） |
| `VIBETERM_RTC_DIAL_BREAKER_MS` | `30000`（30 s） | DataChannel 熔断的**起始**冷却。连续 3 次失败（含拨号失败与通道打开后异常关闭 / liveness timeout / missed pong）后跳过 DC dial，冷却按 30 s → 60 s → 120 s … 指数递增，上限 30 min；`cooldownLevel` 在冷却过期后仍保留。通道保持健康 ≥ 60 s 才复位。本变量覆盖起始冷却，不改失败次数与上限。ws-secure / relay 不受影响 |
| `VIBETERM_PEER_DIRECT_DIAL_CONCURRENCY` | `4` | 进程内同时进行的直连 endpoint 拨号数上限（整数 ≥ 1）。LAN 候选另有 4 s 总预算，失败地址按 1 min → 6 h 退避，见 [节点直连](../architecture/peer-direct-connect.md) |

相关但非 mesh 专有：`VIBETERM_MASTER_KEY`（加密落库的节点私钥等，生产必填）、`VIBETERM_BIND_HOST`、`GATEWAY_PORT`、`DATABASE_URL`。

## 首次搭 hub

推荐路径：一台有公网 HTTPS 的机器做 `hub,node`，内网机器 `init` 后 `hub join`。包与升级流程与单机相同（`bash install.sh` / `vibeterm upgrade`）。

安装目录默认：macOS `~/Library/Application Support/vibeterm/`，Linux `~/.local/share/vibeterm/`；改名前（1.1.x）装在 `.../tmex/` 的实例升到 2.0.0 时由升级器整体搬到新路径（库、`app.env` 键、服务 label 一并迁移，见 [改名迁移](./rename-migration.md)），自定义 `--install-dir` 的安装不搬。服务名取自 `install-meta.json`，默认 `vibeterm`（launchd label `com.vibeterm.vibeterm`，systemd `vibeterm.service`）。**不要**手改正在跑的生产安装目录里的库或 `app.env` 做试验。

### 1. 在入口机安装并指定角色

```bash
bash install.sh --role hub,node
```

交互模式会询问 `VIBETERM_HUB_PUBLIC_URL`（浏览器与 `hub join` 使用的 HTTPS 基址，例如 `https://vibeterm.example.com`）。非交互：

```bash
bash install.sh --role hub,node --no-interactive \
  --install-dir "$HOME/Library/Application Support/vibeterm" \
  --host 127.0.0.1 --port 9883 \
  --db-path "$HOME/Library/Application Support/vibeterm/data/vibeterm.db" \
  --autostart true \
  --hub-public-url https://vibeterm.example.com
```

`init --role node|hub,node` 结束时默认执行 `direct enable`（下载当前平台 `.node`）；失败只打日志，不阻断安装。随后 `direct_capable=false`，数据面走 hub relay。

### 2. 创建首个用户

在 **hub 机本机**（服务已起来，命令走安装版 Bun 的 `runtime/cli-auth.js`）：

```bash
vibeterm hub user add <username>
```

TTY 隐藏输入密码并二次确认；非 TTY 用 `VIBETERM_PASSWORD`。密码经 NFKC 后再做 argon2id。成功后：

- 写入 `users`，生成本机节点证书并自签 `admit-node`（hub 机无需 `hub join`）；
- 打印根公钥指纹（sha256 hex）；
- 已有同名用户会拒绝，替换根钥请走 `mesh reset-root`，不要重复 `add`。

### 3. 签发 enrollment

任选其一。token 默认 10 分钟有效（`--ttl 10m`，如 `30s` / `5m` / `1h`）。

**CLI（任意已加入的 node，含 hub 机）：**

```bash
vibeterm enroll [--ttl 10m]
```

输入密码（若该用户已启用 TOTP，再输入 `VIBETERM_TOTP` 或交互验证码）。打印 join 串与完整 `hub join` 命令，然后等待对端 redeem：

- hub 角色：轮询本机 `enrollment_tokens` 里 redeem 回写的证书，到则自动签 `admit-node`；
- 非 hub：登录 hub 后轮询 `GET /api/hub/nodes` 的 `certificate` / `cert_sig`；
- Ctrl-C（SIGINT）结束等待，提示到 Nodes 页确认。

**UI：** 任意已登录入口打开 `/nodes` → 新增节点（密码或本 origin 的 passkey）→ 复制 join 命令。`enroll_sk` 只在内存，刷新后不再展示 join 串；pending 元数据在标签页 `sessionStorage`（不含私钥）。

join 串有两个版本：

- **v1**：`base64url(enroll_sk ‖ root_public_key ‖ key_log_head_hash)`，恰好 128 字符。
- **v2**（hub 为 self-signed HTTPS 时）：`<v1>.<64 位小写 hex>`，hex 是该 hub CA 的 SPKI SHA-256。加入端用它 pin 住 `GET /api/tls/ca.crt` 拉到的 PEM，写入本机 `hub_trust`（按 hub URL 一行）；之后对该 URL 的 hub-client HTTP 与 uplink WebSocket 都带 `tls.ca`。无 fingerprint 的旧串仍可 join，行为与 v1 相同。
- **CA 轮换**：未过期 CA 不自动轮换；不足 30 天时日志提示剩余天数和手动命令，已过期才允许自动重建。手动轮换及逐节点更新信任见下节。

**`enroll_sk` 不经过 hub。** CA pin 只约束那一台 hub 的 URL，换 hub 要重新 enroll / join。

### CA 指纹与信任恢复

在 Hub 的本机终端执行 `vibeterm hub ca fingerprint`，输出 `SHA256 SPKI <64 位小写 hex>`。这是 CA 公钥指纹，与 v2 join 串一致，不是整张证书的 SHA-256。
未配置 CA 时只输出一行 `no CA configured`，退出码为 0，与 `hub urls list` 的空列表查询一致。

计划轮换前须确保每台成员都保留本机终端或独立 SSH 入口。执行：

```bash
vibeterm hub ca rotate
```

命令先提示全网断连风险，交互终端须输入完整 `yes`；非交互须加 `--yes`。轮换后重启 Hub，再通过可信渠道把新指纹交给各节点。在各节点执行：

```bash
vibeterm hub trust refresh https://hub.example --fingerprint <64-hex>
```

命令先核对 Hub 提供的 CA 指纹，再用该 CA 校验真实 HTTPS 连接及主机名；全部通过才更新该 URL 的 `hub_trust`。之后重启节点。无需更换用户根钥或重新 enroll。校验失败保留旧 pin；不要从未核实的错误页面复制指纹。

已存 pin 与广告指纹不同时保留原信任，`GET /api/mesh/hubs` 的候选响应保留 `lastError: "hub_ca_changed"` 和 `caMismatch: { advertised, pinned }`。尚未收到新广告的离线节点可能只显示 TLS 握手失败，同样按上述命令恢复。

### Hub 地址迁移

在每台节点预置备用种子并重启：

```bash
vibeterm hub urls list
vibeterm hub urls add https://new-hub.example
vibeterm hub urls remove https://old-hub.example
```

这些命令只维护 `app.env` 的 `VIBETERM_HUB_URLS`，不会删除单值 `VIBETERM_HUB_URL` 或缓存的 `mesh_hubs`。Hub 改 `VIBETERM_HUB_PUBLIC_URL` 前先让新旧地址同时可用；全部成员（含原离线成员）验证能从新地址接入后才下线旧地址。成员一直离线就无法从 `node.list` 学到新地址，须在该机本地添加种子或重新 `hub join`。当前设置 API 没有更新 Hub public URL 的保存入口；安装配置及 `hub standby --public-url` 仍需运维按此顺序迁移。详见 [多 hub 主/备](./multi-hub-standby.md)。

### 4. 各机加入

在每台要加入的机器上（可先 `init --role standalone` 或 `--role node`）：

```bash
vibeterm hub join https://vibeterm.example.com --token <join 串> [--name 书房]
```

约束：

- 只接受 `https:`；HTTP 重定向一律拒绝（`redirect: 'error'`）；
- `http://127.0.0.1` / `http://localhost` 仅非 production 且加 `--insecure-local`；
- 以 join 串里的根公钥与 `key_log_head_hash` 为锚点校验全链，再原子写入 users / 日志 / 证书 / `node_identity`（v2 串还会把 CA PEM 写入 `hub_trust`），然后写 `VIBETERM_HUB_URL`、`VIBETERM_ROLES=node`（已是 `hub,node` 则保留）并重启服务；指纹对不上则 `join_failed: ca_fingerprint_mismatch`，不落库；
- 本机若已有同名用户但 uid / 根钥不同（hub 重建或对端 `reset-root` 后再 join），校验通过后原子替换该用户的本地状态：删旧 `user_key_log`、`user_keys`、`node_sessions`、旧根签发的 `node_certs`、旧 hub 的 `peer_cache` / `nodes`，再写入新用户。本机 nodeId 密钥对保留。同一 uid 再次 join 为幂等 upsert，不会重复行；
- 同一 nodeId + 同一节点公钥再次 `hub join`（新 enrollment token，同一 hub epoch）是幂等的：redeem 消耗新 token，但**不签发新的节点证书**，响应里的 `node_certs` 仍是已 admit 的那张（`already_admitted: true`）。enroll 侧发现该 `node_id` 已在 keylog 中则跳过第二次 `admit-node`，打印 `already admitted`（不是 `node admitted`）。uplink 继续用原证书。`node_exists`（HTTP 409）只在该 nodeId 已被**另一把公钥**占用时出现。不必 `hub user reset` 清掉半途失败留下的 registry 行；
- 已吊销节点用**同一身份**再 join：redeem 返回 HTTP 409 `node_revoked`，`hub join` 失败并提示 `this node identity was revoked; use a fresh identity (mesh reset / re-init)`。不能靠再 admit 解吊销。换钥重装须先 `revoke-node` 再 enroll **新身份**（新 nodeId / 新密钥，或 `mesh reset` / 重新 `init`）；
- 不必先 `hub leave`：从角色 `node` 直接 join 另一台 hub 即可，`leave` 只清角色与 `VIBETERM_HUB_URL`；
- 成功后提示在内网防火墙放行 `VIBETERM_PEER_PORT`（仅内网直连需要）。替换了旧账号时会打印一条明确日志。

加入后各入口侧边栏自动出现新 node，无需手动添加设备。退出 mesh：`vibeterm hub leave`（清 `hub_url`，角色改回 `standalone`，重启）。

## Nodes 页

路由 `/nodes`，任意已登录的 mesh 入口可用。standalone 整页不渲染。

表格：在线 / 离线（旁可挂「已暂停」标，不替换在线态）、到达路径、版本、直连能力、登录状态、公钥指纹（sha256 前 16 hex）。行内「更多」是下拉菜单（详情、暂停 / 恢复）；吊销仍是行上的破坏性按钮。待批准行「更多」禁用。self 行不能吊销当前入口。paused 是 **entry 本机偏好**：行留在管理表，侧栏 / 设备页 / 传输下拉过滤；行内升级仍可点，批量升级排除，批量移除/卸载可选。

暂停资格（行菜单与批量「暂停」同一套）：本机、Hub、当前 URL 为 `/n/:id/…` 的转发节点不可新暂停。恢复只拦本机与待批准；Hub 与当前转发节点若已暂停则可恢复（2.3.5 上被暂停的 Hub 升级后可点恢复）。批量菜单把暂停 / 恢复放在升级 / 吊销 / 卸载之前；合格集合为空则禁用。同一节点在途的暂停/恢复互斥（行与批量共享守卫）。`ports[].status === 'blocked'` 时名字下警告「端口不可达」；详情框有完整端口表与「重新检测」（`POST /api/mesh/nodes/:id/ports/probe`）。

本机卡网络区入站端口标题随本机角色：含 `relay`（`relay` / `relay,node`）→「中继需开通端口」；`hub,node` →「Hub 需开通端口」；其余（`node` / `standalone` / 缺省）→「本机需开通端口」。节点详情框仍用「入站端口」。标题下一行图例：「绿 = 其它节点已探通；红 = 探测到未放行；灰 = 尚未验证」。有 `MeshPortReach` 行（purpose + 端口/range 对上）才画状态点：`open` 绿、`blocked` 红且加 ring、`unknown` 灰；无对应行画「—」（不探测），不等于灰。能解析到 self id（`mode.nodeId` 或 mesh `entryNodeId`）时本机卡显示「重新检测」，打 `POST /api/mesh/nodes/<self>/ports/probe`；standalone / 无 self 不画该按钮。灯表示「别人探本机 advertised peer endpoint」，不是安全组扫描。

`GET /api/mesh/nodes` 除兼容字段 `reach`（`lan` / `relay` / `null`，`lan` 不区分 WS 与 DataChannel）外还有 `transport`：`ws-secure` | `relay` | `dc` | `null`。要确认跨 NAT 直连是否真的建起来，看对端 `transport === "dc"`，不要只看 `reach=lan` 或 `direct_capable=true`（后者只表示允许尝试 DC）。

node↔node WebRTC 由 **nodeId 字典序较小的一侧发 offer**。业务请求只发生在较大 id 一侧时，该侧会经已认证的 hub `rtc.signal` 通道发一条签名 wake（`sdp` 内 `type=rtc.wake`，对 `{domain:vibeterm-rtc-wake, from, to, rtcSession, nonce, issued_at}` 用发送方节点 Ed25519 私钥签名）唤醒较小 id 去 `getLink`；hub 只转发、不解释、不验签。接收端用 `node_certs` 验签，拒绝坏签名、时钟偏差 > 60s、重放 nonce，以及自己并非该对 offerer 的 wake；每对端有接收冷却。发送侧 5s 冷却若挡住了仍需要的 wake，会在 `nextEligibleAt` 补发（DC 到达或本次拨号结束则取消）。已是 `dc` 的忽略。`node.list` / 对端 `direct_capable` 翻成 true 时两边都会 `maybeUpgrade()`。已打开的 node↔node stream 留在旧链路上，**不会**随 carrier-switch 迁到 DC（carrier-switch 只服务浏览器 `sess`）；新 stream 在 `waitForTransport(id, 'dc')` 成功后再开才会走 DC。

| 动作 | 行为 |
|---|---|
| 新增节点 | 凭据对话框（密码或本 origin 的 passkey）签 enrollment 授权，POST hub；展示 join 命令。签名者进入 5 分钟复用窗口 |
| 自动 admit | 对端 `hub join` redeem 后，`/mesh/ws` 推 `ENROLL_REDEEMED`（只给创建该 enrollment 的会话），并按 enrollment id 轮询 `GET /api/hub/enrollments/:id` 兜底。**仅根钥签名者**会在证书到达时后台自动签 `admit-node`；passkey 必须用户点「确认」（浏览器 user activation） |
| 待确认 / 重试 | 页面已关、窗口过期、或 `POST /api/auth/keylog?hub=sync` 未拿到 `hubAck:true` 时保留 pending。409 / 504 不当成成功 |
| 重命名 | hub 在线时可改 `nodes.name` |
| 暂停 / 恢复 | `POST /api/mesh/nodes/:id/pause|resume`，幂等；self → 400 `CANNOT_PAUSE_SELF`；Hub（`isHub`）仅暂停 → 400 `CANNOT_PAUSE_HUB`（恢复 200）。pause 退役对本端的出站链路，resume 不主动拨号。前端另拦当前 `/n/:id` 转发节点的暂停。CLI：`vibeterm nodes pause|resume`（`CANNOT_PAUSE_SELF` → `cannot pause this machine (CODE)`；`CANNOT_PAUSE_HUB` → `cannot pause a hub node (CODE)`） |
| 吊销 | 每次都要当场确认凭据（不进复用窗口），只走 `keylog?hub=sync` 写 `revoke-node`。hub 未确认则告警、不刷新列表 |

### 中继模式：「成员密钥未送达」

新节点加入中继 mesh 要两条记录：`admit-node`（成员资格）与紧随其后的 `meta-key {op:'admit'}`（把当前世代的
`K_meta` 封给它）。第二条没落账时的症状很好认：

- 节点在名单里是「已加入」，但**名称显示成 32 位 hex 的 node id**，版本恒为 `—`；
- 它自己的日志里反复打 `[relay] meta key epoch=N not addressed to this node; staying read-only`；
- 从网页给它改名会失败（版本门把「版本未知」当成旧节点）。

处理：设置 → 多节点互联 → 节点管理（或「接入更多设备」面板）会挂一条黄色告警条列出欠账节点，
点「补发成员密钥」，按提示输一次密码或用通行密钥即可；节点表里对应行带「成员密钥未送达」标记。
名单来自 `GET /api/mesh/relay/status` 的 `metaKeyLagging`，是服务端按当前 `meta-key` 记录的封装条目算的，
**换浏览器 / 换机器 / 手机 PWA 看到的都一样**，不依赖某个标签页的本地记账。

排查时在已登录的浏览器里打开 `/api/mesh/relay/status`，看 `metaKeyLagging` 数组。
补发之后它应变空，节点的名称与版本在下一拍 `relay.list` 里就会上报。

hub 不可达（`mode.hubNodeId` / `isHub` 学不到）：顶栏提示，新增 / 重命名 / 吊销禁用。非 hub 机在 `peer_cache` 学到 hub 元数据之前也是这种降级。

侧边栏：在线已登录懒建该 node 运行时；在线未登录只显示「登录此节点」，不建连接；离线灰显缓存的设备名。

## 远程卸载

入口「设置 → 多节点互联 → 节点管理」可对已登录的远程节点执行「卸载 VibeTerm」。入口不能卸载自己（`UNINSTALL_SELF_BLOCKED`）。

流程：

1. 入口 `POST /api/mesh/nodes/:id/uninstall` 要求本机会话、目标已在该入口登录（否则 `NODE_LOGIN_REQUIRED`）且 peer 可达（否则 `NODE_UNREACHABLE`），再经 peer link 转发 `POST /api/system/uninstall`，body 为 `{ mode: "full" }`。
2. 目标必须是 CLI 安装（`installedViaCli` 且 `deployment` 为 `launchd` / `systemd`）。容器、手动部署或 managed 构建返回 409 `UNINSTALL_NOT_ALLOWED`；正在升级返回 409 `UPGRADE_IN_PROGRESS`。旧版本没有该接口（404/405）→ 501 `UNINSTALL_UNSUPPORTED`。`GET /api/system/info` 的 `upgradeCapabilities` 含 `uninstall`，入口用来区分旧目标。
3. 目标把 `current/cli`（解析 `current` 符号链接到 `versions/<v>`）整目录拷到 `tmpdir/vibeterm-uninstall-<id>/`，再 detached 拉起 `vibeterm uninstall --yes --purge --install-dir <installDir> --delay-ms 1500`，立刻 202 `{ state: "scheduled" }`。`--delay-ms` 让 202 先刷出再停服务。随后卸载器停 launchd/systemd 用户服务、删安装目录（`versions/`、`current`、`staging`、`backups`、`app.env`、`data/` 含 SQLite `-wal`/`-shm`）、带 VibeTerm 标记的 shim（`~/.local/bin/vibeterm`、`~/.bun/bin/vibeterm`），并尽量删掉这份临时拷贝。不会碰安装目录、unit/plist 和已标记 shim 以外的路径。
4. 入口把长事务记在 `gateway_kv` 键 `mesh.node-op.<nodeId>`（`MeshNodeOperation`）：`requested`（转发前）→ `uninstalling`（目标 202）→ `failed`（带 `error`）。`GET /api/mesh/nodes` 每行带 `operation`（无则 `null`），页面刷新仍显示卸载中。记录自 `updatedAt` 起 TTL 30 分钟；节点从列表消失（吊销 / 移除）时在列表投影里惰性清除；也可 `DELETE /api/mesh/nodes/:id/operation`。`GET /api/mesh/nodes/:id/operation` 返回该记录或 404。
5. 前端随后走既有签名 `revoke-node` 从 hub 去掉该节点。卸载不代替吊销。

本机手动卸载仍用 `vibeterm uninstall [--yes] [--purge] [--delay-ms <n>]`。

## 账号安全：passkey 与 TOTP

页面 `/account/security`（登录页底部也有入口）。standalone 整页不渲染。持久变更（改密、TOTP、增删 passkey、admit / revoke）都要根钥或 passkey 当场签一条 `user_key_log` 记录，浏览器临时钥 `sk_sess` 签不了这些记录。

### passkey

- WebAuthn：RP ID 必须是域名或 `localhost`，**IP origin 不可用**。每个凭证绑定注册时的精确 origin（scheme + host + port）。
- `passkeyAvailable` = 安全上下文且 host 为域名或 localhost。反代后若服务端看到的是 `http://127.0.0.1`，按钮不会出现——见下文 `VIBETERM_TRUST_PROXY`。
- 登录：本 origin 有凭证才显示按钮；passkey 登录不需要 TOTP。
- 注册 / 删除：凭据对话框，密码或已有 passkey 均可授权。

同一 node 可从多个域名 origin 各注册一把，无需额外配置。

### TOTP

- 防远程猜密码 / 旁观，**不是**独立于口令的第二因素（与根钥同源派生）。需要独立第二因素时用 passkey。
- UI 两段式：先生成密钥与 otpauth URI（不写日志）→ 扫码并输入 6 位码 → 本地校验通过才追加 `set-totp`。取消或离开页面会清零密钥。
- **启用 TOTP 只能用密码**（需要 seed）。关闭 TOTP、增删 passkey 可用 passkey 授权。
- CLI：本机运维 `vibeterm hub user totp <username>` 打印 otpauth URI（无 ASCII QR）。客户端 `vibeterm settings totp enable|disable` 经 HTTP 签 `set-totp` / `clear-totp`（enable 先打印 secret + otpauth，用 `--code` / `VIBETERM_TOTP` 本地校验后再提交）。

### 改密

日常改密走 `rotate-root-keep`（旧根钥签）：更新根公钥、KDF 与 `root_epoch`，**保留** passkey、已启用的 TOTP（随记录按新 epoch / 新 seq 重封装）以及当前入口会话。未使用的 enrollment token 会立即失效，须重新签发。写入前所有未吊销节点须 ≥ 1.1.16，否则 409 `KEYLOG_TYPE_UNSUPPORTED_BY_NODES`；中继模式下，未出现在 `peer_cache` 的未吊销证书也按版本未知阻断。该类型不允许 `x-vibeterm-force-keylog` 绕过，以免旧节点按未知类型丢弃记录、造成状态分裂。

`rotate-root` 仍是破坏性改密：撤销全部 `node-session`、清空 passkey 与 TOTP，须在各入口重新注册。两条 CLI 路径对照：

| | 本机运维 `vibeterm hub user passwd <username>` | 客户端 `vibeterm settings passwd [--full-reset]` |
|---|---|---|
| 作用面 | 写本机库 | 签 keylog，经 HTTP `POST /api/auth/keylog?hub=sync` |
| 默认 | `rotate-root-keep` | 同左；开了 TOTP 时先 `GET /api/auth/totp-record` 再重封装 |
| 全量重置 | `--full-reset` | `--full-reset`（非 TTY 要 `--yes`） |
| 密码 | 非 TTY：旧 `VIBETERM_PASSWORD_OLD`，新 `VIBETERM_PASSWORD` | 当前 `VIBETERM_PASSWORD`；新密码 `--new-password*` / `VIBETERM_NEW_PASSWORD` 或 TTY 双次确认 |

全量重置会先警告通行密钥、TOTP、全部会话和中继密封包的影响；TTY 必须输入完整 `yes`，非 TTY 必须加 `--yes`。客户端 `settings passkey ls|rm` 可列 / 删通行密钥（注册只能在浏览器）；`settings local-auth bootstrap|set` 对齐 GUI 本机豁免（`jsonSelf`，可 `--node`；远端非本机回 `403 LOCAL_ONLY`）。灾难恢复仍用 `reset-root` / `mesh reset-root`，不要用日常改密代替。

登录体验：输入一次密码（或一次 passkey）生成 18 小时 `delegation`，先登当前入口 `self`，再用 `vibeterm_s_self` 拉 `/api/mesh/nodes`，对在线未登录的 node 并行登录。cookie `vibeterm_s_<nodeId>` / `vibeterm_s_self`：`HttpOnly; SameSite=Lax; Max-Age=64800`（18 h），HTTPS 加 `Secure`。滑动续期 18 小时，绝对上限 7 天。

## 直连：`direct enable|disable`

直连是同一逻辑 WS 会话的第二条载体（浏览器↔目标 node 的 `sess` DataChannel），失败自动回落 hub relay，功能不变。

```bash
vibeterm direct enable
vibeterm direct disable
```

`enable` 按 `platform / arch / libc` 查 pinned manifest，从 npm 拉单平台 tarball，校验 sha512 后解出 `node_datachannel.node` 到 `<installDir>/native/`，并写 `native/manifest.json`。`disable` 删除整个 `native/` 目录。`upgrade` 在部署 runtime 后若已有 native 且版本变化则重下；standalone 无 `native/` 则跳过。

**v1 支持的平台：** macOS arm64 / x64，Linux glibc x64 / arm64。**musl、Windows、其它 arch 不支持**（`lookupNativePin` 返回 `null`，enable 失败且不阻断）。缺失或装载失败 → `direct_capable=false`，authorize 返回 503 `DIRECT_UNAVAILABLE`，浏览器退避最多 5 次后停在 failed。

ICE 顺序（自动）：同内网 host → IPv6 → IPv4 STUN → TURN（可达探测通过的，最多两条）→ hub / 中继转发。未实现 UPnP / NAT-PMP。空 ICE 服务器列表在 PoC 中会长时间超时，因此缺省带内置 STUN；可用 `VIBETERM_STUN_SERVERS` 换成本网可达的列表，或 `none` 显式禁用（仅局域网/全中继场景）。

设备页（非 `self`）两枚徽标：浏览器↔node 路径（`lan` / `v6` / `v4-p2p` / `turn` / `relay` 与 RTT）和 entry↔node 的 `reach`。直连断开时切回 primary，并对已订阅 pane 做一次 resume；浏览器→node 方向在断开瞬间可能丢最近输入，界面提示「直连已断开，最近输入可能未送达」。

**entry↔目标 node 的转发流（`/n/:id/ws` 与幂等 HTTP）同样会 failover。** 打开的 pane 订阅绑定在当前 peer link（`dc` / `ws-secure` / `relay`）上；DataChannel 断开后，entry 保持浏览器侧 WebSocket 不关，在当前最优链路上重开同一逻辑流，并回放 HELLO、已连接 device、pane 订阅。**canonical 订阅**（`SetPaneSubscriptions`）带上最后收到的 `PaneData.terminalSeq` 游标，新链路上按游标精确续传；游标失效或数据已被逐出时才发 `SourceGap` 并重推整屏。1.1.23 起只有这一条回放路径：legacy 订阅（`TMUX_SUBSCRIBE_PANES` + `TMUX_FETCH_PANE_HISTORY` → `TERM_HISTORY` → `TERM_OUTPUT`）已随整条 legacy 状态流删除，**对端低于 1.1.23 时不再降级回放，直接判定该 peer 不可用**（能力 `canonical-state-v1.1` + 版本门槛，见 [ws-borsh 状态机](../architecture/ws-state-machines.md)）。failover 期间到达的浏览器帧会排队，canonical 的 generation 会抬到回放帧之后，避免同 generation 冲突。若短时间内没有任何备用链路，entry 按有界退避重试并保持浏览器连接；用尽后才关掉浏览器 WS，由前端走既有重连。日志：`[mesh][stream] failover stream=… from=dc to=relay|ws-secure resumed=<n panes>`。GET/HEAD 在拿到响应头之前也会按同样策略换链路重试。

node↔node DataChannel 另有应用层存活探测：空闲时每 `RTC_LIVENESS_INTERVAL_MS`（默认 3 s）发一帧 ping/pong；任意入站流量都会重置计时。连续 `RTC_LIVENESS_TIMEOUT_MS`（默认 10 s）无入站则关闭该 DC/PeerConnection，`transport` 从 `dc` 回落（既有 carrier-switch / `getLink` 路径），日志为 `[mesh][rtc] liveness timeout peer=… idle_ms=…`。不要只等 ICE `disconnected`→`closed`（实测约 35 s）。浏览器 `sess` 载体识别并回复 ping，但不主动探测（浏览器侧尚未发 ping）。回连走既有 RTC wake 冷却（`PEER_RTC_WAKE_COOLDOWN_MS`，5 s），避免直连抖动时打爆信令。

## 中继内置 TURN 与多中继

### 内置 TURN：开端口、看状态

中继角色（`relay` / `relay,node`）的进程自带 TURN，凭据自动生成、随 `auth.ok` / `relay.list` 下发给租户节点，**不需要手配环境变量**。
hub 角色没有内置 TURN，仍只认 `VIBETERM_TURN_URL` / `_USERNAME` / `_CREDENTIAL` 三元组；中继上配齐这三个键也会改用外部 TURN。
协议细节见 [公共中继角色](../architecture/relay.md)「内置 TURN」。

运营者只需做一件事：**放行端口**。

```
UDP 40000            # VIBETERM_TURN_PORT，控制口 + STUN Binding（节点探测打的就是它）
UDP 40001-40049      # VIBETERM_TURN_RELAY_PORT_RANGE，整段都要放
UDP 40050-40099      # 仅 relay,node：本机 ICE（与 TURN 错开）
```

云厂商安全组、面板防火墙、`ufw` 三层各放一次。统一段是 **UDP 40000-40099**。`vibeterm init` / `hub join` / `relay join` / `install.sh` 结束时打印角色完整 `formatPortList`。节点管理表在 `ports[].status === 'blocked'` 时于名字下警告；详情框可「重新检测」。TURN 磁贴有 `membersProbe` 时显示「成员可达 ok/total」（按本机公网 URL 分桶，不把副中继的 TURN 报告混进来）。

排查顺序：

1. `vibeterm relay status`（中继机本地）的 `turn:` 行：
   `turn: builtin enabled listening url=turn:<ip>:40000?transport=udp port=40000 bind=… external_ip=… relay_range=40001-40049 allocations=N`。
   开头的来源是 `external` 说明三元组还在 `app.env` 里压着内置，是 `off` 说明 `VIBETERM_TURN_PORT=0/off`；起不来时行尾带 `error=…`。`bindHost` 为实际绑定地址。
2. `vibeterm doctor`：端口计划恒 pass；peer TCP 本机是否在听；`turn` 检查（模式 + Binding 探测 + 该放行哪些端口）；有会话时拉 mesh self 行的 `blocked` 口（无会话静默跳过）。探测过但节点还是用不上 = 防火墙。
3. 中继日志 `[relay][turn]`：`builtin turn listening … bind=…` / `builtin turn disabled reason=…`（常见 reason：`external ip unknown`
   —— 公网 IP 既没配也解析不出；`EADDRINUSE port=…` —— 端口被占，5 s → 60 s 退避重试；与 `VIBETERM_RTC_PORT_RANGE` /
   `VIBETERM_PEER_PORT` 冲突），以及每 30 min 一条 `turn allocations=N`。
4. 租户节点侧：`GET /api/mesh/rtc-config` 的 `turnConfigured` / `turnProbes`，日志 `[mesh][rtc] turn gate configured=N reachable=M used=[…]`。
   `reachable=0` 就是节点到 TURN 的 UDP 不通。设置页 TURN chip 把「本机」与「舰队」分开：本机 ok →「TURN 可达 · N/M 节点」；本机 fail →「TURN 本机不可达 · N/M 节点可达」（`N>0` 琥珀，全员失败或无 members 为危险色）；未探测 →「TURN 未探测」。`localHint=tun` 时 tooltip 提示探测结果仅代表本机。`vibeterm relay list` 的 TURN 列为 `(ok, N/M)` / `(down, N/M nodes ok)` / `(down)`。本机探测失败、其它节点仍可达时，先查本机 UDP/TUN 策略（见 [KI-15](../known-issues.md)），不要当成中继 TURN 挂了。

公网 IP 变了不会重启 TURN：只换 `XOR-RELAYED-ADDRESS` 与广告地址（未设 `VIBETERM_TURN_HOST` 时广告的是 IP 字面量），已有 allocation 不断。
中继在反代 / 隧道后面时要注意：TURN 是裸 UDP，**不经反代**，`VIBETERM_RELAY_PUBLIC_URL` 的域名只当解析入口用。

### 多中继：主 + 副

给同一个 mesh 接第二台中继，就在任一已接入节点上再跑一次 enroll（签的是同一条 `set-relays` 记录）：

```bash
vibeterm relay enroll https://<第二台中继地址>
vibeterm relay list
```

`relay list` 的列是 `PRI URL ROLE STATE RTT PEERS TURN NOTE`；该行有 `pathBestMs` 时在 `RTT` 后多一列 `BEST`。TURN 列带本机探测与成员计数：`(ok, N/M)` / `(down, N/M nodes ok)` / `(down)`。多中继时另打一行 `multi-attach: yes`。
配了 ≥ 2 条之后，节点对每一条都保持连接：

- **主中继**（`ROLE=primary`）负责写新的密钥日志记录、出成员名册、出配额。**副中继**只做在线状态、入站流、RTC 信令与日志追平。
- 一对节点走中继时**按对选路**，挑双方都在线、往返之和最小的那台，不一定是主中继；设备徽标上会写「中转（经 <host>）」。
- `PEERS` 是该中继上在线的对端数，`peers via relay` 是所有中继的**并集**。
- **「设为主中继」**（设置 → 节点，或 `POST /api/mesh/relay/switch`）只换主，副中继继续连着；旧主降为副。目标已经是在线主中继时回 409。
- 某台被踢只影响它自己那行，其余中继照常用；`reauth` 也是按 URL 做。
- 单文件上限取所有已连接中继里最小的那个。

中继之间**不互转**：一对节点必须在同一台中继上都在线才有中继路径。对端还在 2.2.x（只连一台）时，能用的就只有它挂的那台。

## Cloudflare Tunnel 与反代

Cloudflare Tunnel / Access 可放在 hub 或任一 node 前面。推荐：

1. `VIBETERM_BIND_HOST=127.0.0.1`，cloudflared 指到本机 `9883`；
2. `VIBETERM_HUB_PUBLIC_URL` 写成隧道的 `https://` 域名；
3. **`app.env` 增加 `VIBETERM_TRUST_PROXY=true` 后重启**，否则：
   - cookie 可能缺 `Secure`；
   - passkey 的 origin / `passkeyAvailable` 按 `http://127.0.0.1` 计算，公网域名下无法注册或登录。

该开关只作用于本机 UI 的 origin 计算，**不会**把转发来的 `X-Forwarded-*` 当成客户端 IP。

### 连接器健康

cloudflared 进程存活不等于边缘连通。本机代理 / TUN 抖动时进程常驻，日志里会出现 `TLS handshake with edge error` / `Unable to establish connection with Cloudflare edge`，公网地址随之不可达。

权威信号是连接器本地 metrics：`GET http://127.0.0.1:<port>/ready`（`--metrics`、启动日志 `Starting metrics server on 127.0.0.1:20241/metrics`，缺省扫描 `20241–20245`）。`readyConnections === 0` 时状态为 `degraded`，连通性检查返回 `connector_down`（HTTP 503），即使 hostname 被 Cloudflare Access 302 拦截也不能当成成功。Access 拦截且连接器已验证有连接 → `access_protected`；找不到 metrics → `access_protected_unverified`。外部托管的 cloudflared 会读 `--logfile` 尾部（脱敏）填 `status.log`。`GET /api/tunnel/status` 对连接器探测最多等待约 800ms，过期则后台刷新。

## hub 离线

登录不经过 hub，流程与在线相同。`node.list` 里的 hub 元数据会落入 `peer_cache` 哨兵行，重启后 `/api/auth/mode` 与节点列表在 uplink 断开时仍可回答。

同内网互操作依赖 `peer_cache` 里上次上报的地址（本机非 internal、非容器网卡上的可路由 IPv4/IPv6 + `VIBETERM_PEER_PORT`；不广播代理 TUN 的 fake-IP 段 `198.18.0.0/15`（拨号侧也会丢弃旧节点广播的这类地址），默认不广播 IPv6 ULA 与 CGNAT `100.64/10`，本机自身有非 internal 的 `100.64/10` 时除外，以兼容 Tailscale）。**v1 不做局域网发现**：hub 不可达期间若对端 IP 变了，缓存失效，须等 hub 恢复。对端仍广播不可达地址（例如旧版本的 docker 网桥）时，拨号侧按地址退避，避免反复空打。peer link 仍然活着时，地址变化会立刻互相更新。

Nodes 页的管理动作（enroll / 改名 / 吊销）在 hub 离线时禁用。普通终端 / 文件走已有 peer link 或缓存 LAN 信令，不依赖 hub。

hub 恢复后无需重新登录（cookie 仍有效）。

## 灾难恢复

以下恢复操作都是**本机**命令，不接受远程触发。拥有机器 root = 拥有该点。

### `mesh reset-root`（任意 mesh 机器）

```bash
vibeterm mesh reset-root
```

`VIBETERM_ROLES=standalone` 会拒绝。操作前提示通行密钥、TOTP、会话和中继密封包的破坏性影响；TTY 必须输入完整 `yes`，非 TTY 必须加 `--yes`。输入新密码后保留用户名，在本机重建根钥并自签 `admit-node`。用于「密码在失陷入口上泄露、攻击者抢先 `rotate-root`」这类无法依赖旧根钥的场景。

之后：**每台机器都要再执行一次**；其它机器需重新 `enroll` / `hub join`。hub 侧配合下面的 registry 清空。其它机器本地即使仍留着同名旧用户（uid / 根钥已变），`hub join` 也会原子替换该账号，不必先 `hub leave`。

### 节点私钥丢失

`node_identity` 解密失败时保留 HTTP 与本地登录，`/healthz` 返回 `degraded: "master_key_mismatch"`，mesh 和 Hub 控制面停用。优先从 `backups/app.env.*` 恢复与数据库配套的 `VIBETERM_MASTER_KEY`。无法恢复时，先停止该安装的服务，在本机执行 `vibeterm mesh reset-identity`（非 TTY 加 `--yes`），更换节点身份、撤销本机会话并清除中继连接密钥及节点缓存；账户凭据与日志保留。然后重新加入可信 Hub 或中继并启动服务。TLS 私钥也丢失时，停止服务后执行 `vibeterm tls reset`，或在身份重置时显式加 `--reset-tls`，直接清除不可解密的 TLS 材料，再通过本地 HTTP 登录重新配置 HTTPS。TTY 必须输入完整 `yes`，非 TTY 必须加 `--yes`；身份重置默认保留 TLS 配置。详见 [主密钥排障](./troubleshooting-db-master-key.md)。

### 日志分叉诊断

```bash
vibeterm mesh keylog status
```

输出本地 `seq/hash`、本机运行时可见的 Hub／中继日志头与判定：`IN_SYNC`、`BEHIND`、`AHEAD`、`FORK`。不同长度的日志还须核对公共位置的 hash，不能仅按长度断言链一致。网关停止时读取本地数据库，远端无法验证则明确显示 `UNKNOWN` 并退出 1；不把没有远端数据当成同步成功。`FORK` 退出 2，其余已确认状态退出 0。

发现分叉不要重放或强行追加；先确定可信链，在分叉节点执行 `vibeterm mesh reset-root` 后重新加入。改密、成员授权等变更应由一个入口依次完成，避免多个入口同时写控制日志。

### `hub user reset`（仅 hub 机）

```bash
vibeterm hub user reset
```

停服务 → 删除 `nodes` 与 `enrollment_tokens`（**保留 `node_certs`**）→ 再启动。日志提示：失陷节点在重新注册前须先 `revoke-node`。这只清注册表，不是改密。

日常改密用 `hub user passwd` / 账号安全页，不要用这两条。

## 常见排障

| 现象 | 含义 | 处理 |
|---|---|---|
| node 角色无 `[uplink]` 日志、或一直连不上 hub | `runLoop` 连 hub 失败会吞掉错误并退避；现每次尝试打 `[uplink] connect failed hub=<host:port> attempt=<n> reason=<code> next_retry_ms=<delay>`（同一 reason 最多 30 s 一条），成功为 `[uplink] online hub=… after_ms=…`，掉线为 `[uplink] offline reason=…`。不打 URL / token。hub 侧每次鉴权失败打 `[hub][uplink] auth rejected node=<id> reason=<cert_not_admitted\|revoked\|bad_sig\|bad_cert\|timeout\|…>`（同一 node+reason 最多 10 s 一条，后续带 `suppressed=`） | 看 node 的 `reason`：`tls` 证书链不被系统信任；`dns` 解析失败；`refused` 端口未开或防火墙；`timeout` TLS/WS/auth 握手超过 `UPLINK_CONNECT_TIMEOUT_MS`（默认 20 s）；`http_4401` / `http_403` 升级被拒；`auth_rejected` 证书未 admit / 已吊销 / 签名失败。对照 hub 的 `reason`：`cert_not_admitted` 尚未 admit 或证书不在 `node_certs`；`revoked` 已吊销（须换新身份）；`bad_sig` 签名失败（含 hubHost 不一致）；`bad_cert` 证书损坏。进程内 `UplinkClient.lastConnectError` 保留最近一次原因与时间 |
| `[uplink] connect failed reason=timeout` 反复出现 | 20 s 内未完成 WS 打开 + auth 握手（TLS 卡住、hub 无响应、无 `auth.challenge`） | 确认 `VIBETERM_HUB_URL` 可达、反代支持 WebSocket、证书有效。必要时把 `UPLINK_CONNECT_TIMEOUT_MS` 调大后重启 |
| WS 关闭码 **4401** | 无 `node-session`、会话过期或 logout。`/ws`、`/n/:id/ws`、`/mesh/ws` 升级后以此码关闭；`/mesh/ws` 每 5 分钟复验失败同样 4401 | 本机入口：跳 `/login?next=`。其它 node：不跳全局登录，侧边栏「登录此节点」（内存里还有 `sk_sess` 则静默补登）。前端对 4401 **停止重连**，避免 open→close 循环 |
| HTTP 401 `NODE_LOGIN_REQUIRED` | 目标 node 未登录或票的 `via` 不是当前 entry | 只在该 node 行登录，不要当整站掉登录 |
| HTTP 503 `NODE_UNREACHABLE` | entry 到目标的 peer link 与 hub relay 都失败 | 查目标是否在线、防火墙是否放行 `VIBETERM_PEER_PORT`、hub uplink、`VIBETERM_HUB_URL`。hub 离线时确认 `peer_cache` 地址是否仍达 |
| HTTP 409 `node_exists` | 该 nodeId 已登记，但公钥与本次 join 不一致（身份冲突） | 同一身份重 join（半途失败后再 enroll）不应再出现此错误。确认本机 `node_identity` 是否被换钥；换钥须先 `revoke-node` 再 enroll 新身份。不要用 `hub user reset` 清半途失败的 registry 行 |
| HTTP 409 `node_revoked` / join 提示 `this node identity was revoked` | 该 nodeId 的证书已被 `revoke-node`，同一身份不能再加入 | 换新身份：`mesh reset` 或重新 `init` 后再 enroll。不能靠新 token 解吊销 |
| enroll 打印 `already admitted` | 该 nodeId 已在 keylog 中 admit，二次 enroll 被跳过 | 预期行为。不应再出现 `node admitted`。若 uplink 仍 `auth_rejected`，对照 hub 的 `[hub][uplink] auth rejected` |
| enroll `admit-node failed: node_id_reused`（或其它 keylog 错误） | 试图再 admit 一个已占用的 nodeId，或记录未通过 keylog | 不要把失败当成已 admit。同一身份重 join 应走 `already admitted`；换钥须新 nodeId |
| HTTP 409 `KEY_LOG_FORK` | 同一 `seq/prev_hash` 出现两个不同后继，硬失败，hub 不选胜 | 不要强行重放。核对是否两条入口同时改密 / admit。无法收敛则走灾难恢复 |
| HTTP 504 `HUB_TIMEOUT` | `keylog?hub=sync` 等 hub ACK 超时，且对不上已提交记录 | 本地不落库；Nodes 页保留 pending，点「重试」。hub 恢复后再试 |
| 503 `DIRECT_UNAVAILABLE` | native 未装载、authorize 登记满（64）或 RTC 不可用 | `direct enable`；看 `VIBETERM_NATIVE_DIR` 与 `native/manifest.json`；装不了的平台接受 relay |
| 直连降级到 relay | ICE 失败、一端 `direct_capable=false`、或 `direct disable`、或 DC 存活超时 | 预期行为。功能应仍可用，徽标变为 `relay` / `turn`。UDP 被丢后 `transport` 应在约 10 s 内离开 `dc`（日志 `liveness timeout`）；若仍卡 ~35 s 才变，说明存活探测未生效 |
| 两边 `direct_capable=true` 但 `transport` 不是 `dc` | 只走了 hub relay / LAN WS，或升级尚未完成 | 日志前缀 `[mesh][rtc]`。应先有 `dial start role=offerer\|answerer`，较大 id 侧有 `kind=wake`，随后 `signal send/recv kind=sdp`。没有 `dial start` 说明没人拨号；只有 answerer 没有 wake/offer 是旧 bug。`ice failed … local_types=[host] remote_types=[…]` 且无 `srflx` → STUN 不可达；两边都有 `srflx` 仍失败 → 对称 NAT，需要一台**探测得通**的 TURN（中继角色自带，看 `[mesh][rtc] turn gate` 这行的 `reachable=`）。`datachannel open` 才算 DC 握手成功。不要把完整 SDP / ICE 密码打进日志 |
| 设置页 / `relay list` 写「TURN 本机不可达 · N/M 节点可达」 | 本机 UDP 到该 TURN 不通，其它成员 Binding 成功 | 不是中继挂了。先查本机代理 TUN 是否丢境外 UDP（见 [KI-15](../known-issues.md)）。`N===0` 或无 members 才是舰队侧也探不通 |
| 终端数秒停顿、日志有 `[mesh][stream] failover` | Forwarder 在重建 mux stream 并 replay | 行首 ISO 时间戳可对齐。`failover_start` 的 `cause=stream_close\|send_failed`、`close_reason`、`from`、`queued_input_bytes` 区分 RST/发送失败；`failover_attempt` 的 `getLink_ms` / `open_stream_ms` / `hello_wait_ms` / `resume_wait_ms` 区分建链慢还是 HELLO/snapshot 等待；`failover_summary` 的 `duration_ms`、`replay_bytes`、`event_loop_lag_ms` 给出总耗时。`[ws] backpressure enter\|skip\|drain` 与 `terminate reason=backpressure_gap` 带 `carrier=physical_browser_ws\|mesh_link_stream` 以及 session/cid/node，用来判断背压在浏览器 socket 还是 mesh carrier。`[mesh][mux] rst send/recv` 现含 `muxStreamId` 与 `nodeId`/`transport`。`[ws-metrics] gateway_activity` 的 `event_loop_lag_ms` / `max_lag_ms` 判断主线程是否卡住 |
| `[mesh][rtc] dial failed` 刷屏、hub 入站 UDP 被滤 | 对 `direct_capable≠false` 的 peer 会反复拨 DC | 连续 3 次 DataChannel 失败（含通道打开后立刻死掉）后打一条 `[mesh][rtc] breaker trip peer=… fails=… level=… cooldown_ms=… until=…`，冷却期内跳过该 peer 的 DC（起始冷却默认 30 s，可用 `VIBETERM_RTC_DIAL_BREAKER_MS` 覆盖；之后 60 s / 120 s … 上限 30 min）。跳过时 `dial failed` 带 `cause=breaker_cooling`。`dial failed` 同一 peer 60 s 至多一条并带 `count=`。通道保持健康 ≥ 60 s 才打 `[mesh][rtc] breaker reset` 并清零；endpoints / `direct_capable` 变化不再复位。不改 transport 优先级，也不改 `directCapable !== false` 门闩。细节见 [节点直连](../architecture/peer-direct-connect.md) |
| `[mesh][peer]` 反复对同一批 LAN 地址拨号、或 `directFailure.ws` 为 `all endpoints backing off (next eligible in Xs)` | 对端广播了不可达地址（docker 网桥、无 Tailscale 的 CGNAT、ULA），或本机确实到不了 | 失败地址按 `(node, host, port)` 退避 1 min → 6 h，日志 `endpoint backoff node=… addr=… fails=… next=…` / `endpoint recovered …`。全部候选被压制时直接回落 relay，不是故障。要让对端不再广播这些地址，需把**对端**升级到含广播过滤的版本。见 [节点直连](../architecture/peer-direct-connect.md) |
| enroll 新中继后约 10 分钟才挂上，日志 `[uplink] relay drain timeout reason=reconfigure` 紧跟 `[uplink] try hub=<新中继>` | 节点仍是 **2.3.1 及更早**：整张目标表一变就排空重建主 uplink（在途中继流最多等 10 min） | 把该节点升到 ≥ 2.3.2。新版本增删副中继只打 `[relay] targets updated … (no restart)`，不排空主链 |
| `PROTOCOL_MISMATCH` | `/api/auth/mode` 缺 `rootEpoch` / `rootPublicKey` 等 mesh 必填字段 | 服务角色不是 mesh，或旧进程未起来 |
| join 失败 `https` / `--insecure-local` | 非 HTTPS，或 production 用了 insecure | 换成系统信任链下的 HTTPS |
| join `key log rejected` / `epoch_changed` | 签发 token 之后发生了 `rotate-root` / `rotate-root-keep` / `reset-root` | 重新 enroll |
| enroll 一直「待确认」 | 证书未到本会话，或 passkey 路径需手动确认，或 hubAck 未到 | 等 join 完成再点确认；查 hub 是否在线；根钥路径才自动 admit |
| 登录页没有 passkey | `passkeyAvailable=false` 或本 origin 无凭证 | 用域名 HTTPS（加 `VIBETERM_TRUST_PROXY`）；先在本入口注册 |
| TOTP 登录 `TOTP_INVALID` | epoch 与派生盐不一致，或验证码过期 | 确认用的是当前 epoch 的密码；日常改密会重封装 TOTP，无需重设；破坏性 `rotate-root` 后须重设 |
| HTTP 409 `HUB_NOT_WRITER` | 打到了 standby hub 的写接口（enroll / redeem / rename / revoke） | 改打 body 里的 `writerPublicUrl`。要把这台变成写者，先让原主 `vibeterm hub demote`，再 `vibeterm hub promote --yes`。见 [多 hub 主/备](./multi-hub-standby.md) |
| 两台 hub 同时 `mode=active` | epoch 围栏未生效或旧主恢复时没先 demote | 立即把其中一台 `demote` 或停机。日志会有 `split-brain` 或 `fenced: higher writerEpoch`。切回顺序见 [多 hub 主/备](./multi-hub-standby.md) |

限速：每个 node 对同一 `uid` 或 IP 每分钟 10 次登录，超出 429。转发登录的限速桶目前是 `peer:<entryNodeId>`，不是浏览器真实 IP。

## 安全边界摘要

完整表格见 [多节点架构 §5 安全边界](../architecture/mesh-architecture.md)，此处不复制。运维上只需记住：

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
6. `VIBETERM_TRUST_PROXY` / `VIBETERM_PEER_BIND_HOST` / 外部 TURN 三元组不会被 `init` 写入，必须手改 `app.env`。内置 TURN 的 `VIBETERM_TURN_PORT` / `VIBETERM_TURN_RELAY_PORT_RANGE` 与 `VIBETERM_RTC_PORT_RANGE` 由 `init` 按角色写入；`VIBETERM_TURN_BIND_HOST` 默认 `auto`，不配也能跑。
7. TURN 只支持 UDP：node 侧 ICE 由 node-datachannel（libjuice）实现，`turn:…?transport=tcp` / `turns:` 不会产生 relay 候选，内置 TURN 也只中继 UDP/IPv4。机器若被上游过滤入站 UDP（部分 VPS 默认如此，`tcpdump` 在网卡上看不到任何 UDP），则直连与 TURN 兜底都不可用，只能走转发；需换有 UDP 入站的机器跑中继。
8. 对称 NAT（同一 socket 对不同目标映射出不同端口，如 Docker Desktop 出口）之间无法打洞，必须 TURN；macOS 上 TUN 模式代理会吞掉 UDP，做直连验证时要给 hub/TURN 的 IP 加主机路由绕过（`sudo route -n add -host <ip> <网关>`）。

## 参考

- [多节点架构](../architecture/mesh-architecture.md)
- [多 hub 主/备](./multi-hub-standby.md)
- [节点直连：退避、熔断、信令与失败码](../architecture/peer-direct-connect.md)
- [跨境路径优选](../architecture/path-selection.md)
- [部署指南（安装 / 服务 / SSH 设备）](./production-install.md)
- [自更新](./self-update.md)
- [tmux 进程存活](./tmux-process-survival.md)
- [库与 MASTER_KEY 不匹配](./troubleshooting-db-master-key.md)
- [登录面安全](../security/login-security.md)
