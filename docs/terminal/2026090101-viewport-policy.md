# 终端视口策略：最大可见客户端拥有 PTY 尺寸

## 背景

一个 tmux pane 对应一个共享 PTY。原先每个浏览器的 `TERM_RESIZE` / `TERM_SYNC_SIZE` 都会 `resize-window` / `resizePane`，手机打开同一 pane 会把桌面端的几何压小。

## 规则

按 `(deviceId, windowId)` 收集各会话的 claim。**仅 `visible=true` 参与竞选**：`cols*rows` 最大者胜；并列再比 `cols`、`rows`，再比最低 `session.id`。Winner 的几何与该 window 上次已应用几何不同时才走现有 tmux resize 路径。无可见 claim 时保持当前尺寸。

`TERM_RESIZE` / `TERM_SYNC_SIZE` 视为 `visible=true` claim（老客户端不发 `TERM_VIEWPORT` 时等同永久可见）。pane 在快照中找不到则忽略 claim；resize 类消息仍按旧逻辑 `resizePane`。

会话关闭、设备断开、重连失败清理时丢弃该会话相关 claim，并（除重连失败、runtime 已释放外）重算 winner。

## 协议

- C2S `TERM_VIEWPORT`（0x0308）：`{ deviceId, paneId, cols, rows, visible }`
- S2C `TERM_VIEWPORT_POLICY`（0x0309）：`{ deviceId, windowId, paneId, owner, cols, rows }`

`paneId` 是收件方自己 claim 的 pane；`windowId` 是策略作用的 tmux window。`owner=true` 继续上报容器尺寸；`owner=false` 跟随权威 `cols×rows` 并本地平移。winner / 已应用几何变化时发给该 window 上所有 claimant；某会话对该 window 的首次 claim 后立即单发一次。快照不按客户端个性化。

## 边界

- 单客户端：唯一 claimant 即 owner，resize 行为与改造前一致。是否 apply 以 snapshot 窗口几何为准（单 pane 用 pane 宽高，多 pane 用 layout）；snapshot 不可用时才回退 `lastAppliedViewport`。tmux 侧改布局后重复同一 `TERM_SYNC_SIZE` 仍会纠正。
- 更大端隐藏或断线：次大可见端成为 owner 并被应用到 tmux。
- 全员 hidden：不 resize。
- 分屏拖拽（`TMUX_RESIZE_PANE` / stacked layout）不走本策略。
- 带尺寸的 `TMUX_SELECT` 走同一 claim 路径：只 select，尺寸仅当该会话是该 window 的 winner 时才应用；follower 切 pane 不得改 PTY。snapshot 已偏离 winner 时纠正。
- 同一 window 内 `paneId` 变化立即向该会话下发新 pane 的 `TERM_VIEWPORT_POLICY`（即使 winner / 几何未变）。
- 解析 winner 时按 snapshot 重绑 `paneId`：pane 消失或已换 window 则丢弃该 claim 并重算相关 window；已关闭 window 的 `lastAppliedViewport` / `lastViewportWinnerId` 清掉。resize 只作用于策略的 `windowId`。
