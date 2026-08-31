# 发行源切换到本仓库 GitHub Releases

## 背景

本仓库是 `krhougs/tmex` 的 fork（`12dora/tmex-enhanced`）。npm 包 `tmex-cli` 归上游所有，fork 无法发版，而此前安装（`npx tmex-cli init`）、CLI 升级（`npx tmex-cli@<v> upgrade`）、网关一键升级（`bun add tmex-cli@<v>`）与更新检查（`registry.npmjs.org`）全部指向 npm。用户在本 fork 上永远拿不到自己的构建。

## 设计

- 常量集中在 `packages/shared/src/release/source.ts`：`RELEASE_REPO`、`RELEASE_API_LATEST_URL`、`releaseTarballUrl(version)`、`INSTALL_COMMAND` 等。网关经 `@tmex/shared` 引用；`packages/app`（Node 兼容 CLI）按惯例相对路径引用。
- 发行物：tag `v<version>`，资产 `tmex-cli-<version>.tgz`（`npm pack` 产物，自包含：`dist/cli-node.js` 由 bun 打包，`bin/tmex.js` 无需 `npm install`）+ `SHA256SUMS`。由 `.github/workflows/release.yml` 在 tag push 时构建上传（`gh release create` / 已存在则 `edit` + `upload --clobber`）。
- 更新检查（`apps/gateway/src/system/update-check.ts`）：读 `releases/latest`，`tag_name` 去 `v` 比较；release body 即 changelog；缺对应 tarball 资产时 `hasUpdate=false`。403/404/429 直接报错，不回退 npm。
- 网关一键升级（`apps/gateway/src/system/upgrade.ts`）：下载 tarball → `tar -xzf` → 预检包结构 → detached 执行 `package/bin/tmex.js upgrade --apply-current-package`，状态机与回滚逻辑不变。
- CLI `tmex upgrade`（`packages/app/src/commands/upgrade.ts`）：解析目标版本（`--version` 或 latest）→ 下载 → 解包 → 用当前运行时重新执行解包后的 CLI；退出码透传。
- CLI 自部署与 shim（`packages/app/src/lib/cli-shim.ts`）：`init` / `upgrade --apply-current-package` 把 `package.json`、`bin/`、`dist/cli-node.js` 拷到 `<installDir>/cli/`，写 `~/.local/bin/tmex`（node ≥ 20 优先，否则安装记录的 bun），`~/.bun/bin` 存在时加软链。shim 带标记与安装目录注释，只覆盖/删除自己写的文件；`uninstall` 清理。
- 一键安装 `install.sh`：`curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash`。检查 curl/tar，缺 bun 自动装，先用 `releases/latest` 重定向取 tag（无 API 限流），失败回退 API；下载解包后执行 `init`（管道执行时接回 `/dev/tty`，无终端则 `--no-interactive`）。`TMEX_VERSION` 可钉版本。
- join 命令统一为 `tmex hub join <url> --token <token> --name <name>`（前端 `enrollment.ts` 与 CLI `enroll.ts`）。

## 注意事项

- 版本源仍是 `packages/app/package.json`；发版流程：改版本 + CHANGELOG → 打 tag 推送 → Actions 出包。本机上线仍可走本地 `npm pack` + `upgrade --apply-current-package`。
- 与上游的可合并性：本轮起发版相关文件已分叉，回馈上游时需单独剥离。
