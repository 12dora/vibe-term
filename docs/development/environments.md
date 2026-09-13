# 三套环境（development / test / production）环境变量体系

本文描述 `NODE_ENV` 三套环境的配置来源、共享加载器 `loadEnv()` 的行为、各入口如何接入、变量前缀与 `TMEX_*` 别名；面向所有开发者（起 dev server、写测试、打包运行时之前必读）。

## 背景与目标

环境变量加载不能散落在 `dev-supervisor.sh`、测试 preload、`playwright.config.ts` 等多处互相打补丁；dev / test 运行也不能继承 shell 里安装版 `app.env` 的变量（`NODE_ENV=production`、生产 `DATABASE_URL`、指向安装目录的 `VIBETERM_MIGRATIONS_DIR`/`VIBETERM_FE_DIST_DIR`），否则 dev 启动崩溃、单元测试误写生产库。

标准三环境体系：`NODE_ENV ∈ {development, test, production}`，由一个共享加载器统一处理。

- 开发服务器走 `development`，由 `env/development.env` 提供配置。
- 所有测试（单元 + e2e）走 `test`，由 `env/test.env` 提供共享行为配置。
- `production` 仅用于打包安装后的常驻服务，变量来自安装版 `app.env` + `run.sh`，**绝不读取任何仓库 env 文件**。

环境名用 `test`（而非 `testing`）：`bun test` 会自动把 `NODE_ENV` 设为 `test`，对齐后连 bare `bun test` 也能命中 `test.env`。

## 变量来源矩阵

| 环境 | NODE_ENV | 配置来源 | 由谁加载 |
|---|---|---|---|
| development | `development` | `env/development.env`（+ `env/development.env.local` 覆盖） | 应用启动时 `loadEnv()` |
| test | `test` | `env/test.env`（+ `env/test.env.local`），接线键由各测试入口注入 | preload / 应用 `loadEnv()` |
| production | `production` | 安装版 `app.env`（`buildAppEnvValues`，7 个核心键）+ `run.sh` export 的 `VIBETERM_FE_DIST_DIR`/`VIBETERM_MIGRATIONS_DIR` | `run.sh` 经 shell 注入 |

- `buildAppEnvValues` 只在 `VIBETERM_ROLES` 含 `relay` 时额外写入 `VIBETERM_RELAY_PUBLIC_URL`（必填，中继对外地址）与 `VIBETERM_RELAY_ADMIN_TOKEN`（缺失时首启生成）；其它角色的 `app.env` 不含这两个键。中继角色首启若自行生成了管理令牌，**只有 production 会写回 `app.env`**，dev / test 只在启动日志里打印一次（见 [公共中继（relay）角色](../architecture/relay.md)）。
- `development.env` / `test.env` 提交进库（仅含开发/测试用公开值，dev master key 本就公开）；`*.env.local` 忽略，供个人临时覆盖。
- 可选 `VIBETERM_*` 调优项（throttle / tmux / ssh-reconnect / language）在 `apps/gateway/src/config.ts` 均有默认值，**这些默认值即生产行为**。生产 `app.env` 保持精简，不扩容；老安装无需迁移。

## 共享加载器 `packages/shared/src/env/load-env.ts`

`loadEnv()` 按 `NODE_ENV` 分派到三条专属分支：

**production 分支 `applyProductionEnv()`**

- 不读取任何仓库 env 文件、不执行净化（生产里路径键正是安装目录路径，绝不能动）。
- fail-fast 校验生产契约：`VIBETERM_MASTER_KEY`/`GATEWAY_PORT`/`VIBETERM_BIND_HOST`/`DATABASE_URL` 必须存在，`VIBETERM_FE_DIST_DIR`/`VIBETERM_MIGRATIONS_DIR` 必须存在且指向真实目录（`existsSync`）。任一缺失即抛带可操作信息的错误（提示检查 app.env / 重跑 `vibeterm upgrade`）。
- 打印生产摘要作为可观测信号。

**development / test 分支 `applyRepoEnv()`**

1. 净化继承的安装版毒变量：若 `VIBETERM_MIGRATIONS_DIR`/`VIBETERM_FE_DIST_DIR` 指向安装目录（标记 `Application Support/tmex`、`Application Support/vibeterm`）则删除（收敛旧 hack）。改名前的安装目录名仍是 `tmex`，两个标记都要认。
2. 读 `<env>.env` 再读 `<env>.env.local`（后者覆盖前者）。
3. 以 **override=true** 应用：文件定义的键覆盖继承的 shell 值，使仓库文件成为该环境唯一真相；文件未定义的键保持原值不动。
4. 相对 `DATABASE_URL` 解析到仓库根。

### 优先级与「接线键」约定

`test.env` **刻意省略**「按运行上下文变化的接线键」——`DATABASE_URL` / `GATEWAY_PORT` / `FE_PORT` / `VIBETERM_BASE_URL` / `VIBETERM_GATEWAY_URL`。配合 override=true，三场景互不冲突：

- 开发：`development.env` 全权威（dev-supervisor 不注入动态值）。
- 单元测试：preload 设 `DATABASE_URL=:memory:`（文件未定义，不被覆盖）。
- e2e：playwright / run-e2e 注入动态端口、临时 db、派生 URL（文件未定义，不被覆盖）。

