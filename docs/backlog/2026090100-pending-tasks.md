# 待办任务（2026-09-01 起）

第九轮（v1.1.4/v1.1.5，档案 `prompt-archives/2026083102-relay-files-switch-lan-round9/`）收尾后保留的任务清单。完成一项删一项；接手前先读该档案的 `plan-00-result.md`。

## 1. 崩溃安全升级器（P0，唯一大块）

- **现状**：完整实现在分支 `feat/crash-safe-upgrade`（提交 `e7cc4ac7`，已 push），未随 1.1.4/1.1.5 发布。设计与现状评估见 `docs/release/2026083101-upgrade-crash-safety.md`。
- **必修 blocker**（`prompt-archives/.../sub/review-J.md`，逐条有 file:line 与失败序列）：
  1. `--repair` 会误删正在执行的 staging 包（首次在线升级必然失败）；
  2. 旧布局转换在 `committed` 前就删除运行中服务依赖的顶层目录；
  3. preflight 候选会触发生产副作用（agent 续跑 / Telegram / push / tunnel / TLS-ACME）——需要只跑迁移与 healthz 的 preflight 模式；
  4. 1.0.2 的 `/healthz` 无 `startedAt`，回滚验证永远失败、journal 卡在非终态；
  5. `serviceMode=none` 只验 pid 存活不验所有权，可能杀错进程并在旧进程仍持库时覆盖 DB；
  6. SHA256SUMS 对 404 fail-open（CLI / install.sh / Web 三入口需统一：目标版本 ≥1.1.4 必须校验，兼容旧版本走显式 `--allow-unverified`）；
  7. `backup` 阶段崩溃后 repair 会在旧进程仍在跑时再启动一个。
- **should-fix**（同文件）：`upgrade-db.ts` 的 `bun -e` argv 索引错误（VACUUM INTO 恒失败退化为文件拷贝）、Web 升级子进程早退后 controller 卡 `executing`、同版本升级应为 no-op、`keepBackup` 入 journal、repair 清理无 journal 垃圾与 `*.tmp`、1.0.2 旧布局无 `cli/` 时 shim 过早指向不存在的文件。
- **验收**：修完复跑 codex 审查；scratch 演练（配方在 `sub/G5b-result.md`：legacy 1.1.3 起服务 → apply → committed；人为破坏 → `--repair` → `rolled_back`；各阶段 kill 注入）；**补 launchd（macOS）与 systemd（Linux）双服务模式的真实演练**后再发版。
- **接手方式**：从该分支开 worktree，先 merge main（main 已含 r9 全部改动与 1.1.5）。

## 2. 小修与债务（P2）

1. **SelectionToolbar 吞点击**：有选区时工具条覆盖 pane 顶部居中约 3 行区域，该区域无法再发起选择（既有问题）。方向：终端内 pointer-down 先收起工具条，或把工具条挪出文本区。分析见 `prompt-archives/.../sub/O3-result.md` 末尾。
2. **`node-login-<id>` testid 重复**：设备页与侧栏 Files 分节各渲染一份，`apps/fe/tests/helpers/mesh.ts:241` 的裸 `getByTestId` 在 Files tab 打开时会 Playwright strict-mode 冲突。按外层容器收窄或改名。见 `sub/V1-result.md` 观察项 O5。
3. **hub-e2e driver 空操作 select**：`scripts/hub-e2e/driver/terminal.ts` 的 select 硬编码 `windowId: null`，网关对缺 windowId 的 `TMUX_SELECT` 静默丢弃（`apps/gateway/src/ws/tmux-command-handlers.ts`），该 select 实为 no-op，输出只靠订阅在流。修正为带真实 windowId。
4. **e2e 预存失败清理**：`sidebar-resize.spec.ts:40`（等 `Toggle Sidebar` 按钮 90s 超时）与 `mobile-mouse-reporting.spec.ts:205`（单指拖动无 motion 事件）已确认在 main 基线上同样失败（2026-09-01 定向复跑），加上既有的 `agent-session:404`、`settings-llm:42`、`ws-borsh-theme-resize:39`。逐条修测试或产品，修完同步 `docs/known-issues.md` KI-3 与 memory `e2e-baseline-failures`。
