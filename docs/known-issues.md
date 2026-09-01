# 已知问题（Known Issues）

本文件登记尚未解决的已知问题。解决后从本文件移除（并在对应模块文档留存背景）。

## KI-2：缺真 tmux 全链路 e2e 集成测试（run_command）

- **背景**：run_command/流式读屏的各层已分别单测覆盖（真 OSC 字节过 parser、真 ghostty wasm、run_command 全分支以 fake emulator）。
- **现状**：缺一条「真 tmux → control-mode 流 → parser → emulator → run_command」的端到端集成测试（验证长输出不丢/退出码正确/vim 等 alternate 屏被拒）。
- **解决方向**：参考 `local-external-connection.integration.test.ts` 的 `-L` 临时 socket 模式，起带 control-mode 流的真实会话跑 run_command。
- **详情**：`docs/agent/2026061303-run-command-headless-ghostty.md`。

## KI-3：fe e2e 固定失败基线

`cd apps/fe && bun run test:e2e` 在 main 上稳定失败以下用例，**属于测试自身缺陷，不是产品回归**；判断分支是否引入回归时须与本清单逐条对照，而不是看失败数是否为 0。

| 用例 | 症状 / 疑因 |
| --- | --- |
| `mobile-settings.spec.ts:5` | 选择器 `settings-enable-browser-bell-toast`、`settings-tab-devices` 已过期，移动视口下等不到元素 |
| `mobile-terminal-interactions.spec.ts:79/140/221/303` | 等 `editor-shortcut-*` testid 超时；ShortcutsBar 现传 `idPrefix="terminal-shortcut"`，且 ui store 默认 `inputMode='direct'`，干净 localStorage 下首屏无该 testid |
| `terminal-mouse-recovery.spec.ts:311/355/407`（依赖 `opencode` 的三例） | 2026-09-01 起本机 opencode 1.15.12 启动 >20 s（附带「Update Available」弹窗），`alternate_on` 轮询超时，页面尚未打开即失败；main 同环境同样失败，属环境问题。低负载下 opencode 约 12 s 进入 alt screen，可考虑放宽超时或在 harness 里禁用 opencode 更新检查 |
| `agent-session.spec.ts:538`（provider unreachable） | 偶发（repeat-each 3 中 1 失败）：发送成功、后端已报错，但截图停在 Terminals tab，错误横幅不在屏上 |

- **解决方向**：前两项修测试选择器/时序；后两项偶发类，先在低负载下建稳定复现再定位。
- 2026-09-01（round10）已修并移出本清单：`sidebar-resize:40`（testid 过期）、`mobile-mouse-reporting:205`（单指语义已改为滚轮）、`settings-llm:42`（mock 缺 `searchProviders`）、`agent-session:404`（composer 控件溢出遮挡 Send，产品修复）、`ws-borsh-theme-resize:39`（基线取样过早，spec 改稳定基线+窗口总量断言）。
- **另注**：全量顺序跑（workers=1，约 10 分钟）时 `terminal-render-regressions`、`theme-propagation`、`mobile-mouse-reporting`、`terminal-mouse-drag-recovery`、`ws-borsh-switch-barrier` 会随机抖动，低负载单跑通过率高；本机全量 e2e 不能作为回归判定的唯一依据。
