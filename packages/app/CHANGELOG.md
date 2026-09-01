# 1.1.7

_2026-09-01_

## English

### Features

- Multi-client terminals: when the same pane is open on several devices, the largest visible client now owns the tmux window size. Opening a pane on a phone no longer shrinks the desktop; the phone keeps the desktop geometry and pans it locally (single-finger drag pans, then falls through to scrollback; horizontal wheel pans on desktop). Keyboard and mouse input stay shared. Ownership moves to the next largest visible client when the owner hides or disconnects.
- Silent sign-in to other mesh nodes survives app relaunch: the browser session key is now a non-extractable WebCrypto Ed25519 key persisted in IndexedDB together with the root-signed delegation (18 h), so an installed PWA no longer asks for the password once per node after a cold start. TOTP-enabled password sessions and the `@noble` fallback stay memory-only; logout deletes the record. The Devices page attempts silent sign-in first and only shows "Sign in to this node" when it fails.

### Performance

- Remote node runtimes (WebRTC direct dialing, mesh connection/rtc-config/authorize requests, stats timers) are created only when the node is on screen: its sidebar section is expanded or its route is open. Sections have a disclosure toggle whose state is remembered per browser; Terminals sections default to collapsed, Files sections to expanded.
- Mesh node list polling is now a single poller that pauses while the page is hidden; the devices query waits for the node's sign-in gate.
- Static assets: hashed Vite bundles are served `immutable` for a year; other files get `no-cache` with ETag/Last-Modified and `304` support, so PWA launches stop re-downloading fonts and WASM.

### Fixes

- Files sidebar: devices from remote nodes were shown by default even though the "show in Files sidebar" switch was never enabled; the default now matches the terminal sidebar (this machine on, remote off; an explicit choice always wins). Node sections with no visible directories are no longer rendered.
- Sidebar drag-sort no longer scrolls the sidebar horizontally: sortable lists are restricted to the vertical axis and the sidebar viewports disallow horizontal scrolling.
- Public login hardening: the login rate limiter and the first-run bootstrap loopback check resolve the real client IP behind Cloudflare Tunnel / reverse proxies when `TMEX_TRUST_PROXY` is set; a request carrying `CF-Connecting-IP` is never treated as local.

## 中文

### 新功能

- 多客户端终端：同一 pane 在多台设备打开时，由最大的可见客户端持有 tmux 整窗尺寸。手机打开终端不再把电脑画面缩成手机比例；手机保留电脑几何并本地平移（单指拖动先平移、到边后回到 scrollback；桌面横向滚轮平移）。键盘与鼠标输入仍然共享；owner 隐藏或断开时尺寸交给下一个最大的可见客户端。
- 跨节点静默登录在应用重启后仍有效：浏览器会话钥改为不可导出的 WebCrypto Ed25519 私钥，与根钥签发的 delegation（18 小时）一起存入 IndexedDB，PWA 冷启动后不再每台节点各要一次密码。开启 TOTP 的密码会话与 `@noble` 回退路径仍只在内存；登出即删除。设备页对未登录节点先静默登录，失败才显示「登录此节点」。

### 性能

- 远端节点运行时（WebRTC 直连拨号、mesh connection/rtc-config/authorize 请求、统计定时器）只在节点出现在屏幕上时创建：侧栏分节展开或路由命中。分节新增展开开关并按浏览器记忆；终端页默认折叠、文件页默认展开。
- mesh 节点列表改为单一轮询，页面隐藏时暂停；设备查询等待节点登录门闸就绪。
- 静态资源：带哈希的 Vite 产物按 `immutable` 缓存一年，其余文件 `no-cache` + ETag/Last-Modified 并支持 `304`，PWA 启动不再重复下载字体与 WASM。

### 修复

- 文件侧栏：远端节点的设备在未开启「文件侧栏显示」时也默认显示；现与终端侧栏一致（本机默认显示、远端默认隐藏，显式选择永远优先），没有可见目录的节点分节不再渲染。
- 侧栏拖动排序不再横向滚动：排序列表限制纵轴，侧栏视口禁止横向滚动。
- 公网登录加固：设置 `TMEX_TRUST_PROXY` 时登录限流与首次 bootstrap 的本机判定按 Cloudflare Tunnel / 反向代理转发头解析真实客户端 IP；带 `CF-Connecting-IP` 的请求一律不视为本机。

# 1.1.6

_2026-09-01_

## English

### Features

