# vibeterm-cli 发布流程

本文是发版手册：发行源与发行物、版本注入、changelog 生成与改写规范、全量构建、校验、打 tag 触发 GitHub Actions、发布后验证；面向发版维护者。发行包签名见 [发行包签名](./release-signing.md)，升级事务见 [升级事务](./upgrade-transaction.md)。

## 发行源

本仓库是 `krhougs/tmex` 的 fork（`12dora/vibe-term`），npm 包名归上游所有，因此**发行渠道只有本仓库的 GitHub Releases**，不 `npm publish`：

- 常量集中在 `packages/shared/src/release/source.ts`：`RELEASE_REPO`、`RELEASE_API_LATEST_URL`、`releaseTarballUrl(version)`、`INSTALL_COMMAND` 等。网关经 `@vibeterm/shared` 引用；`packages/app`（Node 兼容 CLI）按惯例相对路径引用。
- 发行物：tag `v<version>`，资产 `vibeterm-cli-<version>.tgz`（`npm pack` 产物，自包含：`dist/cli-node.js` 由 bun 打包，`bin/vibeterm.js` 无需 `npm install`）、兼容资产 `tmex-cli-<version>.tgz`（见下文）、`SHA256SUMS`、`SHA256SUMS.sig`。由 `.github/workflows/release.yml` 在 tag push 时构建上传。
- 更新检查（`apps/gateway/src/system/update-check.ts`）读 `releases/latest`，`tag_name` 去 `v` 比较；release body 即 changelog；缺对应 tarball 资产时 `hasUpdate=false`。403/404/429 直接报错，不回退 npm。
- 网关一键升级下载 tarball → `tar -xzf` → 预检包结构 → detached 执行 `package/bin/vibeterm.js upgrade --apply-current-package`；CLI `vibeterm upgrade` 解析目标版本（`--version` 或 latest）→ 下载 → 解包 → 用当前运行时重新执行解包后的 CLI。下载走并行 Range（忽略 Range 则退回单流），重定向只跟 https 且主机限 `github.com` / `*.githubusercontent.com` / 起始 origin，见 [自更新](./self-update.md)。
- CLI 自部署与 shim（`packages/app/src/lib/cli-shim.ts`）：`init` / `upgrade --apply-current-package` 把 `package.json`、`bin/`、`dist/cli-node.js` 拷到 `<installDir>/cli/`，写 `~/.local/bin/vibeterm`（node ≥ 20 优先，否则安装记录的 bun），`~/.bun/bin` 存在时加软链。shim 带标记与安装目录注释，只覆盖 / 删除自己写的文件；`uninstall` 清理。
- 一键安装 `install.sh`：`curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash`。检查 curl/tar，缺 bun 自动装，先用 `releases/latest` 重定向取 tag（无 API 限流），失败回退 API；下载解包后执行 `init`（管道执行时接回 `/dev/tty`，无终端则 `--no-interactive`）。`VIBETERM_VERSION` 可钉版本。`install.sh` 只校验 SHA256SUMS，不验签。

发版相关文件已与上游分叉，回馈上游时需单独剥离。

## 背景

`vibeterm-cli` 的 npm 包源码位于 `packages/app`，但最终发布内容不只包含 CLI 入口，还包含以下产物：

- `packages/app/dist/cli-node.js`：Node 侧 CLI 入口。
- `packages/app/dist/runtime/server.js`：Bun 运行时入口，内部会打包 gateway 运行时代码。
- `packages/app/resources/fe-dist`：前端静态资源，**含构建期写出的 `.br` / `.gz` sidecar**（运行时按 `Accept-Encoding` 直接下发，见 [前端性能](../development/performance-frontend.md)）。sidecar 约 4 MB，发行包体随之 +4 MB；`bundle-resources.sh` 是 `cp -R` 后只删 `*.map`，不会漏掉它们。
- `packages/app/resources/gateway-drizzle`：gateway 数据库迁移文件。
- `packages/app/CHANGELOG.md`：**仅含当前版本**的更新日志，随 GitHub Release 发布；程序内自更新会读取目标版本的 release body / changelog 展示（见下文「版本注入与自更新」）。

因此，发布前不能只关注 `packages/app` 本身，必须确保根工作区内依赖发布包的产物全部重新生成。

