# 2.3.6

_2026-09-13_

## English

- **TURN reachability is per-relay, not fleet-wide.** Members’ `turn_ok` reports are bucketed by relay URL. The settings chip and `vibeterm relay list` TURN column now say whether *this machine* can reach that TURN versus how many other nodes can (`N/M`). A timeout on a TUN/proxy host is the local policy dropping outbound UDP (KI-15), not a dead TURN; the chip reads “unreachable here · N/M nodes reachable”.
- **Nodes table.** Opening the row “more” menu no longer crashes. Pause / Resume live in that menu and in the bulk menu. You cannot newly pause this machine, a hub, or the node the UI is currently forwarded through; a hub paused on 2.3.5 can be resumed after upgrade.
- **Local-machine inbound ports.** The heading follows role (“ports this machine / Hub / relay must open”), with a legend, a red ring on blocked, “—” for rows that were not probed, and Re-check on this machine.
- **Copy mode.** The two options sit side by side; the button item is “Copy via button” (finish the selection, then click Copy). Keyboard shortcuts are unchanged.
- **CLI coverage.** New client group `vibeterm agent` (sessions, send / steer / queue, confirm, model). `nodes` gains hub-role, tenant relay ls/switch/rm/readmit, ports, upgrade cancel / `--ids`, op clear. `settings` gains passwd / totp / passkey / local-auth / telegram / weixin / `system update-check` (`local direct` honours `--node`). Local `relay metrics`. `tmux move|break|order-*`, `devices disconnect` / `folders rename|reset`, `files mkdir` / `roots enable|disable` / `browse`.
- **Port reachability backend.** Cloud hosts behind 1:1 DNAT (only a private interface address) now also advertise `ws://<public IPv4>:<peer port>/peer`, derived from the STUN mapped address or `VIBETERM_PEER_PUBLIC_HOST`, so peers can probe and dial the public port. A `refused` probe turns the dot red at once; `timeout` needs two strikes. Re-check on this machine bumps `peer_reach_epoch` so peers re-probe within 30 s instead of the 5-min cadence. Relay / hub hosts get derived rows for `public-https` (members online) and TURN control / allocation range (members' TURN tally).

## 中文

- **TURN 可达性按中继分桶。** 成员 `turn_ok` 按中继 URL 统计。设置页 chip 与 `vibeterm relay list` 的 TURN 列写清「本机」与「舰队」：本机不通、其它节点仍可达时显示「本机不可达 · N/M 节点可达」。TUN/代理主机上的 timeout 是本机策略丢掉境外 UDP（KI-15），不是中继 TURN 挂了。
- **节点表。** 行内「更多」改为下拉菜单，不再因打开详情而死循环。暂停 / 恢复收进行菜单与批量菜单。不能新暂停本机、Hub、当前正在转发的节点；2.3.5 上被暂停的 Hub 升级后可以恢复。
- **本机卡入站端口。** 标题随角色（本机 / Hub / 中继需开通端口），带图例；红灯加 ring；未探测的行画「—」；本机可重新检测。
- **复制方式。** 两项并排；按钮项改名为「点击按钮后复制」（选区完成后再点复制）。快捷键复制不受此开关影响。
- **CLI 覆盖。** 新增客户端组 `vibeterm agent`（会话、send / steer / queue、confirm、model）。`nodes` 补 hub-role、租户侧 relay ls/switch/rm/readmit、ports、upgrade cancel / `--ids`、op clear。`settings` 补 passwd / totp / passkey / local-auth / telegram / weixin / `system update-check`（`local direct` 尊重 `--node`）。本机 `relay metrics`。`tmux move|break|order-*`、`devices disconnect` / `folders rename|reset`、`files mkdir` / `roots enable|disable` / `browse`。
- **端口可达性后端。** 只有内网地址的云主机（1:1 DNAT）现在额外广播 `ws://<公网 IPv4>:<peer 端口>/peer`（取自 STUN 映射地址或 `VIBETERM_PEER_PUBLIC_HOST`），对端据此探测并可直连公网口。`refused` 一次即红，`timeout` 两击才红。本机「重新检测」抬高 `peer_reach_epoch`，对端 30 s 内重探，不再等 5 min 周期。中继 / Hub 主机的 `public-https`（成员在线）与 TURN 控制口 / 分配段（成员 TURN 统计）派生出状态行。

# 2.3.5


_2026-09-13_

## English

- **Answerer-requested direct-link re-roll.** When the NAT'd answerer sees live DC / ws-secure RTT well above the peer's best-path memory (typically TCP-connect to the offerer's public 39001) and the peer advertised `reroll`, it sends `link.reroll-request`; the offerer re-dials the same make-before-break path (`reason=peer-request`). Both sides keep the 3/hour budget. 2.3.1 peers never advertise `reroll` and never receive the ctl.

- Re-roll results are judged by the new link's minimum RTT (not the EWMA, which the stream re-home replay inflates), and a link must be 60 s old before it can be re-rolled (was 20 s).

## 中文

- **应答侧可请求重拨直连。** NAT 后的应答侧若发现 live DC / ws-secure 明显慢于该对端最佳路径（通常是对 offerer 公网 39001 的 TCP connect），且对端报过 `reroll`，则发 `link.reroll-request`，由 offerer 走同一条 make-before-break 重拨（`reason=peer-request`）。两端预算仍各 3 次/小时。2.3.1 对端不报 `reroll`，不会收到该 ctl。
- 重掷结算改用新链路的最小 RTT（EWMA 会被搬流回放冲高），链路存活 60 s 后才参与重掷判定（原 20 s）。

# 2.3.4

_2026-09-13_

## English

### Fixes

- **Path sampling ignores TCP handshakes terminated by a local TUN/proxy.** A machine behind Surge/mihomo-style fake-IP proxies completed TCP connects locally in a few ms; 2.3.2 recorded those as the "best path" and wrongly re-raced healthy relay uplinks and direct links. Connects to fake-IP addresses are no longer sampled, and a TCP sample below 50 % of the real link RTT is discarded (already recorded ones are purged when a real heartbeat/DC sample arrives).

## 中文

### 修复

- **路径抽样剔除被本机 TUN/代理就地终结的 TCP 握手。** Surge/mihomo 一类 fake-IP 代理会在本机几毫秒内完成 TCP connect，2.3.2 把它记成「最佳路径」，误把健康的中继上行与直连判为劣化并重连。现在 fake-IP 对端不记样本，低于真实链路 RTT 50% 的 connect 样本丢弃，真实心跳/DC 样本到来时清除已记的假样本。

# 2.3.2

_2026-09-13_

## English

### Ports

- **All VibeTerm UDP lives in 40000–40099.** Built-in TURN control is UDP 40000 (was 3478), allocations 40001–40049 (was 49160–49259); ICE on a relay host is 40050–40099 so it never overlaps TURN. Non-relay ICE stays 40000–40099. `init` writes the three keys by role; `upgrade` rewrites blank values and exact legacy defaults (`3478` / `49160-49259` / relay-host `40000-40099`) and prints “UDP unified to 40000-40099 — allow this range in the firewall”. Custom values and `0`/`off` are left alone. Default TURN allocation cap is clamped to the range size (`max_alloc=49`). Public STUN `:3478` is unchanged.

### Path selection

- **WebSocket open race.** Peer ws-secure, hub uplink and relay uplink open `VIBETERM_WS_DIAL_RACE` sockets at once (default 2, clamp 1..4) and keep the first to `open`; losers close before any byte is sent. LAN targets do not race. Peer inbound handshake limit is 30/IP/min.
- **Slow-path re-roll on direct links.** When live DC or ws-secure RTT is above `max(1.5×best, best+40ms)` versus the peer’s 30-minute best-path memory, the offerer dials a new 5-tuple (DC needs the `reroll` hello cap; 2.3.1 peers never get a re-roll offer). Make-before-break; streams re-home at ≥30% gain. `VIBETERM_DC_REROLL=off` disables.
- **ws-secure re-roll skip.** Yields only when a DC dial is in flight, `state.upgrading` is set, or the upgrade coordinator has already coalesced/scheduled that peer (breaker health is not a skip). Shares the in-flight ws slot with foreground dials; a session that is no longer live is closed with `reroll-stale`.
- **Uplink path sampling.** Every 5 min the node TCP-connects each public hub/relay host three ways (30 min TTL). Three consecutive slow idle heartbeats close the live link with `path-rerace` (no failure / no backoff) and re-dial through the open race. `VIBETERM_UPLINK_PATH_SAMPLING=off` disables. `vibeterm relay list` grows a `BEST` column; `GET /api/mesh/relay/status` rows may include `pathBestMs` / `reraces`. `nodes` is unchanged.
- **Uplink re-race.** Sampling targets are configured relay rows ∪ hub candidates (hostname-deduped, read lazily each tick). Idle counts established streams + opens in flight + in-flight key-log ops. `re-race_result` is settled only by the first post-re-race generation of the same connection.

### Relay

- Adding or removing a secondary relay only refreshes candidates and attach slots (`[relay] targets updated … (no restart)`). Re-prioritising the primary while still attached to the old one drains and rebuilds; already attached to the new primary stays on the light path. Same-URL secondary credential rotation drops and respawns that slot.

### Terminal

- Selection toolbar anchors above/below the selection (`getSelectionViewportRect`). Touch copy uses a gesture-machine bypass plus `pointerup`. Settings → Terminal “copy mode” (`terminalCopyMode` in `vibeterm-ui`, default `button`): copy on commit, or via the button.

### Fixes

- Three-way TCP probes now merge verdicts deterministically (all `refused` → `refused`, otherwise `timeout`), independent of completion order.

### Upgrade notes

- Allow UDP **40000–40099** on every node’s firewall / security group (replaces 3478 + 49160–49259 on relays). Custom TURN/ICE ports are not rewritten.

## 中文

### 端口

- **全部 VibeTerm UDP 落在 40000–40099。** 内置 TURN 控制口 40000（原 3478）、分配段 40001–40049（原 49160–49259）；中继主机 ICE 为 40050–40099，与 TURN 错开。非中继 ICE 仍是 40000–40099。`init` 按角色写入三键；`upgrade` 只改写空值与恰好等于旧默认的项（`3478` / `49160-49259` / 中继主机 `40000-40099`），结束提示「UDP 已统一为 40000-40099，请在防火墙放行该段」。自定义与 `0`/`off` 不动。默认 TURN 分配上限夹紧到段大小（`max_alloc=49`）。公网 STUN `:3478` 不变。

### 网络路径优选

- **WebSocket 开链竞速。** peer ws-secure / hub / 中继上行同时开 `VIBETERM_WS_DIAL_RACE` 条（默认 2，夹紧 1..4），取最先 `open` 的一条，其余不发字节即关。局域网不竞速。peer 入站握手限流 30/IP/min。
- **直连慢路径重掷。** live DC / ws-secure 的 RTT 高于该对端 30 min 窗内 best（`max(1.5×best, best+40ms)`）时，offerer 再拨一条新五元组（DC 需对端报 `reroll` 能力位；2.3.1 对端不会收到重掷 offer）。make-before-break；提升 ≥ 30 % 时搬流。`VIBETERM_DC_REROLL=off` 关闭。
- **ws-secure 重掷让路。** 仅在 DC 拨号在途、`state.upgrading` 已置或升级协调器已 coalesced/scheduled 时让路（熔断健康不算）。与前台 ws 拨号共享在途槽；live 已换人则以 `reroll-stale` 关闭，不二次记预算。
- **上行路径采样。** 每 5 min 对每条公网 hub/中继主机三路 TCP connect（30 min TTL）。连续 3 次空闲心跳偏慢则以 `path-rerace` 关链（不计失败、不退避）并走开链竞速重连。`VIBETERM_UPLINK_PATH_SAMPLING=off` 关闭。`vibeterm relay list` 增 `BEST` 列；`GET /api/mesh/relay/status` 行可选 `pathBestMs` / `reraces`。`nodes` 不变。
- **上行重赛。** 采样目标为已配置中继行 ∪ hub 候选（hostname 去重，每拍懒读）。空闲计入已建立流 + 建流中 + 在途密钥日志操作。`re-race_result` 只由同一连接重赛后第一代结算。

### 中继

- 增删副中继只刷新候选与挂载（`[relay] targets updated … (no restart)`）。主中继被重排但仍挂旧主则排空重建；已挂新主走轻路径。同 URL 副中继凭证轮换拆 slot 重挂。

### 终端

- 选区工具条锚在选区上/下方（`getSelectionViewportRect`）。触屏复制走手势机旁路 + `pointerup`。设置 → 终端「复制方式」（`terminalCopyMode`，持久化 `vibeterm-ui`，默认 `button`）：选中即复制，或点按钮复制。

### 修复

- 三口并发 TCP 探测的失败裁决改为确定性合并（全 `refused` 才 `refused`，否则 `timeout`），不再取决于完成顺序。

### 升级说明

- 在每台节点的防火墙 / 云安全组放行 UDP **40000–40099**（取代中继上的 3478 + 49160–49259）。自定义 TURN / ICE 端口不会被改写。

# 2.3.1

_2026-09-12_

## English

### Features

- **Pause / resume nodes.** Settings → Nodes gains an inline Pause / Resume action per node. A paused node stays in the management table (tagged "Paused") and can still be upgraded, uninstalled or resumed, but this entry no longer opens links to it and hides it from the sidebar devices / files sections, the devices page, transfer / port-map / share targets, notification aggregation and "upgrade all". The preference is local to the entry node (`node_local_prefs`), never written to the hub roster, relay lists or the key log. API: `POST /api/mesh/nodes/:id/pause|resume`, `GET /api/mesh/nodes[].paused`, optional `paused` on `NODE_EVENT`; CLI `vibeterm nodes pause|resume`, `nodes ls` PAUSED column, `nodes upgrade --all` skips paused nodes.
- **One port plan for every role.** Defaults now live in a single shared module (`@vibeterm/shared/net`): peer 39001/tcp, P2P (ICE) 40000–40099/udp, TURN 3478/udp + 49160–49259/udp, public HTTPS 443, gateway 9883, built-in TLS 9443. `vibeterm init`, `hub join`, `relay join`, `install.sh` and `doctor` print the same list for the machine's role; `GET /api/local/status.portPlan` exposes it; the connect-devices guide gains an "Open ports" step on the hub-host, relay-host and join paths.
- **Port reachability detection.** The entry probes each peer's advertised public peer port (TCP, every 5 min, two consecutive failures before "blocked"), infers ICE UDP reachability from srflx / DataChannel history, and members report what they saw about each other (`peer_reach` / `turn_ok`, optional fields in the relay status blob and hub `node.status`) so a node's own row shows whether its ports are reachable from outside. `GET /api/mesh/nodes[].ports`, `POST /api/mesh/nodes/:id/ports/probe`; the nodes table shows an "Unreachable ports: …" warning, the node detail dialog has a port table with Re-check, the local machine card lists inbound ports with status, and the relay TURN tile shows "reachable from N/M members".
- **Upgrade converges the fleet.** The upgrade transaction writes `VIBETERM_RTC_PORT_RANGE=40000-40099` when the key is missing (custom values are kept; relay roles also get the TURN keys), backs up `app.env` and prints the firewall reminder. **After upgrading, allow UDP 40000–40099 on every node's firewall / security group**, otherwise WAN direct links fall back to relay.

### Performance (high-latency / lossy networks)

- First link to a remote node: when the peer is known online on a relay, the relay stream is dialled in parallel with the direct race instead of after it; the foreground DataChannel budget joins the adaptive nested budget and a peer with no RTT sample is budgeted as 800 ms, not LAN; `/n/:id/ws` upgrades to 101 first and closes with 1011 (`node-unreachable` / `forward-link-timeout`) when the link fails — never 4401. First 503 back-off in the browser drops from 60 s to 2–5 s (timeout) / 15 s (hard failure). Failover stale-input TTL and first HELLO wait follow the same adaptive formula as the client.
- Opening a remote node: the route gate trusts the cached node row (`loggedIn`) instead of waiting for the node list; login chunk, session-key restore and challenge run in parallel (fan-out ≤ 3); access-gate probe reuses the in-flight `auth/mode` request.
- Direct link: `HELLO_S2C` carries `connection-id:<id>` (no `GET connection` round trip), `rtc-config` is fetched from the entry and in parallel, so ICE starts after one forwarded request instead of three serial ones; an attempt no longer fails while `/mesh/ws` is still connecting; `/mesh/ws` has an application-level PING/PONG (zombie detected in seconds after a network switch) and `pageshow` / visibility resume retries the direct link.
- First frame: `HELLO_C2S` can carry the screen intent (`hello-screen-intent-v1`) so the gateway answers HELLO + screen in one burst, and placeholder subscriptions (epoch 0) are rewritten to the current epoch instead of rejected — typing works right after the first frame. Both directions stay compatible with 2.3.0 shells and gateways.
- Files sidebar: remote sections are collapsed by default (no WebSocket until expanded), secondary queries are deferred, root fetches capped at 2, no refetch on window focus. History paging grows toward 1 MiB at high RTT. iOS Wi-Fi ↔ cellular switches are detected in 2–6 s via `pageshow` / visibility / offline / timer-drift signals. Settings General tab is prefetched. The lazy precache tier is no longer installed when the browser gives no network hint (iOS).

### Fixes

- **Built-in TURN binds to the primary outbound address** (`VIBETERM_TURN_BIND_HOST=auto|<IPv4>|0.0.0.0`). With `0.0.0.0`, hosts running a TUN proxy (mihomo / clash `auto-route`) routed the replies into the tunnel with a fake-IP source, so every member's TURN probe timed out silently. Discovery skips fake-IP / CGNAT addresses and prefers physical interfaces over bridges, veth and TUN devices; `EADDRNOTAVAIL` falls back to the wildcard with a warning. `doctor`, logs and `GET /api/relay/status` show the bind host.

### Upgrade notes

- Allow UDP 40000–40099 (and, on relays, UDP 3478 + 49160–49259) in every node's firewall / cloud security group. Upgraded nodes without a custom `VIBETERM_RTC_PORT_RANGE` switch from OS-ephemeral ICE ports to this fixed range.
- Relay operators behind a TUN proxy no longer need any manual routing change; members' TURN probes turn green once the relay is on 2.3.1.

## 中文

### 新功能

- **节点暂停 / 恢复。**设置 → 节点新增行内「暂停 / 恢复」。已暂停节点保留在管理表（标「已暂停」），仍可升级、卸载、恢复；本入口不再向它发起连接，侧栏设备 / 文件、设备页、传输 / 端口映射 / 分享目标、通知汇聚与「全部升级」均不包含它。偏好只存入口本机（`node_local_prefs`），不进 hub 花名册、中继列表或密钥日志。接口 `POST /api/mesh/nodes/:id/pause|resume`、`GET /api/mesh/nodes[].paused`、`NODE_EVENT` 可选 `paused`；CLI `vibeterm nodes pause|resume`、`nodes ls` PAUSED 列、`nodes upgrade --all` 跳过已暂停节点。
- **统一端口计划。**默认值收口到共享模块 `@vibeterm/shared/net`：peer 39001/tcp、P2P（ICE）40000–40099/udp、TURN 3478/udp + 49160–49259/udp、公网 HTTPS 443、网关 9883、内置 TLS 9443。`vibeterm init`、`hub join`、`relay join`、`install.sh`、`doctor` 按角色打印同一份清单；`GET /api/local/status.portPlan` 下发；接入向导在 Hub 宿主、中继宿主与加入路径新增「放行端口」步。
- **端口可达性检测。**入口对各对端公开的 peer 口做 TCP 探测（5 分钟一次，连续两次失败才判不可达），按 srflx / DataChannel 历史推断 ICE UDP 段，成员之间互报观测结果（中继状态 blob 与 hub `node.status` 的可选字段 `peer_reach` / `turn_ok`），本机行因此能显示自己的端口是否可被外部访问。`GET /api/mesh/nodes[].ports`、`POST /api/mesh/nodes/:id/ports/probe`；节点表显示「端口不可达：…」警告，节点详情有端口表与「重新检测」，本机卡列出入站端口与状态，中继 TURN 磁贴显示「成员可达 N/M」。
- **升级收敛舰队端口。**升级事务在缺键时写入 `VIBETERM_RTC_PORT_RANGE=40000-40099`（自定义值保留；中继角色补 TURN 键），备份 `app.env` 并在结束时提示放行防火墙。**升级后请在每台节点的防火墙 / 安全组放行 UDP 40000–40099**，否则公网直连回落中继。

### 性能（高延迟 / 弱网）

- 远端首链：对端在中继在线时，中继流与直连竞速并行而非排在其后；前台 DataChannel 预算并入自适应嵌套预算，无 RTT 样本按 800 ms 而非局域网档；`/n/:id/ws` 先 101 再取链，取链失败以 1011（`node-unreachable` / `forward-link-timeout`）关闭而非 4401。浏览器首次 503 退避从 60 s 降到 2–5 s（超时）/ 15 s（硬失败）。failover 的陈旧输入 TTL 与首次 HELLO 等待与客户端同一自适应公式。
- 打开远端节点：路由门闸认首帧缓存行（`loggedIn`），不再等节点列表；登录 chunk、会话钥恢复与 challenge 并行（扇出 ≤ 3）；access-gate 探针复用在途 `auth/mode`。
- 直连：`HELLO_S2C` 捎带 `connection-id:<id>`（省掉 `GET connection`），`rtc-config` 改打入口并与查找并行，ICE 前的转发请求从 3 次串行降到 1 次；`/mesh/ws` 未就绪不再让协商失败；`/mesh/ws` 应用层 PING/PONG（切网后数秒内发现僵尸连接），`pageshow` / 可见恢复时重试直连。
- 首帧：`HELLO_C2S` 可携带首屏意图（`hello-screen-intent-v1`），网关在同一批回 HELLO 与画面；占位订阅（epoch 0）由网关改写为当前 epoch 而非拒绝，首帧后即可打字。与 2.3.0 壳 / 网关双向兼容。
- 文件侧栏：远端分节缺省折叠（展开才建 WebSocket），次要查询延后、根目录并发 2、不在窗口聚焦时重取。历史翻页在高 RTT 下页大小提到 1 MiB。iOS Wi-Fi ↔ 蜂窝切换 2–6 s 内发现（`pageshow` / 可见性 / offline / 计时漂移）。设置「通用」页预取。浏览器无网络提示（iOS）时不再安装懒加载预缓存层。

### 修复

- **内置 TURN 绑定主出站地址**（`VIBETERM_TURN_BIND_HOST=auto|<IPv4>|0.0.0.0`）。绑 `0.0.0.0` 时，跑 TUN 代理（mihomo / clash `auto-route`）的宿主会把回包路由进隧道并以 fake-IP 源地址发出，所有成员的 TURN 探测静默超时。自动发现跳过 fake-IP / CGNAT 地址，物理网卡优先于网桥、veth 与 TUN；`EADDRNOTAVAIL` 回退通配并告警。`doctor`、日志与 `GET /api/relay/status` 显示绑定地址。

### 升级说明

- 在每台节点的防火墙 / 云安全组放行 UDP 40000–40099（中继另放行 UDP 3478 + 49160–49259）。未自定义 `VIBETERM_RTC_PORT_RANGE` 的节点升级后 ICE 从系统临时端口切到该固定段。
- 位于 TUN 代理后的中继无需再改路由；中继升到 2.3.1 后成员的 TURN 探测即恢复。

# 2.3.0

_2026-09-12_

## English

### Features

- **The relay now runs its own TURN server.** Deploying a relay (`relay` / `relay,node`) automatically starts a built-in STUN/TURN server on UDP 3478 (`VIBETERM_TURN_PORT`, `0`/`off` disables) with relayed ports 49160–49259 (`VIBETERM_TURN_RELAY_PORT_RANGE`). Credentials are generated and persisted automatically, the public IPv4 is discovered from the relay's public URL (DoH-aware) or a STUN self-probe (`VIBETERM_TURN_EXTERNAL_IP` / `VIBETERM_TURN_HOST` override), and the `turn:<ip>:<port>?transport=udp` entry is distributed to members with the existing `relay.list`. The old `VIBETERM_TURN_URL/_USERNAME/_CREDENTIAL` triple still works as an *external* TURN and disables the built-in one. `vibeterm relay status`, `vibeterm doctor`, `GET /api/relay/status` and the relay management page show the TURN state; `init`/`install.sh` print the UDP ports to open. **Open UDP 3478 and UDP 49160–49259 on the relay host's cloud security group / firewall.**
- **Nodes stay attached to every relay and pick the best one per peer.** With two or more relays, a node keeps a live uplink to all of them: the existing one is the *primary* (key-log authority, roster source, target of "set as primary"), the others are *secondaries* (presence, inbound streams, signalling). Each peer link is opened through the relay with the lowest `rtt(self, relay) + rtt(peer, relay)` (nodes advertise their relay RTT in the status blob), so two nodes in China talk via the Chinese relay while a cross-border pair picks whichever is faster. Nodes that are only visible on one relay stay online; a relay outage only affects peers exclusive to it. `GET /api/mesh/relay/status` rows gain `role` / `online` / per-row `rttMs` / `peersOnline` / `turn` (+ `multiAttach`), `/api/mesh/nodes` and `NODE_EVENT` gain `viaRelay` / `relayPresence`, `vibeterm relay list` gains ROLE / PEERS / TURN columns, and the relay strip in Settings shows every relay with its RTT and a "set as primary" action.
- **TURN handling on nodes.** Every advertised TURN server is probed; only reachable ones (at most 2, best RTT first) are handed to ICE, and ICE UDP mux is only disabled when a reachable TURN is included — an unprobed or unreachable TURN can no longer stall candidate gathering. `GET /api/mesh/rtc-config` now returns `turn` / `turnConfigured` as arrays plus `turnProbes`.

### Fixes

- **A DataChannel upgrade no longer kills the relay session you are using.** When a direct link came up, the still-active relay/WS stream was reset immediately (`replaced`), dropping terminals that then had to reconnect. The old session is now drained make-before-break: new streams go to the new link, the old one closes only once its inner streams are gone (30 min hard cap).
- **`dc handshake receive queue overflow` fixed.** The offerer flooded a `hello` every 40 ms into an 8-slot queue that the answerer only attached after the channel opened, so a peer that connected 1–2 s earlier always overflowed it. The receive queue is attached first, hellos are resent every 500 ms and deduplicated by type, the queue holds 64 entries, and control frames that arrive mid-handshake are re-injected in order.
- Fake-IP (`198.18.0.0/15`) ICE host candidates from proxy TUN interfaces are dropped on both sides.
- Peer RTT is measured with a `sentAt` echo (no longer inflated by the sender's own queue), smoothed with an EWMA and a spike guard; the dial budget uses the median of live links instead of the global maximum, so one congested link no longer slows every new dial.
- Idle DataChannels are kept for 30 minutes (relay/WS links still 5). Peers whose direct dial is permanently impossible (`no_srflx` etc.) or whose breaker is disabled are no longer re-dialed by the background upgrade scan every 15 s (60 min hold / until re-arm).
- Built-in TURN hardening: oversized peer datagrams are dropped instead of crashing the handler, per-allocation permission caps, and rate-limited unauthenticated replies.

### Upgrade notes

- Upgrade the relay(s) first, then the nodes. Open UDP 3478 + 49160–49259 on the relay host; remove the old `VIBETERM_TURN_*` triple from the relay's `app.env` if you want the built-in TURN (an external coturn is no longer needed).
- Adding a second relay: `vibeterm relay enroll <https-url>` on any member; nodes attach to both automatically after the update.

---

## 中文

### 新功能

- **中继自带 TURN 服务器。** 部署中继（`relay` / `relay,node`）即自动在 UDP 3478 起内置 STUN/TURN（`VIBETERM_TURN_PORT`，`0`/`off` 关闭），中继端口段 49160–49259（`VIBETERM_TURN_RELAY_PORT_RANGE`）。凭据自动生成并持久化；公网 IPv4 由中继公网 URL（DoH 解析）或 STUN 自探得到（`VIBETERM_TURN_EXTERNAL_IP` / `VIBETERM_TURN_HOST` 可覆盖）；`turn:<ip>:<port>?transport=udp` 随原有 `relay.list` 下发。旧的 `VIBETERM_TURN_URL/_USERNAME/_CREDENTIAL` 三件套仍可用，视为**外部** TURN 并关闭内置。`vibeterm relay status`、`vibeterm doctor`、`GET /api/relay/status` 与中继管理页均显示 TURN 状态；`init`/`install.sh` 会提示要放行的 UDP 端口。**请在中继宿主的云安全组/防火墙放行 UDP 3478 与 UDP 49160–49259。**
- **节点同时挂载全部中继，按对端选最优中继。** 有两台以上中继时，节点与每台都保持上行：原来那台是**主中继**（密钥日志权威、花名册来源、「设为主中继」的目标），其余是**副中继**（在线状态、入站流、信令）。每条对端链路走 `rtt(本机, 中继) + rtt(对端, 中继)` 最小的那台（节点在状态块里上报自己到中继的 RTT）：两台都在国内就走国内中继，一内一外则按实测挑更快的。只在某一台中继上可见的节点照样在线；一台中继故障只影响仅在它上面的对端。`GET /api/mesh/relay/status` 行增加 `role` / `online` / 逐行 `rttMs` / `peersOnline` / `turn`（顶层 `multiAttach`），`/api/mesh/nodes` 与 `NODE_EVENT` 增加 `viaRelay` / `relayPresence`，`vibeterm relay list` 增加 ROLE / PEERS / TURN 列，设置页中继条显示每台中继的 RTT 与「设为主中继」。
- **节点侧 TURN 处理。** 每条下发的 TURN 都会探测；只有可达的（最多 2 条，按 RTT）交给 ICE，且只在纳入可达 TURN 时才关闭 ICE UDP mux——未探测或不可达的 TURN 不再卡死候选收集。`GET /api/mesh/rtc-config` 的 `turn` / `turnConfigured` 改为数组并新增 `turnProbes`。

### 修复

- **直连升级不再杀掉正在使用的中继会话。** 以前 DataChannel 一建立就立刻 reset 仍在用的 relay/WS 流（`replaced`），终端掉线重连。现在旧会话 make-before-break 排空：新流走新链路，旧链路等内层流走完才关（上限 30 分钟）。
- **修复 `dc handshake receive queue overflow`。** offerer 每 40 ms 狂发 `hello`，而 answerer 的 8 槽接收队列要等通道打开后才挂上，先连上 1–2 秒的对端必然把它灌爆。现在先挂接收队列、hello 每 500 ms 重发并按类型去重、队列 64 槽，握手期间到达的控制帧按序重注入。
- 丢弃代理 TUN 网卡产生的 fake-IP（`198.18.0.0/15`）ICE host 候选（收发两侧）。
- 对端 RTT 改为 `sentAt` 回显测量（不再被本端发送队列抬高），EWMA 平滑并忽略尖峰；拨号预算取活跃链路的中位数而非全局最大值，一条拥塞链路不再拖慢所有新拨号。
- 空闲 DataChannel 保留 30 分钟（relay/WS 仍为 5 分钟）。直连永久不可能（`no_srflx` 等）或熔断已禁用的对端，不再被后台升级扫描每 15 秒重拨（抑制 60 分钟 / 直到重新武装）。
- 内置 TURN 加固：超大 peer 报文丢弃而非崩溃、每 allocation 的 permission 上限、未认证应答限流。

### 升级说明

- 先升级中继，再升级节点。在中继宿主放行 UDP 3478 + 49160–49259；要用内置 TURN，请删掉中继 `app.env` 里旧的 `VIBETERM_TURN_*` 三件套（外部 coturn 不再需要）。
- 加第二台中继：在任一成员上 `vibeterm relay enroll <https-url>`，升级后节点会自动同时挂载两台。
