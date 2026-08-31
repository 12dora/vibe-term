# tmex 自升级的崩溃安全性

日期：2026-08-31　范围：`packages/app`（`tmex-cli` 的 `init` / `upgrade` / `upgrade --apply-current-package` / `upgrade --repair`）、`install.sh`、`apps/gateway/src/system/upgrade.ts`（Web 触发的后台升级）。

## 结论

升级采用 BIOS 式协议：新版本先在 `versions/<to>` 落地并预启动验证，旧版本一直保持可启动；通过后才原子切换 `current`。任意瞬间断电或 `SIGKILL` 后，目录要么仍是旧版，要么已是经验证的新版。journal（`upgrade-state.json`）是唯一真相源，下一次 `upgrade` / `upgrade --repair` / `init` 会按阶段完成或清场。

## 落地布局

```text
<installDir>/
  versions/<version>/{cli,runtime,resources,native}
  current -> versions/<version>          # 原子 rename 切换（current.tmp 后改名）
  staging/<txnId>/                       # 与 versions 同一文件系统
  backups/<txnId>/{tmex.db,tmex.db-wal,tmex.db-shm}
  upgrade-state.json                     # journal：txnId / phase / fromVersion / toVersion / dbBackup / error
  upgrade.lock                           # O_EXCL；内容为 pid + startedAt + 进程启动身份；pid 已死或身份不符则回收
  data/  app.env  run.sh  install-meta.json
```

`run.sh`（unit/plist 仍指向此稳定路径）一律经 `current` 解析：

- `TMEX_INSTALL_DIR=<installDir>`
- `TMEX_FE_DIST_DIR=<installDir>/current/resources/fe-dist`
- `TMEX_MIGRATIONS_DIR=<installDir>/current/resources/gateway-drizzle`
- `TMEX_NATIVE_DIR=<installDir>/current/native`
- `exec bun <installDir>/current/runtime/server.js`

shim（`~/.local/bin/tmex`、`~/.bun/bin/tmex`）指向 `<installDir>/current/cli/bin/tmex.js`，写入均为 temp+rename（包括 bun 目录的 symlink，禁止先 `rm` 再创建）。

`run.sh` 在 `exec` 前把自身 `$$` 写入 `<installDir>/tmex.pid`，使 `--no-service` / 手工启动的进程可被停止。`install-meta.json` 持久化 `serviceMode: managed | none`。`init --no-service` 用 flag 写入；upgrade 成功提交时把解析后的模式写回（legacy 无该字段时用 `--no-service` 回退，之后以 meta 为准）。upgrade/repair 读 meta（flag 不再覆盖已持久化的模式）。Web 升级继承该模式：`none` 且没有存活 pid 文件时拒绝，并提示先停进程。

## 阶段与崩溃表

| 阶段（journal.phase） | 动作 | 中断后的状态 | `--repair` / 下次 upgrade |
|---|---|---|---|
| `lock` | 取 `upgrade.lock` | 旧服务仍在跑 | 删 staging/候选（若有），标 `aborted` |
| `staging` | 下载到 `staging/<txn>`，校验 HTTP / tar / package.json 版本 / 布局；**目标版本 ≥ 1.1.4 必须拿到 SHA256SUMS HTTP 200、精确条目且 digest 匹配，404 一律中止**。更旧的目标版本仅在显式 `--allow-unverified` 时允许 404（CLI 默认拒绝；Web 永远不允许）。网络错误或其他非 2xx 必须中止。校验发生在解压/执行前（CLI、`install.sh`、gateway Web 升级同一语义）。解压后 rename 进 `versions/<to>`；若旧版本有 native 插件，在预启动前把当前 pin 装进候选目录 | 旧服务仍在跑；候选可能半成品 | 删 staging + 候选（永不删 `current` 指向的目录），标 `aborted` |
| `preflight` | 优先用候选 bun 的 `bun:sqlite` 做 `VACUUM INTO` 在线备份；失败则 `wal_checkpoint(TRUNCATE)` 后逐文件复制（运行中 WAL 仍可能不一致）。临时端口 + `TMEX_ROLES=standalone` + `TMEX_RUNTIME_MODE=preflight` 拉起候选（跳过 seed/refresh/push/agent/watch/tunnel/通知/TLS/mesh，仍跑 migrations），把 `{candidatePid, candidateStartedAt}` 写入 journal，轮询 `/healthz` 至 `status==ok && version==toVersion`（60s） | 旧服务未停；候选进程可能仍在 | 按 journal 中的 pid 校验 cmdline 含候选 `server.js` 后杀掉并等待退出，再删候选 |
| `stopping` | 停服务并确认进程退出 | 服务可能仍在跑或已停，`current` 仍指向旧版 | 若旧服务已在跑则不得再次 `start()`；否则拉起旧服务并做健康/运行验证后才清场 |
| `backup` | 复制 `tmex.db{,-wal,-shm}` 到 `backups/<txn>` | 服务已停，`current` 仍指向旧版 | 同 stopping：验证旧服务健康后才清场；失败则保留 journal+backup，非零退出 |
| `switching` | 原子切换 `current`；按需重写 `run.sh` | 可能仍指向旧版（rename 前）或已指向新版（rename 后） | 同 backup：验证旧服务健康后才清场 |
| `started` | 正式端口健康检查（新版本要求 `version===toVersion`） | `current` 已是新版，journal 未 committed | 立即再做健康检查：通过则 `committed` 并 GC；失败则停服务（失败则中止恢复）、按备份集合精确恢复 DB 三件套（先删目标 wal/shm）、`current` 切回。回滚旧版 `/healthz` **允许缺少 `version`**（1.1.3），但要求 `status===ok`、`current` 指向 `fromVersion`、`startedAt` 新于本次重启 |
| `committed` | 写 `install-meta.json`，GC | 新版在跑 | 只清残留 staging/backups |
| `aborted` / `rolled_back` | 终态 | 旧版可启动 | 只清残留 |

