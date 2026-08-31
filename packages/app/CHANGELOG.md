# 1.1.0

_2026-08-31_

## English

### Highlights

- Distribution moved from the upstream npm package to GitHub Releases of [12dora/tmex-enhanced](https://github.com/12dora/tmex-enhanced). Install with `install.sh`; upgrade and uninstall with the `tmex` command.
- `init` and `upgrade` install a `tmex` shim into `~/.local/bin` (and `~/.bun/bin` when present) so later commands no longer go through `npx tmex-cli`.
- Remote-access onboarding is restructured around a dedicated wizard, with a “Connect more devices” guide. The header mesh icon is removed.

### Features

- Added `install.sh` for one-line install from GitHub Releases (`curl … | bash`, or `bash install.sh` with init flags). Pin a version with `TMEX_VERSION`.
- `tmex upgrade` downloads `tmex-cli-<version>.tgz` from this repo’s GitHub Releases and re-runs the extracted CLI with `--apply-current-package`.
- CLI files are copied into `<installDir>/cli/` and exposed as the `tmex` command. `tmex uninstall` removes the shim(s).

## 中文

### 版本亮点

- 发行渠道从上游 npm 包改为 [12dora/tmex-enhanced](https://github.com/12dora/tmex-enhanced) 的 GitHub Releases。用 `install.sh` 安装，用 `tmex` 命令升级与卸载。
- `init` 与 `upgrade` 会把 `tmex` 命令安装到 `~/.local/bin`（若存在 `~/.bun/bin` 则同时放一份链接），后续不再经过 `npx tmex-cli`。
- 远程访问引导改为独立向导，并提供「连接更多设备」说明；顶栏 mesh 图标已去掉。

### 新功能

- 新增 `install.sh`：从 GitHub Releases 一行安装（`curl … | bash`，或 `bash install.sh` 后接 init 参数）。可用 `TMEX_VERSION` 固定版本。
- `tmex upgrade` 从本仓库 GitHub Releases 下载 `tmex-cli-<version>.tgz`，解压后以 `--apply-current-package` 执行。
- CLI 文件部署到 `<installDir>/cli/`，通过 `tmex` 命令调用。`tmex uninstall` 会删除对应 shim。