- Settings → Node management: each node row gains an "Upgrade" action that upgrades that node (remote mesh nodes and this machine alike) to the latest release over the existing peer link. Progress survives the target's restart; success is confirmed by reading the node's version back, and a lost response is treated as "unconfirmed" instead of a false failure. Works even when the hub is offline, as long as the node is reachable.
- Crash-safe self-upgrade (BIOS-style): new versions land in `versions/<v>` and are boot-tested before an atomic `current` switch; a journal plus `tmex upgrade --repair` completes or rolls back interrupted upgrades after a crash or power loss at any point. Includes DB snapshot/rollback, a side-effect-free preflight runtime (no agents, notifications, tunnels or TLS during the boot test), process-ownership checks before any signal is sent, offline reuse of the native addon, and compatibility with 1.0.2/1.1.3 layouts. Rehearsed end-to-end under launchd (macOS) and systemd (Linux).
- Release integrity is now fail-closed: upgrades to 1.1.4+ require a matching `SHA256SUMS` entry (a missing manifest aborts); older targets need an explicit `--allow-unverified`.

### Fixes

- Sidebar: the bottom "Connect/Manage Devices" buttons sit flush with the outer frame's bottom edge and the tab switcher aligns with the terminal's top edge, giving the terminal list more room.
- Manage Devices: dragging a card only displaces its neighbors when it gets close (iOS-style proximity), instead of from across the page.
- Selection toolbar no longer blocks starting a new selection in the rows it covers — pressing anywhere on the terminal dismisses it and begins the new selection in the same gesture.
- Agent panel: the composer's write-mode switches could overflow and cover the send button in narrow panels; controls now wrap and truncate instead.

## 中文

### 新功能

- 设置-节点管理：每个节点新增「升级」操作，经现有 peer 链路把该节点（远端节点与本机均可）升级到最新版本。进度跨目标重启存活，成功以回读节点版本确认，响应丢失记为「结果未确认」而非误报失败；Hub 离线但节点可达时同样可用。
- 崩溃安全自升级（BIOS 式）：新版本先落在 `versions/<v>` 并预启动验证，通过后原子切换 `current`；journal + `tmex upgrade --repair` 可在任意时点断电/被杀后续完或回滚。含数据库快照/回滚、零副作用 preflight 运行时（预启动期间不跑 agent/通知/tunnel/TLS）、发信号前的进程归属校验、native 插件离线复用，以及 1.0.2/1.1.3 旧布局兼容。已在 launchd（macOS）与 systemd（Linux）双服务模式下完整演练。
- 发行完整性改为 fail-closed：升级到 1.1.4 及以上必须匹配 `SHA256SUMS`（清单缺失即中止）；更旧目标需显式 `--allow-unverified`。

### 修复

- 侧栏：底部「接入/管理设备」按钮组下缘与外层黑框齐平，顶部 tab 切换器与终端上缘对齐，终端列表显示空间更大。
- 管理设备：拖动卡片只在靠近时触发相邻卡片避让（iOS 式邻近判定），不再隔得很远就开始移位。
- 选择工具条不再挡住其覆盖行的新选择——在终端任意处按下即收起工具条并在同一手势里开始新选择。
- Agent 面板：窄面板下写入模式开关可能溢出遮住发送按钮；控件改为换行与截断。

# 1.1.5

_2026-09-01_

## English

### Fixes

- Switching terminals could leave the previous pane covering the new one until a page reload (hidden keep-alive slots used `visibility: hidden`, which the terminal mount re-enables on a descendant; slots now hide with `opacity` + `z-index`).

## 中文

### 修复

- 切换终端后右侧可能仍显示旧终端、刷新才恢复（保活槽的 `visibility: hidden` 会被终端挂载点在后代上反选；改用 `opacity` + `z-index` 隐藏）。

# 1.1.4

_2026-08-31_

## English

### Features

- Sidebar Files tab is now multi-node: one section per node (self first, then the other mesh nodes in the same order as the terminal sidebar), headed by the node name; remote nodes that are not signed in show a sign-in row instead of silently showing nothing. Node sections and the roots inside a section can be dragged to reorder (`PUT /api/files/roots/order`).
- Terminal header link badge: "Via hub" is now "Relay"; the connection details popover shows rows that apply to the actual link kind (reach, transport, RTT, connected-for; relay address and the reasons the last direct attempt failed for relay links; peer address for direct WebSocket links; ICE rows only for browser WebRTC) instead of a column of "unknown".
- `GET /api/mesh/nodes` carries `peerAddress`, `linkSinceAt`, `endpoints` and `directFailure` for each node.

### Performance

