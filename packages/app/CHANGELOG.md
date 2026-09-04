# 1.1.30

_2026-09-05_

## English

### Changes

- Settings → Relay Management (renamed from "Relay", now placed right after Multi-node Mesh): rates show at most two decimals; the access password moved into the page's overflow menu and the default quota into the tenants card's overflow menu (both open dialogs); the tenants table now sits above the connected-nodes table and selecting a tenant filters its nodes; the connected-nodes table gains search, column sorting (default: node name) and an online/offline filter. "Access passphrase" is now "access password"; the internal "token floor" row is gone.
- Settings → Multi-node Mesh → This machine: relay rows are a compact address pill plus one status badge (latency when online, Offline otherwise); with two or more relays, clicking another relay switches to it after confirmation (new `POST /api/mesh/relay/switch`, the chosen relay is remembered as preferred). Connection details drop the metadata-key epoch and key-log rows and the "rotate metadata key" action; all three quotas (nodes, streams, bandwidth) show live usage; "Nodes via relay" is now "Reachable nodes" and the machine id sits right below the tenant id.
- Relay link errors are shown only while the link is offline and are translated from a stable error code (`lastErrorCode`); a link that reconnected no longer displays a stale "last error". The relay pushes live tenant usage to its members every 5 s; `GET /api/relay/metrics` returns effective quotas, per-tenant usage and the token-bucket bandwidth rate.
- Connect Devices → Server or computer: rewritten as three paths — via relay (join an existing one or run one here), via Hub (join or become one) and direct SSH (no tmex on the new machine) — with a one-line explanation of each and a default path derived from this machine's setup.
- Remote access: "No edge connections" is only reported when cloudflared actually reports zero ready connections, and the notice now says what to check (proxy/firewall on port 7844 for `*.argotunnel.com`).

### Fixes

- A relay rejecting this machine's credentials while adding a relay (`RELAY_*` 401) no longer logs the whole page out.

---

## 中文

### 变更

- 设置 → 中继管理（原「中继」，移到多节点互联右侧）：速率最多两位小数；接入密码收进页面右上角菜单、默认配额收进租户卡右上角菜单（均为弹窗）；租户表移到接入节点表上方，选中租户即筛出其节点；接入节点表支持检索、列排序（默认按节点名）与在线/离线筛选。「接入口令」统一改为「接入密码」，删除内部的「令牌下限」行。
- 设置 → 多节点互联 → 本机：中继行改为地址 pill + 单枚状态徽标（在线显示延迟，否则显示离线）；两条以上中继时点击其他中继经确认后切换（新增 `POST /api/mesh/relay/switch`，所选中继记为首选）。连接详情删除元数据密钥代数、密钥日志与「轮换元数据密钥」；节点、并发流、带宽三档配额均显示实时用量；「经中继可见节点」改为「可访问节点」，本机编号紧随租户编号。
- 中继链路错误只在离线时显示，并按稳定错误码（`lastErrorCode`）翻译；重连成功后不再残留「最近错误」。中继每 5 秒向成员推送租户实时用量；`GET /api/relay/metrics` 返回生效配额、租户用量与令牌桶带宽速率。
- 接入设备 → 服务器或电脑：重写为三条路径——经中继（加入已有 / 本机自建）、经 Hub（加入 / 本机设为）、SSH 直连（新机器无需安装 tmex），附一句话说明，并按本机现状选默认路径。
- 远程访问：只有 cloudflared 确实报告 0 条就绪连接时才显示「无边缘连接」，提示改为可操作（检查代理 / 防火墙对 `*.argotunnel.com` 7844 端口的放行）。

### 修复

- 追加中继时被中继拒绝凭据（`RELAY_*` 401）不再把整页踢去登录页。

---

# 1.1.29

_2026-09-04_

## English

### Fixes

- Settings → Multi-node → This machine: opening the card's overflow menu crashed the page in 1.1.28 (the menu label was rendered outside a menu group, which Base UI rejects at runtime). Fixed and guarded by a test.

---

## 中文

### 修复

- 设置 → 多节点互联 → 本机：1.1.28 中点击卡片右上角的溢出菜单会整页崩溃（菜单小标题没有放在菜单分组内，Base UI 运行时拒绝渲染）。已修复并加回归测试。

---

# 1.1.28

_2026-09-04_

## English

### Fixes

