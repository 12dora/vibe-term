# 升级事务：崩溃安全的自升级

本文描述 BIOS 式升级事务的落地布局、阶段与崩溃表、旧布局迁移与修复命令；面向发版维护者、改动 `packages/app` 升级器与 `apps/gateway/src/system/upgrade.ts` 的开发者，以及需要手工回滚的运维。范围：`vibeterm-cli` 的 `init` / `upgrade` / `upgrade --apply-current-package` / `upgrade --repair`、`install.sh`、Web 触发的后台升级。改名（2.0.0）带来的安装目录迁移阶段见 [改名迁移](./rename-migration.md)。

## 结论

升级采用 BIOS 式协议：新版本先在 `versions/<to>` 落地并预启动验证，旧版本一直保持可启动；通过后才原子切换 `current`。任意瞬间断电或 `SIGKILL` 后，目录要么仍是旧版，要么已是经验证的新版。journal（`upgrade-state.json`）是唯一真相源，下一次 `upgrade` / `upgrade --repair` / `init` 会按阶段完成或清场。

## 落地布局

```text
<installDir>/
  versions/<version>/{cli,runtime,resources,native}
  current -> versions/<version>          # 原子 rename 切换（current.tmp 后改名）
  staging/<txnId>/                       # 与 versions 同一文件系统
  backups/<txnId>/{vibeterm.db,vibeterm.db-wal,vibeterm.db-shm,run.sh,app.env}
  upgrade-state.json                     # journal：txnId / phase / fromVersion / toVersion / dbBackup / error
  upgrade.lock                           # O_EXCL；内容为 pid + startedAt + 进程启动身份；pid 已死或身份不符则回收
  data/  app.env  run.sh  install-meta.json
```

`run.sh`（unit/plist 仍指向此稳定路径）一律经 `current` 解析：

- `VIBETERM_INSTALL_DIR=<installDir>`
- `VIBETERM_FE_DIST_DIR=<installDir>/current/resources/fe-dist`
- `VIBETERM_MIGRATIONS_DIR=<installDir>/current/resources/gateway-drizzle`
- `VIBETERM_NATIVE_DIR=<installDir>/current/native`
- `exec bun <installDir>/current/runtime/server.js`

shim（`~/.local/bin/vibeterm`、`~/.bun/bin/vibeterm`）指向 `<installDir>/current/cli/bin/vibeterm.js`，写入均为 temp+rename（包括 bun 目录的 symlink，禁止先 `rm` 再创建）。

`run.sh` 在 `exec` 前把自身 `$$` 写入 `<installDir>/vibeterm.pid`，使 `--no-service` / 手工启动的进程可被停止。`install-meta.json` 持久化 `serviceMode: managed | none`。`init --no-service` 用 flag 写入；upgrade 成功提交时把解析后的模式写回（legacy 无该字段时用 `--no-service` 回退，之后以 meta 为准）。upgrade/repair 读 meta（flag 不再覆盖已持久化的模式）。Web 升级继承该模式：`none` 且没有存活 pid 文件时拒绝，并提示先停进程。

## 阶段与崩溃表