> 版本号是构建期注入的：`bun run build` 期间 `packages/app` 的 `build:runtime` 会读 `packages/app/package.json` 的 `version`，经 `bun build --define VIBETERM_MONOREPO_VERSION="x.y.z"` 烧进 `dist/runtime/server.js`。所以**必须先 bump 版本号再 build**，否则 bundle 里烧进的是旧版本。详见 [版本注入与自更新](#版本注入与自更新)。

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
bun run build:app:resources
bun run build:app
```

这一步是发布门槛，不能用 `bun run --filter vibeterm-cli build` 替代，原因如下：

- 它不会主动执行 `packages/shared` 的 `build:i18n`。
- 它只会在 `apps/fe/dist/index.html` 不存在时才触发前端构建；如果 `dist` 已存在但过期，会直接复制旧产物进入发行包。

## 标准流程

### 1. bump 版本号 + 生成 changelog

不要手改 `package.json`。在仓库根目录执行：

```bash
bun run release <newVersion>      # 例：bun run release 0.11.0
```

`scripts/release.ts` 会：

1. 校验 semver；
2. 取「上一条 `chore(release)` 提交 .. HEAD」的 commit，按 conventional commit 前缀（feat/fix/perf/refactor/docs，其余归 Other）分组，排除 `chore(release)` 自身；
3. 把 `packages/app/CHANGELOG.md` 写成 **双语 commit 原文草稿**（**仅当前版本**，含日期，首行带 `<!-- DRAFT… -->` 标记；`## English` 在前、`## 中文` 在后，`---` 分隔，两段共用同一份 commit）；
4. 写 `packages/app/package.json` 的 `version`。

可选参数：`--from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>`。

### 1.5 由 agent 把草稿改写为用户语言（必做）

`release.ts` 生成的是给工程师看的双语 commit 草稿，**不能直接发给用户**。让 agent 按下文 [changelog 改写规范](#changelog-改写规范) 把 `packages/app/CHANGELOG.md` 改写为普通客户看得懂的人话：去掉 commit hash / scope / `feat:`/`fix:` 前缀 / 实现黑话，按「新增 / 改进 / 修复」讲用户能感知的价值，并**删除首行 DRAFT 标记**。`## English` 段写英文、`## 中文` 段写简体中文，两段内容须一一对应。改完审阅一遍。

> 顺序很重要：必须先跑 `release`（bump 版本）+ 改写 changelog，再 `bun run build`，因为版本号在 build 期注入 bundle。

### 2. 全量重新编译

在仓库根目录执行：

```bash
bun install
bun run build
```

### 3. 基础校验

至少执行以下检查：

```bash
bun run test:app
npm pack --dry-run --workspace vibeterm-cli
```

校验重点：

- `npm pack --dry-run` 输出中必须包含 `dist`、`resources` 与 `CHANGELOG.md`。
- `resources/fe-dist` 中应包含最新前端静态资源，且 `assets/*.js` 旁有同名 `.br` / `.gz`（缺了只是回落到运行时即时压，但首屏会慢）。
- `resources/gateway-drizzle` 中应包含迁移文件。
- **CHANGELOG 已完成 agent 改写**：`grep -c DRAFT packages/app/CHANGELOG.md` 应为 `0`（仍有 DRAFT 标记说明漏了第 1.5 步），且内容无 commit hash / `feat:` 等黑话。
- **CHANGELOG 为双语**：`grep -c '^## English' packages/app/CHANGELOG.md` 与 `grep -c '^## 中文' packages/app/CHANGELOG.md` 均应为 `1`（英中两段齐全，见 issue #20）。
- **版本号已正确烧进 bundle**：`grep -c "<newVersion>" packages/app/dist/runtime/server.js` 应 > 0（确认 `--define` 注入生效，而非旧版本）。

如果本次发布包含 `apps/gateway`、`apps/fe`、`packages/shared` 的行为变更，应额外执行受影响模块的测试或构建验证。

### 4. 打 tag 并推送

发版走 GitHub Actions：推送 `v<version>` tag（或手动 `workflow_dispatch` 指定 tag）后，`.github/workflows/release.yml` 会 `npm pack`、生成兼容资产、计算 SHA256、签名，并创建/更新 GitHub Release（资产 `vibeterm-cli-<version>.tgz`、`tmex-cli-<version>.tgz`、`SHA256SUMS`、`SHA256SUMS.sig`）。已有同名 release 时会先 `gh release edit` 对齐标题与 notes，再 `--clobber` 上传资产。

```bash
git tag "v<newVersion>"
git push origin "v<newVersion>"
```

不要 `npm publish`。`packages/app` 为 private，发行渠道只有本仓库 GitHub Releases。

#### 兼容资产 `tmex-cli-<version>.tgz`

产品在 2.0.0 由 tmex 改名 VibeTerm，包名随之变成 `vibeterm-cli`。但**现网 ≤ 1.1.40 的节点自升级时会硬校验旧名**：按 `tmex-cli-<version>.tgz` 拼下载 URL、在 `SHA256SUMS` 里按该文件名找摘要、解包后断言 `package.json.name === 'tmex-cli'` 且 `bin/tmex.js` 存在。任何一项不满足，旧节点就升不上来，只能逐台手工重装。

因此 workflow 在 `npm pack` 之后多跑一步 `scripts/release/build-legacy-asset.ts`：解包新 tarball、把 `package.json.name` 改回 `tmex-cli`、重新打成 `tmex-cli-<version>.tgz`（内容与新资产等价，`bin/tmex.js` 与 `bin/vibeterm.js` 都在包里）。两个资产都写进同一份 `SHA256SUMS`，由同一把 `r1` 私钥签一次。

- **新代码读侧双接受**：下载、校验、解包都同时认 `vibeterm-cli|tmex-cli` 两种资产名与包名；hub 向旧节点推包时选旧资产名。
- **移除条件**：确认全网节点均 ≥ 2.0.0（`vibeterm hub list` / 中继租户列表逐台核对版本）之后的某个版本，删掉 `build-legacy-asset.ts` 与 workflow 里的对应步骤，`SHA256SUMS` 回到一行。删除前不要动，否则老节点会静默停在旧版本。

### 5. 发布后验证

```bash
gh release view "v<version>"
curl -fsSIL "https://github.com/12dora/vibe-term/releases/download/v<version>/vibeterm-cli-<version>.tgz"
```

安装验证：

```bash
VIBETERM_VERSION=<version> curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
vibeterm doctor --lang en
```

## 版本注入与自更新

「monorepo 版本」= 发布的 `vibeterm-cli` 版本（`packages/app/package.json.version`），是前后端唯一真相源。

- **构建期注入**：`build:runtime`（`packages/app/scripts/build-runtime.ts`）读该版本，经 `bun build --define VIBETERM_MONOREPO_VERSION="x.y.z"` 烧进 bundle；前端 `vite.config.ts` 同样 `define __MONOREPO_VERSION__`。运行时 `apps/gateway/src/system/version.ts` 用 `typeof` 守卫读取，dev 回退读仓库 `package.json`。**所以发版顺序必须是「先 `release` bump，再 `build`」**。
- **CHANGELOG 随 Release 发布**：`packages/app/CHANGELOG.md` 已在 `files` 中，每个发布版只含该版本日志，并由 workflow 写入 GitHub Release notes。
- **程序内自更新**：设置页「版本与更新」触发后，gateway 从 GitHub Releases 下载目标版本 tarball（新节点取 `vibeterm-cli-<version>.tgz`，旧节点取兼容资产 `tmex-cli-<version>.tgz`），再 detached 执行 `vibeterm upgrade --apply-current-package` 完成停服务 → 部署 → 重启。仅 `production` + CLI 安装可用。详见 [自更新与版本展示](./self-update.md)。

## changelog 机制与改写规范

### 机制

- **两阶段：脚本生成草稿 → agent 改写为人话**。`release.ts` 生成的是「commit 原文草稿」（带 `### Features`、commit hash 等工程黑话），**不直接发布**；必须由 agent 改写为面向普通用户的说明后才发布。
- **双语：同一文件先英文后中文**。`release.ts` 在版本号 / 日期标题下生成两个语言块——`## English` 在前、`## 中文` 在后，中间以 `---` 分隔；两块共用同一份 commit 草稿，由 agent 分别改写为对应语言。前端整段渲染 CHANGELOG，用户按标题定位到自己的语言。
- **changelog 只含当前版本**：每次发版重写 `packages/app/CHANGELOG.md`（在包 `files` 中），随包发布；workflow 把它写入 GitHub Release notes，gateway 检查更新时直接取 release body 展示（`update-check.ts` 的 `releaseChangelog`），body 为空则只显示版本号与发布时间。
- **DRAFT 护栏**：草稿首行是 HTML 注释 `<!-- DRAFT… -->`。漏改写时它不会在前端 markdown 渲染中显示，但维护者在文件 / `npm pack` 里仍可见——发布前确认它已被删除即代表改写完成。
- `release.ts` 用 `Date` 取当天日期，可用 `--date` 覆盖以复现 / 补录。

### changelog 改写规范

跑完 `release.ts` 后，让 agent 按以下规范把 `packages/app/CHANGELOG.md` 草稿改写为终端用户能看懂的人话：

- **只保留「最终使用者关心」的内容**。唯一判断标准：普通用户**能不能感知到、且会不会在意**。能感知又在意的功能 / 体验 / 修复才写；感知不到或不关心的一律不写。changelog 是给用户看的产品说明，不是开发记录。
- **以下内容一律不暴露**：内部工具链（构建 / 打包脚本、字体 / 资源处理工具、CI、依赖升级、lint / format、测试）；纯文案 / i18n 文字小调整；内部重构、代码搬运、纯开发者文档。
- **小的样式 / UI 微调要笼统归类，不逐条列举**：间距、配色、对齐、图标、深色模式可读性、移动端布局、文案精简等零散视觉调整，合并成一条概述（中文如「界面细节优化」，英文如 “UI polish and refinements”）。只有当某项视觉变化用户会明显察觉并在意（如整体改版）才单列。
- **受众是普通用户，不是工程师**：去掉 commit hash、scope（如 `(fe)`）、conventional 前缀（`feat:`/`fix:`）、实现细节黑话（rsync、SSH 握手、middleware、文件路径、wasm 等）。讲「用户能感知到的价值 / 变化」，而非「改了什么代码」；一条 commit 可合并 / 拆分为更贴近用户的描述。
- **双语两段都要改写**：`## English` 段用面向用户的英文，`## 中文` 段用简体中文；两段内容须对应（同样的条目数与含义）。保留两个语言标题与中间的 `---`。
- **按用户视角分组**：英文段如「New / Improvements / Fixes」（三级 `###`），中文段如「新增 / 改进 / 修复」，而非 Features/Refactoring。
- **保留版本号标题与日期**（在两段之上、只出现一次）；**删除首行 DRAFT 标记**。
- 控制篇幅，每条一句话讲清楚；重大变更可加一句影响说明（如自更新会中断访问）。
- **宁缺毋滥**：若某版本只有内部 / 工具链 / 文案改动，没有任何用户可感变化，则只写一条笼统的「界面细节优化与内部改进」即可，不硬凑条目。

示例（commit `feat(files): Files Tab — 本地 + SSH/rsync 文件浏览`）改写后：

```markdown
# 0.12.0

_2026-06-15_

## English

### New

- File browser (Files): browse files on this machine and remote servers directly inside VibeTerm…

---

## 中文

### 新增

- 文件浏览（Files）：现在可以直接在 VibeTerm 里浏览本机和远程服务器上的文件…
```

## 常见错误

### 只跑 `bun run --filter vibeterm-cli build`

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
bun run release <newVersion>      # bump 版本 + 生成 CHANGELOG 草稿（commit 原文）
#   → 让 agent 把 CHANGELOG.md 改写为用户能看懂的人话，删除 DRAFT 标记，再审阅
bun run build                          # 必须在 bump+改写之后：版本号在此烧进 bundle
bun run test:app
npm pack --dry-run --workspace vibeterm-cli   # 确认含 dist/resources/CHANGELOG.md

# 提交发版（仓库历史惯例：直接在主分支提交）
git commit -am "chore(release): vibeterm-cli <newVersion>"
git tag "v<newVersion>"
git push origin HEAD "v<newVersion>"
```

> 推送 tag 后由 GitHub Actions 打包并上传 Release，无需 `npm publish`。