- Login page no longer prefills the username: nodes that joined a mesh stored the account uid as the username and showed a UUID. The field starts empty (browser autofill still works), an empty username signs in with the account uid, and `/api/auth/mode` no longer returns identifier-looking usernames.
- Installed PWA on mobile: the automatically opened sidebar no longer moves focus to its close button on cold start; the close button only shows a focus ring for keyboard navigation.
- First paint follows the saved site language (cached locally) or the browser languages instead of English; a failed site-settings request no longer switches the UI back to English.
- Devices of remote nodes failed to load with a generic error when the entry site changed its node identity (e.g. a hub that became a relay): stale per-node session cookies made the target answer `via_mismatch` while the UI still considered the node signed in. The entry now expires the stale cookie, the UI re-signs-in once automatically, and the devices panel shows the actual reason (sign-in required / node unreachable with a safe reason) with a retry button.
- Relay member lists no longer include pending or revoked members as reachable nodes; relay dial context is snapshotted explicitly.
- CI: the relay hardening test left an unobserved stream rejection that failed every run; panels tests were polluted by a process-wide i18n mock; TypeScript baseline errors cleared.

### Changes

- Settings → Multi-node → This machine was rebuilt: a header with the role and a single status badge plus an overflow menu (change role / leave / account security), then three sections — Connection (setup wizard, relay or hub links, notices, actions, a collapsed “Connection details” for tenant id, key epochs, quota and node ids), Relay service (public address, password state, live metrics) and Network (direct-connection add-on, domain access). Duplicate wizards, the two uplink tabs and hub-era wording shown to relay nodes are gone.
- Relay performance monitoring: `GET /api/relay/metrics` (relay admin) reports process memory / CPU / load / event-loop lag, online members, active streams, byte and frame rates, per-member RTT, reconnects and stream counts, with a 5-minute history. The Relay settings tab shows tiles, trends and a members table; relay nodes show compact tiles on the This machine card.

---

## 中文

### 修复

- 登录页不再预填用户名：加入 mesh 的节点把账号 uid 存成了用户名，登录框里显示一串 UUID。现在用户名默认为空（浏览器自动填充仍可用），留空即按账号 uid 登录，`/api/auth/mode` 也不再返回标识符形态的用户名。
- 手机端安装的 PWA：冷启动自动展开的侧栏不再把焦点落到「关闭侧栏」按钮上；该按钮只在键盘导航时显示焦点环。
- 首屏语言按已保存的站点语言（本地缓存）或浏览器语言渲染，不再先显示英文；站点设置请求失败也不会把界面切回英文。
- 入口站点更换节点身份后（如 Hub 改为中继），远端节点的设备列表一直「加载失败」：浏览器里残留的按节点会话 cookie 让目标节点报 `via_mismatch`，而界面仍认为该节点已登录。现在入口会让过期 cookie 失效，界面自动重新登录一次，设备面板显示真实原因（需登录 / 节点不可达及安全的原因码）并提供重试。
- 中继成员列表不再把待批准或已吊销的成员当作可达节点；中继拨号上下文改为显式快照。
- CI：中继加固测试遗留了未观察的流拒绝导致每次运行失败；panels 测试被进程级 i18n mock 污染；TypeScript 基线错误清零。

### 变更

- 设置 → 多节点互联 → 本机 全面重排：卡头为角色与唯一状态徽标加溢出菜单（更改角色 / 离开 / 账号安全），下分「连接」（设置向导、中继或 Hub 链路、提醒、操作，以及默认收起的「连接详情」收纳租户编号、密钥代数、配额与节点编号）、「中继服务」（公网地址、口令状态、实时指标）与「网络」（直连插件、域名访问）三段。删除了重复的向导、两个上级 tab 和对中继节点显示的 Hub 时代文案。
- 中继性能监控：新增 `GET /api/relay/metrics`（中继管理员），报告进程内存 / CPU / 负载 / 事件循环延迟、在线成员、活跃流、字节与帧速率、成员 RTT、重连与流数，并带 5 分钟历史。中继设置 tab 显示指标瓦片、趋势与成员表；中继角色的本机卡片显示精简瓦片。

---

# 1.1.27

_2026-09-04_

## English

### Fixes

- In relay mode the entry node was listed as “self” (sidebar and node list) because the site-name fallback only applied to Hub roles; the node name now follows node identity name → site name in every role, and the same name is sent to the relay.
- Relay status rows that are not attached now carry the last connection failure reason and time (e.g. `member-epoch_mismatch`, `client-too-old`) instead of a bare “offline”.

---

## 中文

### 修复

- 中继模式下入口节点在侧栏与节点列表里显示为「self」（站点名回退只在 Hub 角色生效）；现在任何角色都按 节点身份名 → 站点名 取名，并把同一个名字发给中继。
- 未挂载的中继行现在带最近一次连接失败的原因与时间（如 `member-epoch_mismatch`、`client-too-old`），不再只显示「离线」。

---

# 1.1.26

_2026-09-04_

## English

### Fixes

