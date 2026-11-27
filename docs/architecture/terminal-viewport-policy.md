# 终端视口策略：最小可见客户端拥有 PTY 尺寸

本文描述多个浏览器同时打开同一 tmux pane 时 PTY 尺寸的仲裁规则与 `TERM_VIEWPORT` / `TERM_VIEWPORT_POLICY` 协议；面向改动尺寸同步的开发者。

## 背景

一个 tmux pane 对应一个共享 PTY。原先每个浏览器的尺寸上报都会 `resize-window` / `resizePane`，手机打开同一 pane 会把桌面端的几何压小。

> 尺寸命令统一走 canonical `ResizePaneV11`，语义由 `geometryReason` 区分：`change`（0）= 真实尺寸变化，`resend`（1）= 补发当前尺寸。命令还带 `sizeEpoch`（u64，恒 ≥ 1）：真实尺寸变化时自增，补发复用原值，网关据此丢弃过期尺寸（同 epoch 的补发必须放行）。

## 规则

按 `(deviceId, windowId)` 收集各会话的 claim。**仅 `visible=true` 参与竞选**：`cols` 最小者胜；并列再比最小 `rows`，再比最低 `session.id`。（2026-09-02 起；此前取面积最大者，导致手机与桌面同看一个 pane 时手机拿到桌面宽度的 PTY，全屏 TUI 溢出屏幕。按列数而非面积比较：竖屏手机面积可能大于矮宽窗口。）这与 tmux 多客户端 `window-size smallest` 的语义一致：任何可见客户端都不会溢出，较大的客户端跟随较小几何。Winner 的几何与该 window 上次已应用几何不同时才走现有 tmux resize 路径。无可见 claim 时保持当前尺寸。

`ResizePaneV11`（两种 `geometryReason`）视为 `visible=true` claim（老客户端不发 `TERM_VIEWPORT` 时等同永久可见）。pane 在快照中找不到则忽略 claim；resize 类消息仍按旧逻辑 `resizePane`。`change` 走按 live 几何（快照缺失时退回 `lastAppliedViewport`）去重的常规路径；`geometryReason = resend`（暖切换 / reload / 重连后重新声明当前尺寸）**不做任何去重**，强制把 winner 几何重新下发到 tmux：快照几何与 `lastAppliedViewport` 都是网关侧的乐观记录，可能与 tmux 实际几何不符（tmux 对同尺寸 `resize-window` 是空操作，不产生 SIGWINCH）。若强制下发既没改变几何（相对 live / `lastAppliedViewport`）也没改变 winner，则不向全体 claimant 广播 `TERM_VIEWPORT_POLICY`，只按常规规则通知首次声明 / 策略有变的会话。

参与仲裁的会话 = 设备条目的 `clients`（`DEVICE_CONNECT` 登记）∪ `canonicalClients`（canonical 挂载登记；终端可在 `device-connected` 前发尺寸）。任何触发点（声明、断开重算、快照对账、失联巡检）都用同一集合。

会话关闭、设备断开、重连失败清理时丢弃该会话相关 claim，并（除重连失败、runtime 已释放外）重算 winner。

## 会话存活与失联剔除

网关不主动 ping 客户端，存活只看入站：每个解码出的入站帧（任意 carrier：直连 WS、`mesh_link_stream`、WebRTC 直连）在 `handleDecodedEnvelope` 处刷新会话的 `lastInboundAt`；HELLO 的 `clientImpl` 为自家客户端（`vibeterm-fe` / `tmex-fe` / `vibeterm-cli`，连上即定时发 `PING`）或实际收到过 `PING` 的会话标记为「可判心跳」。入口 failover 重放的是浏览器原始 HELLO，重建出的会话同样可判。

- **失联剔除**：可判心跳的会话超过 `VIEWPORT_CLAIM_STALE_MS`（45 s，= 3× HELLO 播报的 15 s 心跳，且大于客户端可见态最长 30 s 的 PING 间隔）无入站，即视为失联。失联会话的 claim 保留，但仲裁时按不可见处理；仍会收到 `owner=false` 的 `TERM_VIEWPORT_POLICY`。
- **巡检**：`WebSocketServer` 持有一个 5 s 的 `unref` 定时器（有会话时启动，最后一个会话关闭或 `closeAll` 时清除）。会话刚进入失联时，对它持有可见 claim 的每个 `(deviceId, windowId)` 重算一次：次小的存活 claimant 成为 owner、tmux 被 resize、所有 claimant 收到新策略。
- **复活**：失联会话再发来任意帧时只先盖章；等这条消息处理完（含异步处理；分片帧等重组后的消息处理完）再按它最新的 claim 重算其可见 window（它可能重新胜出）。这样撤回（`visible=false`）或改尺寸的帧不会让旧 claim 先赢一次。
- **回收**：可判心跳且「可回收」的会话超过 `SESSION_IDLE_TIMEOUT_MS`（180 s，大于 3× 隐藏态 60 s pong 超时及浏览器后台每分钟一次的定时器节流）无入站，按正常关闭路径关掉（`closeSession` → claim / canonical 挂载 / 分享索引等一并释放），关闭码 `4408`、原因 `idle-timeout`，并打一行 info 日志 `[ws] client idle timeout session=… carrier=…`。`4408` 是 mesh 终止关闭码：入口 Hub 不 failover、不用缓存的视口声明在节点上重建会话，而是把关闭码原样透给浏览器；浏览器按普通断线重连（只有 4401 / 4410 才停止重连）。
- **回收的版本兼容边界**：会话是否可回收按 primary carrier 判定（WebRTC 直连 carrier 属于同一会话，不单独判）。直连浏览器 WS 恒可回收；`mesh_link_stream` 仅当入口在 ws 流 OPEN 载荷上声明 `idleClose: true` 时可回收。旧入口不认识 `4408`，会把它当 `1011` 链路抖动 failover，重放缓存的 HELLO 与视口声明，等于每 180 s 复活一次僵尸会话；因此对未声明的入口只做 45 s 失联剔除，不发 `4408`。新入口 + 旧节点无影响（旧节点不发 `4408`）。
- **其余从不发 PING 的客户端**（第三方客户端）无法按静默判断死活：既不做失联剔除，也不回收。

