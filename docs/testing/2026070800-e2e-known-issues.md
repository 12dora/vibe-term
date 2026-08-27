# e2e 已知问题清单（2026-07-08）

> 背景：fe 分包重构（P1–P6）期间对全量 e2e 做了多轮「改动前后逐用例对照 + 失败候选单跑/基点采样」，
> 积累出本清单。判定方法与证据见 `prompt-archives/2026070600-fe-package-split/`。
> 本清单与分包改动无关——全部条目在改动前基点（af0666b / a107559）可复现。

## 一、确定性失败（疑似测试自身缺陷，待修）

| 用例 | 现象 | 根因分析 |
|---|---|---|
| `mobile-terminal-interactions.spec.ts` ×4 | 等待 `editor-shortcut-ctrl-c` 超时（element not found） | 测试期望 `editor-shortcut-*` testid，但 DevicePage 的 ShortcutsBar 显式传 `idPrefix="terminal-shortcut"`（f0a3f3f1 起），且 ui store 默认 `inputMode='direct'`——干净 localStorage 下首屏不存在该 testid。疑似 testid 约定变更后测试未跟进 |
| `mobile-settings.spec.ts` | `settings-enable-browser-bell-toast` 不可见超时 | 移动视口下该设置项未渲染/testid 缺失，待排查（与上一条同期出现） |
| `settings-llm.spec.ts` | select 下拉选项 `Tavily` click 超时 | 下拉弹层在该流程下未出现，疑组件交互时序，待排查 |

## 二、负载敏感抖动族（全量跑随机挂、单跑大多通过）

以下用例在低负载单跑时通过率高，全量顺序跑（workers=1，约 9-12 分钟）时随机失败；
改动前后基点采样失败率一致（如 `bug4` 两侧均 6 轮 3 挂）：

- `terminal-render-regressions.spec.ts`（bug2 / bug4：resize 重建对齐类，抖动率约 50%）
- `ws-borsh-theme-resize.spec.ts`、`theme-propagation.spec.ts`（rapid theme toggle × resize 压力类）
- `mobile-mouse-reporting.spec.ts`（触控 motion 流类，每轮随机挂 0-1 个）
- `terminal-mouse-drag-recovery.spec.ts`（1002 drag tracking window round-trip）
- `ws-borsh-switch-barrier.spec.ts`（rapid select 事务取消，偶发）

## 三、环境结论与建议

1. 本机（开发机，常有并行负载）全量 e2e 存在约 11-13 例随负载漂移的不稳定用例，
   无法作为回归判定的唯一依据；分包期间的替代方法是「基线失败名单对照 + 候选单跑/基点采样」。
2. 建议：低负载 CI 环境建立稳定基线；第一类确定性失败修复测试本身；
   第二类压力型用例考虑放宽阈值或标记 `@flaky` 单列。
3. e2e 会在 `tmex-e2e` 专用 socket 上创建名为 `tmex` 的 session（local 设备默认 session 名），
   属测试产物，可随 socket 清理；勿与默认 socket 上的开发/生产 session 混淆。
