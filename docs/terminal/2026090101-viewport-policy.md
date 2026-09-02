# 终端视口策略：最小可见客户端拥有 PTY 尺寸

## 背景

一个 tmux pane 对应一个共享 PTY。原先每个浏览器的 `TERM_RESIZE` / `TERM_SYNC_SIZE` 都会 `resize-window` / `resizePane`，手机打开同一 pane 会把桌面端的几何压小。

## 规则

按 `(deviceId, windowId)` 收集各会话的 claim。**仅 `visible=true` 参与竞选**：`cols` 最小者胜；并列再比最小 `rows`，再比最低 `session.id`。（2026-09-02 起；此前取面积最大者，导致手机与桌面同看一个 pane 时手机拿到桌面宽度的 PTY，全屏 TUI 溢出屏幕。按列数而非面积比较：竖屏手机面积可能大于矮宽窗口。）这与 tmux 多客户端 `window-size smallest` 的语义一致：任何可见客户端都不会溢出，较大的客户端跟随较小几何。Winner 的几何与该 window 上次已应用几何不同时才走现有 tmux resize 路径。无可见 claim 时保持当前尺寸。

`TERM_RESIZE` / `TERM_SYNC_SIZE` 视为 `visible=true` claim（老客户端不发 `TERM_VIEWPORT` 时等同永久可见）。pane 在快照中找不到则忽略 claim；resize 类消息仍按旧逻辑 `resizePane`。

会话关闭、设备断开、重连失败清理时丢弃该会话相关 claim，并（除重连失败、runtime 已释放外）重算 winner。

## 协议

- C2S `TERM_VIEWPORT`（0x0308）：`{ deviceId, paneId, cols, rows, visible }`
- S2C `TERM_VIEWPORT_POLICY`（0x0309）：`{ deviceId, windowId, paneId, owner, cols, rows }`

`paneId` 是收件方自己 claim 的 pane；`windowId` 是策略作用的 tmux window。`owner=true` 继续上报容器尺寸；`owner=false` 跟随权威 `cols×rows` 并本地平移。winner / 已应用几何变化时发给该 window 上所有 claimant；某会话对该 window 的首次 claim 后立即单发一次。快照不按客户端个性化。

## 边界

- 单客户端：唯一 claimant 即 owner，resize 行为与改造前一致。是否 apply 以 snapshot 窗口几何为准（单 pane 用 pane 宽高，多 pane 用 layout）；snapshot 不可用时才回退 `lastAppliedViewport`。tmux 侧改布局后重复同一 `TERM_SYNC_SIZE` 仍会纠正。
- 最小端隐藏或断线：次小可见端成为 owner 并被应用到 tmux（手机切到后台即释放 claim，桌面恢复自身尺寸）。
- 全员 hidden：不 resize。
- 分屏拖拽（`TMUX_RESIZE_PANE` / stacked layout）不走本策略。
- 带尺寸的 `TMUX_SELECT` 先记录 claim 并解析该 window 的 winner，再分发：owner 的 `wantHistory` 冷选择走既有 `selectPaneWithSize`（先 resize 再 capture），与改造前单客户端字节级一致，即使 snapshot / `lastAppliedViewport` 已等于请求几何（tmux 漂移或重连后）也仍走该有序路径。follower 走无尺寸 `selectPane`；若窗口实时几何与 winner 不同，则按 winner 几何走同一有序路径，使 history 在权威尺寸下捕获，不得把 PTY 改成 follower 尺寸。`wantHistory:false` 仍 `focusPane`，尺寸只经策略 apply。
- 同一 window 内 `paneId` 变化立即向该会话下发新 pane 的 `TERM_VIEWPORT_POLICY`（即使 winner / 几何未变）。
- 快照安装（非每帧输出）时对该设备条目上所有会话的全部 claim 重绑：pane 消失则丢弃，pane 换 window 则改 key，并重算/apply/通知源与目标 window；已关闭 window 的 `lastAppliedViewport` / `lastViewportWinnerId` 清掉。resize 只作用于策略的 `windowId`。