- Switching terminals: the gateway no longer waits a fixed 450 ms after `TERM_HISTORY` before releasing live output; live output now resumes right after history (median 515 ms → ~22 ms on single-pane windows, ~100 ms on split windows).
- Single-pane view keeps the three most recently viewed panes of a device mounted; switching back to one of them is a warm switch — no terminal reboot, no history replay (first content median ~90 ms → ~19 ms). Font loading no longer awaits when the fonts are already cached.
- Node-to-node direct dialing tries all advertised endpoints concurrently (same-subnet addresses first) instead of one after another with a 3 s timeout each.

### Fixes

- Terminal cursor no longer flickers between two cells while a TUI redraws at high frequency (the cursor layer now waits for the output to settle before moving).
- Removed the terminal toolbar "jump to latest" button (the keyboard-shortcut action remains).
- `tmex upgrade` rejects unknown options (and `--help` prints usage) instead of silently running an upgrade against the default install directory.

## 中文

### 新功能

- 侧栏「文件」改为多节点：每个节点一节（本机在前，其余节点顺序与终端侧栏一致），节头显示节点名；未登录的远端节点显示登录行而不是空白。节与节内目录都可拖动排序（`PUT /api/files/roots/order`）。
- 终端右上角链路徽标：「经 Hub 中转」改为「中转」；连接详情按链路种类给出适用的行（到达路径、承载、延迟、已连接时长；中转链路给出中转地址与最近一次未直连的原因；直连 WebSocket 给出对端地址；ICE 明细只在浏览器 WebRTC 直连时列出），不再出现一列「未知」。
- `GET /api/mesh/nodes` 每个节点增加 `peerAddress`、`linkSinceAt`、`endpoints`、`directFailure`。

### 性能

- 切换终端：网关不再在 `TERM_HISTORY` 之后固定等 450 ms 才放行实时输出（单 pane 窗口中位数 515 ms → 约 22 ms，分屏窗口约 100 ms）。
- 单 pane 视图保留设备最近查看的 3 个 pane 的终端实例，切回即热切换——不重建终端、不重放 history（首帧中位数约 90 ms → 约 19 ms）。字体已缓存时不再等待。
- 节点间直连改为对所有广播地址并发拨号（同网段优先），不再逐个等待 3 s 超时。

### 修复

- TUI 高频刷新时终端光标不再在两格之间狂闪（光标层等输出静默后再落笔）。
- 删除终端工具栏的「回到底部」按钮（快捷键动作保留）。
- `tmex upgrade` 拒绝未知参数（`--help` 打印用法），不再静默对默认安装目录执行升级。

# 1.1.3

_2026-08-31_

## English

### Features

- "Connect More Devices" → Join an existing relay: step 6 now confirms the join in place (waiting → Confirm join → joined). Certificate watching and `admit-node` signing moved into one host-level engine shared with the node-management page: a single poll loop, one key-log write mutex, and pending re-validation before signing, so two open UIs can never fork the key log. The join-token label reads "Join token (valid for N minutes)".
- "Connect More Devices" → Use this machine as the relay: steps 3–5 now reflect the machine's actual configuration (named/adopted tunnel with hostname and running state, temporary tunnel warning, Hub public URL; whether this machine already is the Hub or has joined another one) and offer a one-click switch to token generation when it is the Hub.

### Fixes

- Step-3 copy of the join branch fits on one line.

## 中文

### 新功能

- 「接入更多设备 → 加入已有中继」第 6 步就地确认加入（等待 → 确认加入 → 已加入）。证书监听与 `admit-node` 签名提升为宿主级单例引擎并与节点管理页共用：一条轮询、一把 key-log 写锁、签前重校验 pending，两处 UI 同时打开也不会分叉 key-log。加入码标签改为「加入码（有效期 N 分钟）」。
- 「接入更多设备 → 本机作为中继」第 3–5 步按本机实际配置渲染（命名/接管隧道主机名与运行态、临时隧道警示、Hub 公开地址；本机是否已是 Hub 或已加入他处），本机为 Hub 时一键切到生成加入码。

### 修复

- 加入分支第 3 步文案压到一行。

# 1.1.2

_2026-08-31_

## English

### Features

- "Connect More Devices" → Mobile device: step 1 now lists reachable addresses in order — public entry (named/quick tunnel, Hub public URL), LAN addresses (new `GET /api/system/addresses`), then the current non-loopback origin — and warns when the gateway only listens on 127.0.0.1.
- "Connect More Devices" → Server or computer → Join an existing relay: step 4 generates the join token in place (node name + button; explains when this machine is not part of a mesh or has no trusted Hub URL); step 5 shows the real `tmex hub join` command bound to that token and name, with a live placeholder preview before generation. Token creation is now one shared hook with the node-management page.