- **Relay migration after a root rotation.** A relay only ever knows the account's current root key, but the `admit-node` records of existing members were signed by older roots (every `rotate-root-keep` bumps the root epoch). Enrolling such an account to a relay left every member refused with `member-epoch_mismatch`. A new signed record, `readmit-node`, re-affirms an existing member under the current root: the relay enroll flow (web and `tmex relay enroll`) now signs one per stale member before switching, the relay status card shows how many members still need it with a “Re-affirm members” button, and `GET /api/mesh/relay/readmit/prepare` lists them. Requires all nodes on 1.1.26 (version-gated record).

---

## 中文

### 修复

- **根轮换之后接入中继。**中继只认账户当前的根钥，而既有成员的 `admit-node` 记录是旧根签的（每次 `rotate-root-keep` 都会推进根 epoch），这样的账户接入中继后所有成员都会被 `member-epoch_mismatch` 拒绝。新增签名记录 `readmit-node`，用当前根重新确认既有成员：接入中继流程（网页与 `tmex relay enroll`）在切换前会为每个过期成员签一条，中继状态卡片显示待确认数量并提供「重新确认成员」按钮，`GET /api/mesh/relay/readmit/prepare` 列出清单。该记录有版本门，需要全部节点升到 1.1.26。

---

# 1.1.25

_2026-09-04_

## English

### New

- **Chat commands.** Telegram bots and Weixin accounts share one command layer. Turn on “Allow chat commands” for a bot, and authorized chats can run `help`, `status`, `nodes`, `devices`, `windows`, `panes`, `tail`, `run`, `approve` and `deny` on the node that hosts the bot. Command parsing, node targeting, output chunking and permissions live in one place, so adding another platform (e.g. DingTalk) only needs an adapter. Commands run on the local node; `--node <name>` on a remote node returns a clear “not supported” reply. In Telegram groups only the user who bound the chat may issue commands.
- **Hub password join with TOTP.** `tmex hub join <url> --password --totp <code>` (or `TMEX_TOTP`, or `totpCode` in the Connect-to-Hub form). Passkey-only accounts no longer fail: the node joins and waits as “Pending” in Node management, where a signed-in browser can admit it with one click.
- **Enrollment fan-out.** A relay join code is now registered on every configured relay, and only relays that accepted it are encoded into the code; sealed packs are uploaded to every relay.
- **Docker node image.** `scripts/docker-node/` builds a container that installs with the CLI (`--no-service`) and can be upgraded from the web UI like any other node.

### Fixes

- Node management no longer flashes “Cannot connect to Hub” while the first Hub probe (and silent login) is still running; it shows “Connecting to Hub…” instead.
- The “node too old” terminal notice names the node (e.g. `demo-app`) instead of an id prefix.
- Leaving a `relay,node` machine back to relay-only removes the machine’s own tenant from its relay instead of leaving a ghost.
- Version gates now read peer versions on plain nodes and in relay mode (`peer_cache.version`), never block on the local node’s own certificate, and no longer bypass `rotate-root-keep` in relay mode.
- A relay-only process no longer starts Telegram/Weixin polling; device connection alerts reach Weixin too and respect per-bot notification settings; agent notifications name the node and link to `/n/<node>/…` for remote sessions.

---

## 中文

### 新增

- **聊天指令。**Telegram 机器人与微信账号共用一套指令层。给机器人打开「允许聊天指令」后，已授权会话可在托管该机器人的节点上执行 `help`、`status`、`nodes`、`devices`、`windows`、`panes`、`tail`、`run`、`approve`、`deny`。解析、节点定位、分段与权限集中在一处，后续接入钉钉等平台只需实现适配器。指令只在本机节点执行，`--node <名字>` 指向远端节点时会明确回复不支持。Telegram 群聊中只有完成绑定的那位用户可以下指令。
- **Hub 密码加入支持 TOTP。**`tmex hub join <url> --password --totp <code>`（或环境变量 `TMEX_TOTP`、「接入 Hub」表单里的验证码）。仅通行密钥的账号不再失败：节点先加入并在节点管理里显示「待批准」，已登录的浏览器可一键批准。
- **加入码扇出。**中继加入码现在会登记到所有已配置的中继，只把接受了的中继编进加入码；密封包也会上传到每一台中继。
- **Docker 节点镜像。**`scripts/docker-node/` 构建的容器用 CLI（`--no-service`）安装，可像普通节点一样从网页升级。

### 修复

- 节点管理在首次探测 Hub（含静默登录）期间不再误报「无法连接到 Hub」，改为显示「正在连接 Hub…」。
- 「节点版本过低」的终端提示显示节点名（如 `demo-app`）而不是编号前缀。
- `relay,node` 退回纯中继时会删除本机在自己中继上的租户，不再留下幽灵租户。
- 版本门在纯节点与中继模式下改读对端版本（`peer_cache.version`），不再因本机自身证书阻塞，也不再在中继模式下绕过 `rotate-root-keep`。
- 纯中继进程不再启动 Telegram/微信轮询；设备连接告警也会发到微信并遵守每个机器人的通知设置；agent 通知带节点名，远端会话链接指向 `/n/<节点>/…`。