## 终端的挂载时机与「连接中」蒙层

2.2.0 起终端**不再等 `device-connected`**：只要本地拓扑 / 路由能解析出 pane id（`resolvedPaneId`），
就立刻挂 `Terminal` 并开始几何测量与首屏请求（首屏由 canonical 能力协商完成触发，见
[ws 状态机](./ws-state-machines.md)）。高延迟链路上这把「等连接 → 再挂载 → 再测量 → 再要屏」的串行
压成并行。

- 设备尚未连上（`!deviceConnected && !isReconnecting`）时在终端上叠一层 `ConnectingOverlay`
  （`data-testid="terminal-connecting-overlay"`，`pointer-events-none`、`z-10`，文案走 i18n `terminal.connecting`），
  单屏与分屏两条分支都盖。
- **重连期间不叠**：已有内容仍在画面上，重连状态由重连徽标表达，盖一层灰会让人以为内容没了。
- 快照已确认该 pane 被关闭时不挂终端、也不显示蒙层——路由对账会立刻回落到幸存 pane。
- 首个 `ScreenCommit` 走 `TerminalSurface.replace()`（清 history 页、`preserveViewport: false`）整屏重写，
  占位期间的任何本地内容都会被这一次重写覆盖；`SourceGap` 走 rebase 重取。

## 协议

- C2S `TERM_VIEWPORT`（0x0308）：`{ deviceId, paneId, cols, rows, visible }`
- S2C `TERM_VIEWPORT_POLICY`（0x0309）：`{ deviceId, windowId, paneId, owner, cols, rows }`

`paneId` 是收件方自己 claim 的 pane；`windowId` 是策略作用的 tmux window。`owner=true` 继续上报容器尺寸；`owner=false` 跟随权威 `cols×rows` 并本地平移。winner / 已应用几何变化时发给该 window 上所有 claimant；某会话对该 window 的首次 claim 后立即单发一次。快照不按客户端个性化。

## 边界

- 单客户端：唯一 claimant 即 owner，resize 行为与改造前一致。是否 apply 以 snapshot 窗口几何为准（单 pane 用 pane 宽高，多 pane 用 layout）；snapshot 不可用时才回退 `lastAppliedViewport`。tmux 侧改布局后重复同一次 `resend` 仍会纠正。
- 最小端隐藏或断线：次小可见端成为 owner 并被应用到 tmux（手机切到后台即释放 claim，桌面恢复自身尺寸）。
- 最小端冻结（锁屏 / 进程挂起，既没发 `visible=false` 也没断链路）：45 s 后被失联剔除，次小存活端接管；180 s 后会话被回收。
- 全员 hidden：不 resize。
- 分屏拖拽（`TMUX_RESIZE_PANE` / stacked layout）不走本策略。
- 带尺寸的 `TMUX_SELECT` 先记录 claim 并解析该 window 的 winner，再分发：owner 走 `selectPaneWithSize`（先 resize 再 select），即使 snapshot / `lastAppliedViewport` 已等于请求几何（tmux 漂移或重连后）也仍走该有序路径。follower 走无尺寸 `selectPane`；若窗口实时几何与 winner 不同，则按 winner 几何走同一有序路径，使首屏在权威尺寸下捕获，不得把 PTY 改成 follower 尺寸。（`wantHistory` 已随 legacy 状态流下线，wire 上恒 false；首屏改由 canonical `RequestScreen` 触发。）
- 同一 window 内 `paneId` 变化立即向该会话下发新 pane 的 `TERM_VIEWPORT_POLICY`（即使 winner / 几何未变）。
- 快照安装（非每帧输出）时对该设备条目上所有会话的全部 claim 重绑：pane 消失则丢弃，pane 换 window 则改 key，并重算/apply/通知源与目标 window；已关闭 window 的 `lastAppliedViewport` / `lastViewportWinnerId` 清掉。resize 只作用于策略的 `windowId`。
