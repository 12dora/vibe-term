# tmex 自升级的崩溃安全性评估

日期：2026-08-31　范围：`packages/app`（`tmex-cli` 的 `init` / `upgrade` / `upgrade --apply-current-package`）、`install.sh`、`apps/gateway/src/system/upgrade.ts`（Web 触发的后台升级）。

## 结论

**当前（≤1.1.4）升级流程不是 crash-safe 的。** 进入 `--apply-current-package` 后旧版本先被停止，然后在安装目录**原地删除再复制**；此时断电、`kill -9` CLI 或机器重启，都可能留下一棵启动不了的混合树，且没有任何日志/标记让下一次启动或 `upgrade` 自动修复。回滚只在 CLI 进程存活且抛出异常时执行，且不覆盖数据库。

## 现状流程与中断后的状态

| 步骤 | 代码 | 中断后的状态 |
|---|---|---|
| 解析版本、下载 tgz 到系统临时目录（只做 HTTP 成功检查，无 checksum/签名） | `lib/release-fetch.ts`、`commands/upgrade.ts` | 旧版继续运行，仅残留临时目录 |
| 解压后检查 `bin/tmex.js` 与目录结构，委托新包的 CLI 执行 apply | `commands/upgrade.ts`、`lib/install-layout.ts` | 旧版继续运行 |
| **停止服务**，不校验进程是否真的退出 | `lib/service.ts` | 服务已停，旧树仍完整（可手动拉起） |
| 备份 `runtime/ resources/ run.sh install-meta.json cli/` 到**系统临时目录**（不含 `data/tmex.db{,-wal,-shm}`、`native/`、`app.env`、shim、unit/plist） | `lib/install.ts` | 备份不持久、无 journal |
| `rm -rf` runtime / fe-dist / drizzle 后逐目录 `copy`；`cli/` 删后重建；`~/.bun/bin/tmex` 先 `rm` 再 `symlink` | `lib/install.ts`、`lib/cli-shim.ts` | **旧树被破坏**；unit/plist 指向的稳定 `run.sh` 会启动半棵新树 |
| 合并 `app.env`（原子）；**重写 `run.sh`、`install-meta.json`（非原子，且在健康检查之前）** | `lib/install.ts`、`lib/json-file.ts` | 文件可能截断；元数据先于可用的新服务 |
| 重写 unit/plist、启动服务；新 runtime 首启即执行迁移 | `apps/gateway/src/runtime.ts` | 迁移提交后即使回滚文件，旧 runtime 面对的是新 schema |
| 健康检查：本机 `GET /healthz` 2xx，4s×30s，不看版本 | `commands/upgrade.ts` | — |
| 异常才回滚：删后复制旧文件、重装服务；回滚前**没有停止新服务**，不恢复 DB/native/shim | `commands/upgrade.ts`、`lib/install.ts` | 再次中断会留下部分旧树 |
| `finally` 删除备份目录 | `commands/upgrade.ts` | 断电时不会执行 |

其他：`init --force` 会 `rm -rf` 整个安装目录；CLI 无跨进程锁，Web 端 `UpgradeController` 只在同一 gateway 进程内防并发；现有测试不覆盖 apply/rollback/半棵树。

## 风险排序

1. P0 原地删除/复制、无持久 journal。
2. P0 无数据库备份：新迁移提交后无法回到旧 schema。
3. P0 回滚不先停新服务，且回滚本身也是删后复制。
4. P1 新文件与 `install-meta.json` 都在健康检查之前落地。
5. P1 tarball 无 checksum/签名校验；`install.sh` 同样。
6. P1 无跨进程升级锁；`native/`、shim、unit/plist 不在同一事务内。
7. P2 健康检查只看 `/healthz` 2xx（1.1.4 起 `/healthz` 已带 `version`，为后续方案铺路）。
8. P2 临时下载/备份目录无 crash 清理。

## 目标方案（已在分支 `feat/crash-safe-upgrade` 实现，待加固后随后续版本发布）

```text
<installDir>/
  versions/<version>/{cli,resources,runtime,native}
  current -> versions/<known-good>      # 原子 rename 切换
  staging/<txn>/                        # 与 versions 同一文件系统
  upgrade-state.json                    # journal：阶段 / from / to / dbBackup / candidatePid
  upgrade.lock                          # O_EXCL 跨进程锁（pid + 启动身份）
  data/tmex.db  app.env  run.sh         # 位置不变；run.sh/shim 经 current 解析
```

流程：下载到 `staging/` → 校验 `SHA256SUMS`/版本/布局 → rename 到 `versions/<v>` → 取锁、写 journal → 候选以 DB 副本 + 临时端口预启动并按 `/healthz.version` 校验 → 停旧服务并确认退出 → 备份 `tmex.db{,-wal,-shm}` → 原子切换 `current` → 启动正式服务并复查健康 → journal `committed`，GC（只留 current + 上一版）；任一阶段失败：停服务、恢复 DB 三件套、`current` 切回、拉起旧版，`--repair` 可从任意阶段续做或清场；旧顶层布局首次 apply 时先复制成 `versions/<from>` 再切 `current`，`committed` 后才删旧目录。

该分支两轮审查（`prompt-archives/2026083102-relay-files-switch-lan-round9/sub/review-I.md`、`review-J.md`）仍列有必须先修的问题：repair 误删在飞的 staging 包、旧布局转换过早删除运行中服务依赖的顶层目录、预启动会触发生产副作用（agent 续跑 / Telegram / tunnel / ACME）、1.0.2 的 `/healthz` 无 `startedAt` 导致回滚校验卡住、`--no-service` 的 pid 所有权、SHA256 对 404 fail-open、`backup` 阶段崩溃后重复启动。修复并在 launchd / systemd 两种服务模式下完整演练前，不应用于生产。

## 过渡期的人工兜底

升级请在空闲时执行，先手工备份 `data/tmex.db{,-wal,-shm}`；若中途断电，用同版本 tarball 重跑 `npx tmex-cli@<version> upgrade --apply-current-package`（整体重写 `runtime/ resources/ cli/`），再按需恢复数据库备份。1.1.4 起 `tmex upgrade` 拒绝未知参数，避免误触默认安装目录。