## 各入口接入

| 入口 | 接入方式 |
|---|---|
| dev gateway | `apps/gateway/src/index.ts` 首行 `import './bootstrap-env'`（在 import config 前调 `loadEnv()`） |
| 生产 runtime | `packages/app/src/runtime/server.ts` 首行 `import './bootstrap-env'`（production 走 `applyProductionEnv()`） |
| 单元测试 | 根 `bunfig.toml` 与 `apps/gateway/bunfig.toml` 的 preload：先设 `DATABASE_URL`（未设/含生产标记→`:memory:`），再调 `loadEnv()` |
| dev-supervisor | `export NODE_ENV=development` 后 source `development.env`（仅为自身拿到端口做健康检查）；净化与相对 DATABASE_URL 解析交给应用侧 `loadEnv()` |
| e2e playwright | gateway/fe webServer 只注入接线键（`NODE_ENV=test` + 动态端口/db/URL），行为配置由 webServer 进程自身 `loadEnv()` 加载 |

`config.ts` 提供 `isDev` / `isTest` / `isProd` 三个布尔量。

### 前端（vite）不加载后端 env

`loadEnv` 是 Node-only（依赖 `node:fs`/`node:url`），**不从 `@vibeterm/shared` 浏览器侧主入口导出**——否则会被打进客户端 bundle，触发 `Module "node:fs" has been externalized` 运行时错误。Node 侧消费者一律相对路径 `import './env/load-env'`。端口 / 布尔解析走 `packages/shared/src/env/parse.ts` 的 `parsePort` / `parseBoolEnv`（无 `node:*`，同样不要从浏览器主入口导出）：gateway `config.ts`、app 端口计划、mesh / upgrade 命令从它派生。`parseBoolEnv` 真值为 `'1'` / `'true'` / `'yes'`（大小写不敏感），**不 trim、不含 `on`**；`parseHubAutoPromote` 另有 `on` 与空串语义，不要误换。

`apps/fe/vite.config.ts` **刻意不加载任何后端 env 文件**：前端只需要 `VIBETERM_GATEWAY_URL` 与 `FE_PORT` 两个非密钥接线值，由 launcher 经 `process.env` 提供（dev-supervisor source / playwright 注入）。若让 vite 加载后端 env，会把 `VIBETERM_MASTER_KEY` 等密钥拉进 vite 进程，存在被打进前端 bundle 的风险。

## 变量前缀与 tmex 时期的别名

应用自有的环境变量统一以 `VIBETERM_` 为前缀（`VIBETERM_MASTER_KEY`、`VIBETERM_BIND_HOST`、`VIBETERM_BASE_URL`、`VIBETERM_GATEWAY_URL`、`VIBETERM_FE_DIST_DIR`、`VIBETERM_MIGRATIONS_DIR`、`VIBETERM_NATIVE_DIR`、`VIBETERM_ROLES`、`VIBETERM_HUB_URL`、`VIBETERM_SITE_NAME`、`VIBETERM_TRUST_PROXY`、`VIBETERM_BUN_PATH` 等）。三个无前缀键沿用通用名：`NODE_ENV`、`DATABASE_URL`、`GATEWAY_PORT` / `FE_PORT`。

改名前（2.0.0 之前，产品名 tmex）这些键的前缀是 `TMEX_`。2.0.0 的升级器会把安装版 `app.env` 的键整体改写成 `VIBETERM_*`（原文件备份进 `backups/`），但 shell 里可能还残留旧变量、回滚后的 `app.env` 也可能是旧键，因此保留一层运行时别名：

- `loadEnv()` 一开始调 `applyLegacyEnvAliases()`：遍历 `process.env`，把每个 `TMEX_X` 复制到**尚未设置**的 `VIBETERM_X`（已设置的新键优先，不覆盖）。gateway、生产 runtime、CLI 三个入口都经由它。
- `mergeMissingEnvFileKeys()` 把 `TMEX_X` 视为 `VIBETERM_X` 已存在，升级追加缺失键时不会写出重复的两份配置。
- 生产 `run.sh` 同时导出 `VIBETERM_*` 与 `TMEX_*` 四个路径变量，保证升级事务内回滚拉起旧 runtime 时仍能读到。

读侧代码一律只读 `VIBETERM_*`，不要再判断前缀。全网升级到 ≥ 2.0 之后可以删掉整层别名，见 [改名迁移](../operations/rename-migration.md)。

## 注意事项

- **生产路径键保护**：`applyProductionEnv()` 的早返回必须在净化逻辑之前——否则会删掉生产正确的 `VIBETERM_MIGRATIONS_DIR`/`VIBETERM_FE_DIST_DIR`，搞崩常驻服务。单测已钉死该行为。
- **本机生产服务**：验证生产路径一律在仓库内起临时实例（显式覆盖端口 / install dir），严禁触碰系统已安装的 9883 常驻服务。
- 仓库里不放 `.env` / `.env.example`（`.env` 会被 Bun 在所有环境自动加载，是隐患）。
