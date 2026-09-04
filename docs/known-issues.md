# 已知问题（Known Issues）

本文件登记尚未解决的已知问题。解决后从本文件移除（并在对应模块文档留存背景）。

## KI-3：fe e2e 固定失败基线

`cd apps/fe && bun run test:e2e` 在 main 上曾稳定失败的用例，截至 2026-09-03（1.1.19）已全部修复并定向复跑通过：`mobile-settings.spec.ts`（webhook 创建与切语言两处竞态）、`mobile-terminal-interactions.spec.ts`（切编辑模式后等快捷键栏唯一化、滚动断言改为真实等待）、`agent-session.spec.ts`（等错误横幅前重新选中 Agent tab）。本清单当前为空；判断分支是否引入回归时以定向复跑为准。

- 历史（2026-09-01 round10 / round12、2026-09-03 round19）已修项见各轮档案。
- **另注**：全量顺序跑（workers=1，约 10 分钟）时 `terminal-render-regressions`、`theme-propagation`、`mobile-mouse-reporting`、`terminal-mouse-drag-recovery`、`ws-borsh-pane-switch`、`ws-borsh-resize:268`、`mobile-keyboard-avoidance:188` 会随机抖动，低负载单跑通过率高；本机全量 e2e 不能作为回归判定的唯一依据。gateway 全量单测在高负载下 `dc-handshake`、`run-command` 的 `--More--` 用例偶发失败，隔离复跑通过。
