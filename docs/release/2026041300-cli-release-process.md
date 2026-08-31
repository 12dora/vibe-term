# tmex-cli 发布流程

## 背景

`tmex-cli` 的 npm 包源码位于 `packages/app`，但最终发布内容不只包含 CLI 入口，还包含以下产物：

- `packages/app/dist/cli-node.js`：Node 侧 CLI 入口。
- `packages/app/dist/runtime/server.js`：Bun 运行时入口，内部会打包 gateway 运行时代码。
- `packages/app/resources/fe-dist`：前端静态资源。
- `packages/app/resources/gateway-drizzle`：gateway 数据库迁移文件。
- `packages/app/CHANGELOG.md`：**仅含当前版本**的更新日志，随 GitHub Release 发布；程序内自更新会读取目标版本的 release body / changelog 展示（见下文「版本注入与自更新」）。

因此，发布前不能只关注 `packages/app` 本身，必须确保根工作区内依赖发布包的产物全部重新生成。

> 版本号是构建期注入的：`bun run build` 期间 `packages/app` 的 `build:runtime` 会读 `packages/app/package.json` 的 `version`，经 `bun build --define TMEX_MONOREPO_VERSION="x.y.z"` 烧进 `dist/runtime/server.js`。所以**必须先 bump 版本号再 build**，否则 bundle 里烧进的是旧版本。详见 [版本注入与自更新](#版本注入与自更新)。

## 结论

发布前必须执行**全量重新编译**，推荐统一在仓库根目录运行：

```bash
bun install
bun run build
```

其中 `bun run build` 会依次执行：

```bash
bun run build:i18n
bun run build:fe
bun run build:tmex:resources
bun run build:tmex
```

这一步是发布门槛，不能用 `bun run --filter tmex-cli build` 替代，原因如下：

- 它不会主动执行 `packages/shared` 的 `build:i18n`。
- 它只会在 `apps/fe/dist/index.html` 不存在时才触发前端构建；如果 `dist` 已存在但过期，会直接复制旧产物进入发行包。

## 标准流程

### 1. bump 版本号 + 生成 changelog

不要手改 `package.json`。在仓库根目录执行：

```bash
bun run release:tmex <newVersion>      # 例：bun run release:tmex 0.11.0
```

`scripts/release.ts` 会：

1. 校验 semver；
2. 取「上一条 `chore(release)` 提交 .. HEAD」的 commit，按 conventional commit 前缀（feat/fix/perf/refactor/docs，其余归 Other）分组，排除 `chore(release)` 自身；
3. 把 `packages/app/CHANGELOG.md` 写成 **双语 commit 原文草稿**（**仅当前版本**，含日期，首行带 `<!-- DRAFT… -->` 标记；`## English` 在前、`## 中文` 在后，`---` 分隔，两段共用同一份 commit）；
4. 写 `packages/app/package.json` 的 `version`。

可选参数：`--from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>`。

### 1.5 由 agent 把草稿改写为用户语言（必做）

`release.ts` 生成的是给工程师看的双语 commit 草稿，**不能直接发给用户**。让 agent 按 [改写规范](2026061406-release-changelog-flow.md#改写规范agent-步骤) 把 `packages/app/CHANGELOG.md` 改写为普通客户看得懂的人话：去掉 commit hash / scope / `feat:`/`fix:` 前缀 / 实现黑话，按「新增 / 改进 / 修复」讲用户能感知的价值，并**删除首行 DRAFT 标记**。`## English` 段写英文、`## 中文` 段写简体中文，两段内容须一一对应。改完审阅一遍。

> 顺序很重要：必须先跑 `release:tmex`（bump 版本）+ 改写 changelog，再 `bun run build`，因为版本号在 build 期注入 bundle。

### 2. 全量重新编译

在仓库根目录执行：

```bash
bun install
bun run build
```

### 3. 基础校验

至少执行以下检查：

```bash
bun run test:tmex
npm pack --dry-run --workspace tmex-cli
```

校验重点：

- `npm pack --dry-run` 输出中必须包含 `dist`、`resources` 与 `CHANGELOG.md`。
- `resources/fe-dist` 中应包含最新前端静态资源。
- `resources/gateway-drizzle` 中应包含迁移文件。
- **CHANGELOG 已完成 agent 改写**：`grep -c DRAFT packages/app/CHANGELOG.md` 应为 `0`（仍有 DRAFT 标记说明漏了第 1.5 步），且内容无 commit hash / `feat:` 等黑话。
- **CHANGELOG 为双语**：`grep -c '^## English' packages/app/CHANGELOG.md` 与 `grep -c '^## 中文' packages/app/CHANGELOG.md` 均应为 `1`（英中两段齐全，见 issue #20）。
- **版本号已正确烧进 bundle**：`grep -c "<newVersion>" packages/app/dist/runtime/server.js` 应 > 0（确认 `--define` 注入生效，而非旧版本）。

如果本次发布包含 `apps/gateway`、`apps/fe`、`packages/shared` 的行为变更，应额外执行受影响模块的测试或构建验证。

### 4. 打 tag 并推送

发版走 GitHub Actions：推送 `v<version>` tag（或手动 `workflow_dispatch` 指定 tag）后，`.github/workflows/release.yml` 会 `npm pack`、计算 SHA256，并创建/更新 GitHub Release（资产 `tmex-cli-<version>.tgz` 与 `SHA256SUMS`）。已有同名 release 时会先 `gh release edit` 对齐标题与 notes，再 `--clobber` 上传资产。

```bash
git tag "v<newVersion>"
git push origin "v<newVersion>"
```

不要 `npm publish`。`packages/app` 为 private，发行渠道只有本仓库 GitHub Releases。

### 5. 发布后验证

```bash
gh release view "v<version>"
curl -fsSIL "https://github.com/12dora/tmex-enhanced/releases/download/v<version>/tmex-cli-<version>.tgz"
```

安装验证：

```bash
TMEX_VERSION=<version> curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash
tmex doctor --lang en
```

## 版本注入与自更新

「monorepo 版本」= 发布的 `tmex-cli` 版本（`packages/app/package.json.version`），是前后端唯一真相源。

- **构建期注入**：`build:runtime`（`packages/app/scripts/build-runtime.ts`）读该版本，经 `bun build --define TMEX_MONOREPO_VERSION="x.y.z"` 烧进 bundle；前端 `vite.config.ts` 同样 `define __MONOREPO_VERSION__`。运行时 `apps/gateway/src/system/version.ts` 用 `typeof` 守卫读取，dev 回退读仓库 `package.json`。**所以发版顺序必须是「先 `release:tmex` bump，再 `build`」**。
- **CHANGELOG 随 Release 发布**：`packages/app/CHANGELOG.md` 已在 `files` 中，每个发布版只含该版本日志，并由 workflow 写入 GitHub Release notes。
- **程序内自更新**：设置页「版本与更新」触发后，gateway 从 GitHub Releases 下载目标版本 tarball，再 detached 执行 `tmex upgrade --apply-current-package` 完成停服务 → 部署 → 重启。仅 `production` + CLI 安装可用。详见 [自更新与版本展示](../update/2026061406-self-update.md) 与 [发版与 changelog 流程](2026061406-release-changelog-flow.md)。

## 常见错误

### 只跑 `bun run --filter tmex-cli build`

风险：

- 共享 i18n 生成文件可能不是最新。
- 已存在但过期的 `apps/fe/dist` 会被直接打包。

结论：不能作为正式发布前的唯一构建命令。

### 在 `packages/app` 目录直接构建并发布

风险：

- 容易忽略根工作区的前端、共享代码和资源生成步骤。

结论：构建统一在仓库根目录执行；发布由 tag 触发 GitHub Actions。

### 未检查 `npm pack --dry-run`

风险：

- 可能把不完整的 tarball 发到 GitHub Releases，例如缺少 `dist/runtime` 或 `resources/fe-dist`。

结论：发版前必须看一次 dry-run 结果。

## 最小命令清单

```bash
# 仓库根目录
bun install
bun run release:tmex <newVersion>      # bump 版本 + 生成 CHANGELOG 草稿（commit 原文）
#   → 让 agent 把 CHANGELOG.md 改写为用户能看懂的人话，删除 DRAFT 标记，再审阅
bun run build                          # 必须在 bump+改写之后：版本号在此烧进 bundle
bun run test:tmex
npm pack --dry-run --workspace tmex-cli   # 确认含 dist/resources/CHANGELOG.md

# 提交发版（仓库历史惯例：直接在主分支提交）
git commit -am "chore(release): tmex-cli <newVersion>"
git tag "v<newVersion>"
git push origin HEAD "v<newVersion>"
```

> 推送 tag 后由 GitHub Actions 打包并上传 Release，无需 `npm publish`。