| 阶段（journal.phase） | 动作 | 中断后的状态 | `--repair` / 下次 upgrade |
|---|---|---|---|
| `lock` | 取 `upgrade.lock` | 旧服务仍在跑 | 删 staging/候选（若有），标 `aborted` |
| `staging` | 下载到 `staging/<txn>`，校验 HTTP / tar / package.json 版本 / 布局；**目标版本 ≥ 1.1.4 必须拿到 SHA256SUMS HTTP 200、精确条目且 digest 匹配，404 一律中止**。更旧的目标版本仅在显式 `--allow-unverified` 时允许 404（CLI 默认拒绝；Web 永远不允许）。网络错误或其他非 2xx 必须中止。校验发生在解压/执行前（CLI、`install.sh`、gateway Web 升级同一语义）。解压后 rename 进 `versions/<to>`；若旧版本有 native 插件，在预启动前把当前 pin 装进候选目录 | 旧服务仍在跑；候选可能半成品 | 删 staging + 候选（永不删 `current` 指向的目录），标 `aborted` |
| `preflight` | 优先用候选 bun 的 `bun:sqlite` 做 `VACUUM INTO` 在线备份；失败则 `wal_checkpoint(TRUNCATE)` 后逐文件复制（运行中 WAL 仍可能不一致）。临时端口 + `VIBETERM_ROLES=standalone` + `VIBETERM_RUNTIME_MODE=preflight` 拉起候选（跳过 seed/refresh/push/agent/watch/tunnel/通知/TLS/mesh，仍跑 migrations），把 `{candidatePid, candidateStartedAt}` 写入 journal，轮询 `/healthz` 至 `status==ok && version==toVersion`（60s） | 旧服务未停；候选进程可能仍在 | 按 journal 中的 pid 校验 cmdline 含候选 `server.js` 后杀掉并等待退出，再删候选 |
| `stopping` | 先把 `run.sh` 与 `app.env` 拷进 `backups/<txn>/`（已有不覆盖），再停服务并确认进程退出 | 服务可能仍在跑或已停，`current` 仍指向旧版 | 若旧服务已在跑则不得再次 `start()`；否则拉起旧服务并做健康/运行验证后才清场 |
| `backup` | 先跑 STUN env 迁移（见下节），再复制 `vibeterm.db{,-wal,-shm}` 到 `backups/<txn>` 并切 `current` | 服务已停，`current` 仍指向旧版 | 同 stopping：验证旧服务健康后才清场；失败则保留 journal+backup，非零退出 |
| `switching` | 原子切换 `current`；按需重写 `run.sh` | 可能仍指向旧版（rename 前）或已指向新版（rename 后） | 同 backup：验证旧服务健康后才清场 |
| `started` | 正式端口健康检查（新版本要求 `version===toVersion`） | `current` 已是新版，journal 未 committed | 立即再做健康检查：通过则 `committed` 并 GC；失败则停服务（失败则中止恢复）、按备份集合精确恢复 DB 三件套（先删目标 wal/shm）、`current` 切回。回滚旧版 `/healthz` **允许缺少 `version`**（1.1.3），但要求 `status===ok`、`current` 指向 `fromVersion`、`startedAt` 新于本次重启 |
| `committed` | 写 `install-meta.json`，GC | 新版在跑 | 只清残留 staging/backups |
| `aborted` / `rolled_back` | 终态 | 旧版可启动 | 只清残留 |

成功 GC：删 `staging/<txn>`；默认删 `backups/<txn>`（`--keep-backup` 写入 journal，后续 repair 尊重该标记）；`versions/*` 只留 `current` 与上一个 last-known-good；`committed` 后才删旧的顶层 `cli/` `runtime/` `resources/` `native/`。`--repair` 还会清无 journal 的孤儿 `staging/*`、以及 `upgrade-state.json.*.tmp` / `current.*.tmp` / `run.sh.*.tmp` / shim `vibeterm.*.tmp`，不碰 `current` 目标与 `data/`。

回滚到 1.1.3 时旧 `/healthz` 没有 `version` 字段：回滚路径允许缺省，候选/新版本仍做严格版本检查。回滚到 1.0.2 时 `/healthz` 只有 `{status:"ok"}`：managed 模式下先确认服务管理器报告 running，再只要求 HTTP `status===ok`。旧服务若原本已在跑，不得为了验证再次 `start()`。

预启动失败不会停旧服务。切换后健康失败会回滚 DB 与 `current`。stop 失败或进程仍存活时不得覆盖 DB。

相同版本升级是健康 no-op（不写 aborted journal）。`--allow-missing-native` 才允许在旧版有 native 插件时跳过候选安装。

## app.env 与 STUN 迁移

`upgrade` 对 `app.env` 只做两件事：`mergeMissingEnvFileKeys` **追加缺失键**（不覆盖已有值），以及 2.2.0 引入的 STUN 键迁移。

STUN 列表改为随发行版内置分发后（见 [mesh 运维](./mesh-operations.md)），装机时冻进 `app.env` 的旧默认串会一直压住新列表。迁移逻辑（`packages/app/src/lib/upgrade-stun-env.ts`）：

- 读 `VIBETERM_STUN_SERVERS`（含遗留 `TMEX_STUN_SERVERS`），值等于**历史内置默认串**之一（`LEGACY_DEFAULT_STUN_LISTS`）时删掉这两个键；自定义值原样保留。幂等。
- 删除前把整份 `app.env` 另存一份可读副本 `backups/app.env.<ISO>.stun`（0600），日志只打相对名。
- 执行点在**目录迁移之后、切 `current`（与 DB 备份）之前**，即进入 `backup` 阶段的第一件事：这样新 runtime 一启动就没有该键；目录迁移自己的 env 备份仍是带原键的文件，`revertInstallDirMigration` 还原后键还在。
- 事务级回滚走 `backups/<txnId>/app.env`：`rollbackToOld` 与失败处理（包括还没到切 `current` 就失败的情形）都会把它拷回，冻结的旧默认不会因为一次失败的升级被悄悄丢掉。
- 相同版本的 `upgrade` 是 no-op，不走事务，因而**不做**这次迁移；真正跨版本升级才会拆。

