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

- Removed the terminal toolbar "jump to latest" button (the keyboard-shortcut action remains).

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

- 删除终端工具栏的「回到底部」按钮（快捷键动作保留）。

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