成功 GC：删 `staging/<txn>`；默认删 `backups/<txn>`（`--keep-backup` 写入 journal，后续 repair 尊重该标记）；`versions/*` 只留 `current` 与上一个 last-known-good；`committed` 后才删旧的顶层 `cli/` `runtime/` `resources/` `native/`。`--repair` 还会清无 journal 的孤儿 `staging/*`、以及 `upgrade-state.json.*.tmp` / `current.*.tmp` / `run.sh.*.tmp` / shim `tmex.*.tmp`，不碰 `current` 目标与 `data/`。

回滚到 1.1.3 时旧 `/healthz` 没有 `version` 字段：回滚路径允许缺省，候选/新版本仍做严格版本检查。回滚到 1.0.2 时 `/healthz` 只有 `{status:"ok"}`：managed 模式下先确认服务管理器报告 running，再只要求 HTTP `status===ok`。旧服务若原本已在跑，不得为了验证再次 `start()`。

预启动失败不会停旧服务。切换后健康失败会回滚 DB 与 `current`。stop 失败或进程仍存活时不得覆盖 DB。

相同版本升级是健康 no-op（不写 aborted journal）。`--allow-missing-native` 才允许在旧版有 native 插件时跳过候选安装。

## 旧布局迁移

已有机器是顶层 `cli/ runtime/ resources/ native/`。第一次 apply 在升级前做崩溃安全转换：按 `install-meta.json` 的 `cliVersion` 复制到 `versions/<from>/`，原子创建 `current`，原子重写 `run.sh` 与 shim。旧服务继续用原文件直到下次重启。仅在本次升级 `committed` 后删除顶层旧目录。缺少 `cliVersion` 则中止并给出明确错误。`init` 直接写新布局。`--no-service` 跳过 launchd/systemd，只管理进程（测试与无服务环境）。

## 操作说明

- 修复中断：`tmex upgrade --repair --install-dir <dir>`。每次 `upgrade` / `init` 开始时也会跑同样的恢复。
- 备份位置：`<installDir>/backups/<txnId>/`。成功默认删除；`--keep-backup` 保留。
- 手工回滚（journal 损坏时）：停服务 → 把 `backups/<txn>/tmex.db{,-wal,-shm}` 拷回 `data/` → `ln -sfn versions/<fromVersion> current` → 启动服务。不要 `rm -rf` `current` 指向的目录。
- 跨进程锁：`upgrade.lock`。记录 pid + 启动身份（`ps -o lstart=` / `/proc/<pid>/stat` starttime）。pid 已死或身份不符视为 stale，可被 `--repair` 回收。
- 未知 CLI 参数（含误把 `--help` 当升级）会被拒绝；`--help` / `-h` 显示帮助。
- 预启动禁用 mesh/uplink：候选进程设 `TMEX_ROLES=standalone`（不连 Hub、不开 peer 口）。`/healthz` 现带 `version`（构建期 `TMEX_MONOREPO_VERSION`）。mesh 节点未登录时的精简 `/healthz` 由 runtime `attachStartedAt` 补上 `version`。
- Web 触发的升级把 stage 放在 `<installDir>/staging/<txn>`，并传 `--txn` 给 CLI；清理交给 journal。

## 验收要点

- 任意阶段 `kill -9` CLI 后，`tmex upgrade --repair` 能回到可启动的旧版或提交新版。
- 新版本在 `/healthz` 的 `version` 匹配之前，旧 `current` 不被替换。
- `packages/app` 的 journal / lock / 原子切换 / 旧布局转换 / GC / sha256 / apply dry-run 测试覆盖上述决策。