## 旧布局迁移

已有机器是顶层 `cli/ runtime/ resources/ native/`。第一次 apply 在升级前做崩溃安全转换：按 `install-meta.json` 的 `cliVersion` 复制到 `versions/<from>/`，原子创建 `current`，原子重写 `run.sh` 与 shim。旧服务继续用原文件直到下次重启。仅在本次升级 `committed` 后删除顶层旧目录。缺少 `cliVersion` 则中止并给出明确错误。`init` 直接写新布局。`--no-service` 跳过 launchd/systemd，只管理进程（测试与无服务环境）。

## 操作说明

- 修复中断：`vibeterm upgrade --repair --install-dir <dir>`。每次 `upgrade` / `init` 开始时也会跑同样的恢复。
- 备份位置：`<installDir>/backups/<txnId>/`。成功默认删除；`--keep-backup` 保留。
- 手工回滚（journal 损坏时）：停服务 → 把 `backups/<txn>/vibeterm.db{,-wal,-shm}` 拷回 `data/` → `ln -sfn versions/<fromVersion> current` → 启动服务。不要 `rm -rf` `current` 指向的目录。
- 跨进程锁：`upgrade.lock`。记录 pid + 启动身份（`ps -o lstart=` / `/proc/<pid>/stat` starttime）。pid 已死或身份不符视为 stale，可被 `--repair` 回收。
- 未知 CLI 参数（含误把 `--help` 当升级）会被拒绝；`--help` / `-h` 显示帮助。
- 预启动禁用 mesh/uplink：候选进程设 `VIBETERM_ROLES=standalone`（不连 Hub、不开 peer 口）。`/healthz` 现带 `version`（构建期 `VIBETERM_MONOREPO_VERSION`）。mesh 节点未登录时的精简 `/healthz` 由 runtime `attachStartedAt` 补上 `version`。
- Web 触发的升级把 stage 放在 `<installDir>/staging/<txn>`，并传 `--txn` 给 CLI；清理交给 journal。

## 安装元数据损坏

`current` 若指向本安装的 `versions/<v>` 且目标仍存在，可以恢复当前版本号；不能据此恢复自定义服务名、`serviceMode=none` 等部署信息。不要删除 `current` 或其目标来修复 JSON。

`vibeterm upgrade --repair --install-dir <dir>` 已接入元数据恢复。JSON 不可读、文件缺失或缺少有效 `cliVersion` 时，从有效 `current → versions/<v>` 推导版本；拒绝外部链接、悬空链接和非目录目标。仍可读取的服务配置优先保留；服务身份无法推断时，必须显式指定 `--service-name <原服务名>`，无服务安装则指定 `--no-service`，否则在操作服务前退出。

修复成功后才写回重建元数据，版本、目录和服务名与最终提交或回滚结果一致；失败时保留原始元数据与恢复所需 journal。执行前可自行备份损坏文件以便排查。若 `current` 也不可用，须从同一安装的可信备份恢复元数据并核对版本、服务名及服务模式；不要复制其它安装的服务名。

## 已知限制

- **preflight 仍会执行 import-time 模块初始化。** `VIBETERM_RUNTIME_MODE=preflight` 会跳过 Telegram/微信、push、agent、watch、tunnel 外部进程、TLS、mesh 和远程 session restore 等显式启动链，但 `runtime.ts` 静态导入的 `transfer-session` 仍会在 import 时启动 GC interval；`tunnelManager` 构造函数也会打开拷贝后的候选库并注册全局 access guard。也就是说：外部服务不会被显式拉起，但模块级副作用（定时器、打开拷贝库）仍然发生。
- **预发布版本在 1.1.4 校验门槛上比较不一致。** CLI 与 `install.sh` 只比较数字段，会把 `1.1.4-beta` 视为已达门槛；Web 入口对 prerelease 做字典序比较，会把它判为低于 `1.1.4`。当前从不发布预发布版本，且 Web 对缺校验一律 fail-closed，因此不会形成绕过；三入口的错误语义仍不统一。

## 验收要点

- 任意阶段 `kill -9` CLI 后，`vibeterm upgrade --repair` 能回到可启动的旧版或提交新版。
- 新版本在 `/healthz` 的 `version` 匹配之前，旧 `current` 不被替换。
- `packages/app` 的 journal / lock / 原子切换 / 旧布局转换 / GC / sha256 / apply dry-run 测试覆盖上述决策。