---

# 1.1.24

_2026-09-04_

## English

### New

- **Join with a password.** A second machine now joins an existing mesh with just an address and the mesh account password — no join code to copy. Hub mode: Hub URL + password (`tmex hub join <url> --password`, or the “Connect to Hub” form in Settings → Nodes → This machine). Relay mode: relay URL + tenant id + password (`tmex relay join <url> --tenant <id>`, or the “Connect to relay” form). The relay keeps a per-tenant sealed pack that only the account password can open; the relay itself cannot read it. Join codes remain available under “Advanced”.
- **Relay roles on this machine.** The role selector in Settings → Nodes → This machine now offers all five roles: standalone, node, Hub + node, relay + node, and relay only. “This machine as a relay” asks for the public address and a tenant password (pre-generated; every password field now has a Generate button). A `relay,node` machine can enroll to its own relay, and can drop back to relay-only while keeping its tenants.
- **Uplink tabs.** Whether this machine connects to a Hub or to a relay is now chosen on the This machine card with two tabs — “Connect to Hub” / “Connect to relay” — each showing only what applies. Relay actions (add, re-enter password, remove, rotate metadata key, leave) are visible buttons instead of a hidden menu; node management keeps just the node table and join codes.
- **Rename nodes in relay mode.** Renaming another node now works without a Hub via a signed `rename-node` record.
- The Connect-devices guide describes the password flow and shows the tenant id to copy; the relay status shows round-trip time, node usage against the quota, and the operator page shows total node usage. `tmex relay list` no longer asks for a password on the local machine.

### Fixes

- The terminal's minimum peer version is now 1.1.23, the version that actually speaks the current state stream — 1.1.22 was never interoperable. When a peer is too old, the message now says which side it is: the node (named by id) and its version, the Gateway and its version, or this page, which just needs a reload. The notice also stops repeating on every reconnect.
- Relay: a kicked or rotated token can no longer keep an already-open link alive; joining with a password is refused unless the relay is in the root-signed relay list; KDF parameters from a relay are bounded before any key derivation; leaving a `relay,node` machine cleans up the relay environment keys.
- Relay peers now record their version, so version gates apply in relay mode too. Health probes and enrollment to your own relay use the loopback address, so a `relay,node` machine behind NAT works.

---

## 中文

### 新增

- **用密码加入。**第二台机器现在只需地址加 mesh 账户密码即可加入既有 mesh，无需复制加入码。Hub 模式：Hub 地址 + 密码（`tmex hub join <url> --password`，或设置 → 节点 → 本机 →「接入 Hub」表单）；中继模式：中继地址 + 租户编号 + 密码（`tmex relay join <url> --tenant <id>`，或「接入中继」表单）。中继替每个租户保管一份只有账户密码能解开的密封包，中继自己无法读取。加入码仍保留在「高级」里。
- **本机的中继角色。**设置 → 节点 → 本机的角色下拉现在提供全部五种角色：单机、节点、Hub 兼节点、中继兼节点、纯中继。「本机作为中继」只需填公网地址与接入口令（默认已生成，所有口令输入框都带「生成」按钮）。中继兼节点可以接入自己的中继，也可以退回纯中继并保留租户。
- **接入方式标签页。**本机接 Hub 还是接中继，改在本机卡片上用「接入 Hub」/「接入中继」两个标签页选择，各自只显示相关内容。中继操作（追加、重新输入口令、移除、轮换元数据密钥、离开）改为可见按钮；节点管理只保留节点表与加入码。
- **中继模式下改名。**无需 Hub 也能改其它节点的名字（签名的 `rename-node` 记录）。
- 「接入设备」引导改为密码加入流程并显示可复制的租户编号；中继状态显示延迟与节点占用/配额，运营者页显示节点占用总数；本机执行 `tmex relay list` 不再要求密码。

### 修复

- 终端的最低对端版本改为 1.1.23——真正能跑当前状态流的是这一版，1.1.22 从来就互通不了。对端过旧时提示会说明是哪一端：节点（点名节点编号）及其版本、Gateway 及其版本，或本页面（刷新即可）。该提示也不再随每次重连重复弹出。
- 中继：被踢或已换代的令牌不能再让已建立的链路存活；用密码加入时中继必须在根签名的中继列表里；中继给出的 KDF 参数会在派生密钥前做预算检查；中继兼节点退出时会一并清掉中继环境键。
- 中继对端现在记录版本，版本门禁在中继模式下同样生效；健康探测与接入自己的中继走回环地址，NAT 后的中继兼节点也能用。

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