## 中文

### 新功能

- 「接入更多设备 → 移动设备」第 1 步改为按可达性列出地址：公网入口（命名/临时隧道、Hub 公开地址）→ 局域网地址（新增 `GET /api/system/addresses`）→ 非回环当前地址；网关只监听 127.0.0.1 时给出提示。
- 「接入更多设备 → 服务器或电脑 → 加入已有中继」第 4 步就地生成加入码（节点名称 + 按钮；本机未加入 mesh 或无可信 Hub 地址时给出说明），第 5 步显示与加入码、节点名称联动的真实 `tmex hub join` 命令，未生成前按真实形状给占位预览。加入码生成逻辑与节点管理页共用同一 hook。

# 1.1.1

_2026-08-31_

## English

### Fixes

- "Connect More Devices" panel: tab content rendered beside the tab list instead of below it (the shared Tabs root never applied its horizontal layout). Fixed in `@tmex/ui`.
- Sidebar footer: the "Connect Devices" / "Manage Devices" labels are centered.

## 中文

### 修复

- 「接入更多设备」面板内容与标签并排错乱（共享 Tabs 根的横向布局从未生效），已在 `@tmex/ui` 修复。
- 侧栏底部「接入设备」/「管理设备」文字居中。

# 1.1.0

_2026-08-31_

## English

### Highlights

- Distribution moved from the upstream npm package to GitHub Releases of [12dora/tmex-enhanced](https://github.com/12dora/tmex-enhanced). Install with `install.sh`; upgrade and uninstall with the `tmex` command.
- `init` and `upgrade` install a `tmex` shim into `~/.local/bin` (and `~/.bun/bin` when present) so later commands no longer go through `npx tmex-cli`.
- Settings → Remote access now starts with a top-level choice between Cloudflare Tunnel and Direct connection; direct connection no longer sits behind the cloudflared install step.
- New “Connect More Devices” side panel (sidebar footer) with step-by-step guides for mobile PWA install and for adding servers/computers (install script, join an existing Hub, or make this machine the Hub). The header mesh icon is removed; the Devices page “+” menu gains “Add remote node”.
- Settings tabs load faster: external tunnel detection is stale-while-revalidate with Cloudflare API timeouts, local/TLS/auth-mode status is cached and parallelised, and the front end prefetches status queries and lazy-loads heavy widgets.

### Features

- Added `install.sh` for one-line install from GitHub Releases (`curl … | bash`, or `bash install.sh` with init flags). Pin a version with `TMEX_VERSION`.
- `tmex upgrade` downloads `tmex-cli-<version>.tgz` from this repo’s GitHub Releases and re-runs the extracted CLI with `--apply-current-package`.
- CLI files are copied into `<installDir>/cli/` and exposed as the `tmex` command. `tmex uninstall` removes the shim(s).

## 中文

### 版本亮点

- 发行渠道从上游 npm 包改为 [12dora/tmex-enhanced](https://github.com/12dora/tmex-enhanced) 的 GitHub Releases。用 `install.sh` 安装，用 `tmex` 命令升级与卸载。
- `init` 与 `upgrade` 会把 `tmex` 命令安装到 `~/.local/bin`（若存在 `~/.bun/bin` 则同时放一份链接），后续不再经过 `npx tmex-cli`。
- 设置 → 远程访问改为顶层二选一：Cloudflare Tunnel 或直接连接，直连不再排在安装 cloudflared 之后。
- 侧栏底部新增「接入更多设备」面板：移动设备添加到主屏幕、服务器或电脑（安装脚本、加入已有中继、本机作为中继）分步指引。顶栏多节点互联图标移除；设备页「+」菜单新增「添加远程节点」。
- 设置页各 tab 提速：外部隧道检测改为过期先返旧值后台刷新并给 Cloudflare API 加超时，本机/TLS/登录模式状态缓存并行化，前端预取状态并懒加载重组件。

### 新功能

- 新增 `install.sh`：从 GitHub Releases 一行安装（`curl … | bash`，或 `bash install.sh` 后接 init 参数）。可用 `TMEX_VERSION` 固定版本。
- `tmex upgrade` 从本仓库 GitHub Releases 下载 `tmex-cli-<version>.tgz`，解压后以 `--apply-current-package` 执行。
- CLI 文件部署到 `<installDir>/cli/`，通过 `tmex` 命令调用。`tmex uninstall` 会删除对应 shim。
