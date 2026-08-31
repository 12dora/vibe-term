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
