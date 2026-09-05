# tmex-ws-borsh-v1：WebSocket 二进制协议规范

> 状态：**已实现**，本文是 wire 格式的唯一真源。
>
> 适用范围：`apps/gateway` <-> `apps/fe` / `packages/ws-client`。
>
> 编解码实现：统一放在 `packages/shared/src/ws-borsh/`（`kind.ts` 定义 kind 常量，`schema.ts` 定义结构，`codec.ts` 收发），两端复用。
>
> 状态机与切换语义见 `docs/ws-protocol/2026021403-ws-state-machines.md`（文末附录记录 1.1.23 移除的 selectToken 屏障与 canonical 的对应）。

## 背景

本协议引入前，链路存在这些结构性问题：

- 协议混合（JSON + 自定义二进制 output），难以做一致的顺序保证与版本演进。
- pane 切换与 history/live 合并缺少事务屏障，容易出现乱序、丢失、重复。
- resize、bell、事件语义分散，难以系统性测试与回归。

因此定义 `tmex-ws-borsh-v1`：基于 Borsh 的全二进制 WS 协议，配合显式状态机提供确定性行为。（当年的 `selectToken` 屏障已在 1.1.23 由 canonical 首屏事务取代，见下文。）

## 依赖与约束

- 依赖：`@zorsh/zorsh`。
- 编码规则遵循 Borsh：
  - 整数小端序。
  - `string` 为 `u32` 长度前缀 + UTF-8 bytes。
  - `bytes()` 为 `Vec<u8>`（`u32` 长度前缀 + raw bytes）。
  - `bytes(N)` 为 `[u8; N]` 固定长度，无长度前缀。
  - `vec(T)` 为 `u32` 长度前缀 + 连续元素。
  - `option(T)` 为 `u8` discriminator（0/1）+ value。

实现约束：

- wire 层禁止直接使用 `hashMap/hashSet`（顺序不确定）。映射/集合统一用 `vec(entry)` 表示。
- 协议版本使用 `Envelope.version` 显式演进。
- 顶层消息类型使用显式 `kind(u16)`，不使用 `b.enum(...)` 变体序号。
- `CANONICAL_COMMAND` / `CANONICAL_EVENT` 的 payload 是唯一例外：其版本化的嵌套命令/事件使用 `b.enum(...)`。声明顺序就是 `u8` wire discriminator，所有 discriminator 由 golden test 固定；v1 冻结后新增 variant 必须升级 canonical protocol version/capability，不能只在尾部追加并假设旧客户端可解码。

## 术语

- **Envelope**：每条 WS binary message 的最外层结构。
- **kind**：消息类型编号（`u16`）。
- **seq**：发送方单调递增序号（连接内），用于日志与关联错误。
- **selectToken**：pane 切换事务 token（16 bytes）。1.1.23 起只作为 `TMUX_SELECT` 的 wire 字段保留，客户端不再用它对账。
- **CHUNK**：超大 payload 的分片承载消息。

## 帧大小与分片

- 默认最大帧：`MAX_FRAME_BYTES = 1_048_576`（1MiB）。
- HELLO 协商：实际生效的最大帧大小为：
  - `effectiveMaxFrameBytes = min(client.maxFrameBytes, server.maxFrameBytes)`。
- 普通消息若编码后超过 `effectiveMaxFrameBytes`，必须使用 `CHUNK` 分片发送。
- canonical state 消息不使用通用 `CHUNK`：完整 Envelope 必须不超过 `min(32KiB, effectiveMaxFrameBytes)`，screen、history 和 metadata snapshot 使用各自有事务语义的 Begin/Chunk/Commit 事件分片。

## Envelope（固定外层）

zorsh schema（参考实现，最终以 `packages/shared/src/ws-borsh/schema.ts` 为准）：

```ts
import { b } from "@zorsh/zorsh";

export const EnvelopeSchema = b.struct({
  magic: b.bytes(2),
  version: b.u16(),
  kind: b.u16(),
  flags: b.u16(),
  seq: b.u32(),
  payload: b.bytes(),
});
```

字段语义：

- `magic`：固定为 `0x54 0x58`（ASCII "TX"）。用于新旧协议分流。
- `version`：当前为 `1`。
- `kind`：消息类型编号（见后文表）。
- `flags`：通用标记位（见后文）。
- `seq`：发送方连接内自增（从 1 开始），重连后重置。
- `payload`：kind 对应的 payload bytes（Borsh 编码）。

## flags（通用标记位）

- bit0 `ACK_REQUIRED`：请求端希望对端用 `ERROR` 或业务级 ACK 响应。
- bit1 `IS_ACK`：该 Envelope 是通用 ACK（v1 预留，当前不使用）。
- bit2 `IS_ERROR`：该 Envelope 是错误（v1 预留，当前统一用 kind=ERROR）。
- bit3 `IS_CHUNK`：该 Envelope 为分片（v1 预留，当前统一用 kind=CHUNK）。
- bit4 `IS_COMPRESSED`：payload 压缩（v1 保留，默认 0）。
- bit5..15：保留。

## kind 编号表（完整）

> 方向：C2S=客户端到服务端，S2C=服务端到客户端，BIDI=双向。
>
> 1.1.23 删除 legacy 终端状态流后，本表只列**在用**的 kind；作废号段见下一节「1.1.23 移除的 kind」，
> 这些号不得复用，网关收到时与任何未知 kind 一样回 `ERROR_UNKNOWN_KIND`。

### 会话/协商（0x0001-0x00FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0001 | HELLO_C2S | C2S | 客户端能力协商与参数声明 |
| 0x0002 | HELLO_S2C | S2C | 服务端确认参数与能力 |
| 0x0003 | PING | BIDI | 心跳 |
| 0x0004 | PONG | BIDI | 心跳 |
| 0x0005 | ERROR | BIDI | 错误回包（含 refSeq） |

### 设备连接（0x0100-0x01FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0101 | DEVICE_CONNECT | C2S | 连接设备 |
| 0x0102 | DEVICE_CONNECTED | S2C | 设备已连接 |
| 0x0103 | DEVICE_DISCONNECT | C2S | 断开设备 |
| 0x0104 | DEVICE_DISCONNECTED | S2C | 设备已断开 |
| 0x0105 | DEVICE_EVENT | S2C | 设备事件（错误/重连等） |

### tmux 控制（0x0200-0x02FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0201 | TMUX_SELECT | C2S | 选择 window/pane（带 selectToken） |
| 0x0202 | TMUX_SELECT_WINDOW | C2S | 仅选择 window |
| 0x0203 | TMUX_CREATE_WINDOW | C2S | 新建 window |
| 0x0204 | TMUX_CLOSE_WINDOW | C2S | 关闭 window |
| 0x0205 | TMUX_CLOSE_PANE | C2S | 关闭 pane |
| 0x0206 | TMUX_RENAME_WINDOW | C2S | 重命名 window |
| 0x0207 | TMUX_EVENT | S2C | tmux 事件（pane-active/bell 等） |
| 0x020A | TMUX_SET_WINDOW_STYLE | C2S | 按前端主题更新 window-style |
| 0x020B | TMUX_REORDER_WINDOWS | C2S | 按给定顺序重排 window |
| 0x020C | TMUX_REORDER_PANES | C2S | 按给定顺序重排 window 内 pane |
| 0x020F | TMUX_RESIZE_PANE | C2S | splitter 拖拽提交的 resize-pane 绝对值 |
| 0x0210 | TMUX_APPLY_STACKED_LAYOUT | C2S | 移动端拼接布局（resize-window + even-horizontal） |
| 0x0211 | TMUX_SPLIT_PANE | C2S | 切分 pane |
| 0x0212 | TMUX_FOCUS_PANE | C2S | 分屏内轻量焦点切换（不走屏障） |
| 0x0213 | TMUX_RENAME_PANE | C2S | pane 自定义名（gateway 内存 overlay） |
| 0x0214 | TMUX_MOVE_PANE | C2S | 拖拽重排：move-pane 到目标 pane 某一侧 |
| 0x0215 | TMUX_BREAK_PANE | C2S | break-pane 拆为独立 window |

### 终端数据（0x0300-0x03FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0301 | TERM_INPUT | C2S | 终端输入（bytes） |
| 0x0302 | TERM_PASTE | C2S | 粘贴（分块发送） |
| 0x0307 | CLIPBOARD_WRITE | S2C | pane 输出里解析出的 OSC52 剪贴板写入请求 |
| 0x0308 | TERM_VIEWPORT | C2S | 客户端视口 claim（几何 + 可见性） |
| 0x0309 | TERM_VIEWPORT_POLICY | S2C | window 尺寸策略（owner / 权威 cols×rows） |

### 分片（0x0500-0x05FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0501 | CHUNK | BIDI | 超大 payload 分片承载 |

### Agent（0x0600-0x06FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0601 | AGENT_SUBSCRIBE | C2S | 订阅 agent 会话事件（订阅成功后服务端立即单发一条 sync 事件） |
| 0x0602 | AGENT_UNSUBSCRIBE | C2S | 退订 agent 会话事件 |
| 0x0603 | AGENT_EVENT | S2C | agent 会话事件（payload 为 JSON bytes） |

### Watch（0x0700-0x07FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0701 | WATCH_EVENT | S2C | watch 规则事件，广播给所有已协商客户端（payload 为 JSON bytes） |

### 站点设置与站点级广播（0x0800-0x08FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0801 | SITE_THEME_UPDATE | BIDI | 站点主题切换请求与广播（同 kind 双向，C2S/S2C 各一套 schema） |
| 0x0802 | SETTINGS_UPDATE | S2C | 设置变更广播（缓存失效信号，按 namespace 重拉 REST） |
| 0x0803 | NOTIFY_EVENT | S2C | 站点级事件通知广播（body 为事件 JSON 字符串） |

### Canonical State（0x0900-0x09FF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0901 | CANONICAL_COMMAND | C2S | 唯一状态流上的订阅、输入、resize、screen/history 请求 |
| 0x0902 | CANONICAL_EVENT | S2C | 元数据、pane 增量、订阅 ACK、screen/history 事务与 gap |

协商能力：`canonical-state-v1` 与 `canonical-state-v1.1`。客户端只有在 `HELLO_S2C.capabilities` 包含对应值时才能发送该级别的 canonical command；1.1.23 起两端都要求 v1.1（见下文「1.1.23 移除的 kind」的版本门）。

### Mesh / hub（0x0A00-0x0AFF）

| kind | 名称 | 方向 | 说明 |
|---:|---|---|---|
| 0x0A01 | NODE_EVENT | S2C | 节点上下线 / 吊销与 reach、版本、载体、RTT 播报 |
| 0x0A02 | RTC_SIGNAL | BIDI | 浏览器 <-> node 的 WebRTC SDP / candidate 中转 |
| 0x0A03 | CARRIER_SWITCH | S2C | 载体切换指令（直连 <-> primary） |
| 0x0A04 | CARRIER_SWITCH_ACK | C2S | 载体切换回执（原样回显 epoch 与 rtcSession） |
| 0x0A05 | ENROLL_REDEEMED | S2C | 入网码兑换结果（证书下发给入口客户端） |

0x0A01 / 0x0A02 / 0x0A05 走 `/mesh/ws` 端点，0x0A03 / 0x0A04 走普通 Gateway `/ws`。

## 1.1.23 移除的 kind（号段作废）

legacy 终端状态流（快照 overlay、TERM_OUTPUT/HISTORY 广播、切换屏障、legacy 订阅/取历史、
legacy 尺寸上报）在 1.1.23 整体下线，能力全部由 `CANONICAL_COMMAND` / `CANONICAL_EVENT`
（canonical v1.1）承担。以下 kind 常量、payload schema 与编解码器均已从 `packages/shared` 删除，
编号**永久作废、不得复用**：

- `0x0208` STATE_SNAPSHOT、`0x0209` STATE_SNAPSHOT_DIFF
  → 由 `SourceMetadataSnapshot` / `SourceMetadataPatch` 取代；
  设备树的用户自定义顺序改由 metadata 字段 `SOURCE_FIELD_TREE_ORDER`(15) 承载，客户端自行重排。
- `0x020D` TMUX_SUBSCRIBE_PANES → `CanonicalCommand::SetPaneSubscriptions`。
- `0x020E` TMUX_FETCH_PANE_HISTORY → `CanonicalCommand::RequestScreen` / `RequestHistory`。
- `0x0303` TERM_RESIZE、`0x0304` TERM_SYNC_SIZE → `CanonicalCommand::ResizePaneV11`
  （`geometryReason` 区分 change / resend，`sizeEpoch` 单调递增）。
- `0x0305` TERM_OUTPUT、`0x0306` TERM_HISTORY → `CanonicalEvent::PaneData` 与
  `ScreenBegin/Chunk/Commit`、`HistoryBegin/Chunk/Commit` 事务。
- `0x0401` SWITCH_ACK、`0x0402` LIVE_RESUME → canonical 订阅事务本身即屏障
  （`SubscriptionApplied` + 每 pane 的 `terminalSeq` 游标），不再需要独立的屏障帧。

对端版本门槛：低于 `1.1.23` 的客户端/节点无法正确消费 canonical v1.1 语义（1.1.22 的网关只播报
`canonical-state-v1`，1.1.22 的浏览器又把 `clientVersion` 硬编码成 `0.1.0`），网关在 HELLO 阶段
**fail-closed** 拒绝——回一条 `ERROR_UNSUPPORTED_PROTOCOL`，message 以固定前缀
`canonical-state-v1.1 required` 开头（常量 `wsBorsh.CANONICAL_V11_REQUIRED_ERROR_PREFIX`），随后关闭连接。

message 有两种形态，由 `wsBorsh.formatCanonicalV11RequiredError` 统一拼装、
`wsBorsh.parseCanonicalV11RequiredError` 解析，网关与客户端共用同一实现：

```
canonical-state-v1.1 required: client <clientVersion> < <minVersion>
canonical-state-v1.1 required: node <nodeId> version <peerVersion> < <minVersion>
```

节点编号写进 message 是必需的：入口网关拒掉的转发流对端未必是浏览器当前 runtime 的 node，
浏览器只有靠它才知道该升级哪一台。客户端据此把该 ERROR 翻成
`server-too-old`（带 `side` / `nodeId` / `version`）并停止自动重连。

## payload schemas（完整）

> 本节描述“字段语义 + wire 类型”。最终 schema 以 shared 代码为准。
>
> 只列**在用**的 kind。上文「1.1.23 移除的 kind（号段作废）」里的那些在 `packages/shared` 中已无
> schema，也不再在此展开字段。

### HELLO_C2S（0x0001）

字段：

- `clientImpl: string`（例：`tmex-fe`）
- `clientVersion: string`（例：`0.1.0`）
- `maxFrameBytes: u32`（客户端可接收最大帧）
- `supportsCompression: bool`（v1 固定 false）
- `supportsDiffSnapshot: bool`（v1 固定 false，保留）

约束：

- 客户端必须在 WS open 后第一条发送 HELLO_C2S。

### HELLO_S2C（0x0002）

字段：

- `serverImpl: string`（`tmex-gateway`）
- `serverVersion: string`
- `selectedVersion: u16`（当前 1）
- `maxFrameBytes: u32`（服务端可接收最大帧）
- `heartbeatIntervalMs: u32`（默认 15000）
- `capabilities: vec(string)`——唯一真源是 `packages/shared/src/capabilities.ts` 的 `GATEWAY_CAPABILITIES`，REST `GET /api/capabilities` 与 WS `HELLO_S2C` 共用该常量。当前为 `tmex-ws-borsh-v1`、`tmex-agent-v1`、`tmex-split-v1`、`canonical-state-v1`。

### PING/PONG（0x0003/0x0004）

字段：

- `nonce: u32`
- `timeMs: u64`（可选：用于测 RTT/时钟偏差；如果不需要可固定为 0）

### ERROR（0x0005）

字段：

- `refSeq: option(u32)`（关联的请求 seq；无则 null）
- `code: u16`
- `message: string`
- `retryable: bool`

错误码定义（v1 最小集合）：

- `1001 UNSUPPORTED_PROTOCOL`
- `1002 INVALID_FRAME`
- `1003 UNKNOWN_KIND`
- `1004 PAYLOAD_DECODE_FAILED`
- `1005 FRAME_TOO_LARGE`
- `1101 DEVICE_NOT_FOUND`
- `1102 DEVICE_CONNECT_FAILED`
- `1201 TMUX_TARGET_NOT_FOUND`
- `1202 TMUX_NOT_READY`
- `1301 SELECT_CONFLICT`
- `1302 SELECT_TOKEN_MISMATCH`
- `1401 INTERNAL_ERROR`

### DEVICE_CONNECT / DEVICE_DISCONNECT（0x0101/0x0103）

字段：

- `deviceId: string`

### DEVICE_CONNECTED / DEVICE_DISCONNECTED（0x0102/0x0104）

字段：

- `deviceId: string`

### DEVICE_EVENT（0x0105）

字段：

- `deviceId: string`
- `eventType: u8`
  - 1 `tmux-missing`
  - 2 `disconnected`
  - 3 `error`
  - 4 `reconnected`
- `errorType: option(string)`（用于 FE 展示：如 reconnecting/reconnect_failed 等）
- `message: option(string)`
- `rawMessage: option(string)`

### TMUX_SELECT（0x0201）

字段：

- `deviceId: string`
- `windowId: option(string)`
- `paneId: option(string)`
- `selectToken: bytes(16)`（随机 16 bytes，视作 opaque token）
- `wantHistory: bool`
- `cols: option(u16)`
- `rows: option(u16)`

语义：

- `selectToken` 标识一次选择事务。
- 1.1.23 前 Gateway 会回 `SWITCH_ACK(selectToken)` → 可选 `TERM_HISTORY(selectToken)` → `LIVE_RESUME(selectToken)`。
  这三个 kind 已删除：`TMUX_SELECT` 现在只做 tmux 焦点切换与视口声明，画面重建由 canonical 订阅事务承担，
  `selectToken` 与 `wantHistory` 仍在 wire 上（`wantHistory` 恒为 false），但客户端不再用它对账。

### TMUX_SELECT_WINDOW（0x0202）

字段：

- `deviceId: string`
- `windowId: string`

### TMUX_CREATE_WINDOW（0x0203）

字段：

- `deviceId: string`
- `name: option(string)`
- `cwd: option(string)`

### TMUX_CLOSE_WINDOW（0x0204）

字段：

- `deviceId: string`
- `windowId: string`

### TMUX_CLOSE_PANE（0x0205）

字段：

- `deviceId: string`
- `paneId: string`

### TMUX_RENAME_WINDOW（0x0206）

字段：

- `deviceId: string`
- `windowId: string`
- `name: string`

### TMUX_EVENT（0x0207）

字段：

- `deviceId: string`
- `eventType: u8`
  - 1 window-add
  - 2 window-close
  - 3 window-renamed
  - 4 window-active
  - 5 pane-add
  - 6 pane-close
  - 7 pane-active
  - 8 layout-change
  - 9 bell
  - 10 output
  - 11 notification
- `eventData: bytes()`（按 eventType 使用子 schema 解码）

子 schema（v1）：

- window-add：`{ windowId: string }`
- window-close：`{ windowId: string }`
- window-renamed：`{ windowId: string; name: string }`
- window-active：`{ windowId: string }`
- pane-add：`{ paneId: string; windowId: string }`
- pane-close：`{ paneId: string }`
- pane-active：`{ windowId: string; paneId: string }`
- layout-change：`{ windowId: string; layout: string }`
- bell：
  - `windowId: option(string)`
  - `paneId: option(string)`
  - `windowIndex: option(u16)`
  - `paneIndex: option(u16)`
  - `paneUrl: option(string)`
  - `paneTitle: option(string)`
  - `paneCurrentCommand: option(string)`
- output：保留空 schema（`{}`），终端字节流不走事件，而是通过 canonical 的 `PaneData` 与
  `Screen*` / `History*` 事务传输（1.1.23 前是 `TERM_OUTPUT` 0x0305 / `TERM_HISTORY` 0x0306，均已删除）。
- notification：
  - `source: u8`（1=`osc9`，2=`osc777`，3=`osc1337`，4=`osc99`）
  - `title: option(string)`
  - `body: string`
  - `windowId: option(string)`
  - `paneId: option(string)`
  - `windowIndex: option(u16)`
  - `paneIndex: option(u16)`
  - `paneUrl: option(string)`
  - `paneTitle: option(string)`
  - `paneCurrentCommand: option(string)`

### TMUX_SET_WINDOW_STYLE（0x020A）

字段：

- `deviceId: string`
- `style: string`（tmux style 字符串，如 `fg=#d0d0d0,bg=#262626`）

语义：

- 客户端在主题切换、设备连接/重连后发送，gateway 据此更新会话所有 window 的 `window-style` 及 `after-new-window` hook。
- gateway 按 `TMEX_TMUX_WINDOW_STYLE` 的白名单规则校验 style，非法值忽略；该配置为 `off` 时忽略本消息。

### TMUX_REORDER_WINDOWS（0x020B）

字段：

- `deviceId: string`
- `windowIds: vec(string)`（期望的 window 顺序，全量）

### TMUX_REORDER_PANES（0x020C）

字段：

- `deviceId: string`
- `windowId: string`
- `paneIds: vec(string)`（该 window 内期望的 pane 顺序，全量）

### TMUX_RESIZE_PANE（0x020F）

字段：

- `deviceId: string`
- `paneId: string`
- `cols: option(u16)`
- `rows: option(u16)`

语义：

- splitter 拖拽提交的绝对值，`cols` / `rows` 至少一个非空。

### TMUX_APPLY_STACKED_LAYOUT（0x0210）

字段：

- `deviceId: string`
- `windowId: string`
- `cols: u16`
- `rows: u16`

语义：

- 移动端拼接布局：resize-window 到 `N*cols+(N-1) x rows`，再 select-layout even-horizontal。

### TMUX_SPLIT_PANE（0x0211）

字段：

- `deviceId: string`
- `paneId: string`
- `direction: u8`（1=right（`-h`），2=down（`-v`））
- `cwd: option(string)`

### TMUX_FOCUS_PANE（0x0212）

字段：

- `deviceId: string`
- `windowId: string`
- `paneId: string`

语义：

- 分屏内轻量焦点切换（select-window / select-pane），不走屏障、不发 history、不重置终端。

### TMUX_RENAME_PANE（0x0213）

字段：

- `deviceId: string`
- `paneId: string`
- `name: string`（空串 = 恢复自动名）

语义：

- gateway 内存 overlay，不写 tmux；快照下发时合并进 `PaneWire.customName`。

### TMUX_MOVE_PANE（0x0214）

字段：

- `deviceId: string`
- `srcPaneId: string`
- `dstPaneId: string`
- `position: u8`（1=left，2=right，3=top，4=bottom）

语义：

- 拖拽重排：tmux move-pane，把 `srcPaneId` 移到 `dstPaneId` 的指定一侧。

### TMUX_BREAK_PANE（0x0215）

字段：

- `deviceId: string`
- `paneId: string`

语义：

- tmux break-pane，把该 pane 拆为独立 window，焦点跟随新窗口。

### TERM_INPUT（0x0301）

字段：

- `deviceId: string`
- `paneId: string`
- `encoding: u8`（2=utf8-bytes）
- `data: bytes()`
- `isComposing: bool`

### TERM_PASTE（0x0302）

字段同 TERM_INPUT，但 `isComposing` 固定 false。

### TERM_VIEWPORT（0x0308）

字段：

- `deviceId: string`
- `paneId: string`
- `cols: u16`
- `rows: u16`
- `visible: bool`

客户端在 pane 表面成为当前可见面、或 `document.visibilitychange → visible` 时发 `visible=true`；隐藏 / 卸载时发 `visible=false`（cols/rows 可为上次测量值）。未知 pane 的 claim 被忽略。

### TERM_VIEWPORT_POLICY（0x0309）

字段：

- `deviceId: string`
- `windowId: string`
- `paneId: string`（收件方自己 claim 的 pane，便于按 pane 索引）
- `owner: bool`
- `cols: u16`
- `rows: u16`

`owner=true`：本端几何被采用，应继续上报 resize。`owner=false`：跟随权威 `cols×rows`，停止上报容器尺寸。在 winner / 已应用几何变化时发给该 window 上所有 claimant；会话对该 window 的首次 claim 后立即单发一次。

### CLIPBOARD_WRITE（0x0307）

字段：

- `deviceId: string`
- `paneId: string`
- `text: string`

语义：

- gateway 从 pane 输出里解析出 OSC52 写剪贴板请求后，单发给订阅该 pane 的客户端。

### CHUNK（0x0501）

字段：

- `chunkStreamId: u32`
- `originalKind: u16`
- `originalSeq: u32`
- `totalChunks: u16`
- `chunkIndex: u16`
- `data: bytes()`（原消息的 payload bytes 片段）

重组规则：

- 收到 `CHUNK` 后按 `chunkStreamId` 聚合，收齐 `totalChunks` 后按 `chunkIndex` 拼接 `data`。
- 拼接得到 `originalPayloadBytes` 后，用 `originalKind` 解码为对应 payload。
- 超时（默认 5s）或重复/越界 index：丢弃并回 `ERROR(code=1002)`。

### CANONICAL_COMMAND / CANONICAL_EVENT（0x0901/0x0902）

两种 payload 均以 `protocolVersion: u16` 开头，当前为 `1`，随后是声明顺序固定的 `b.enum(...)`。canonical 实现与通用 WS Envelope 版本分别演进。

命令 discriminator（只能尾部追加）：

| discriminator | 命令 |
|---:|---|
| 0 | `SetPaneSubscriptions` |
| 1 | `TerminalInput` |
| 2 | `ResizePane` |
| 3 | `RequestScreen` |
| 4 | `RequestHistory` |

事件 discriminator（只能尾部追加）：

| discriminator | 事件 |
|---:|---|
| 0 | `FeedReady` |
| 1 | `SourceMetadataSnapshot` |
| 2 | `SourceMetadataPatch` |
| 3 | `PaneData` |
| 4 | `SubscriptionApplied` |
| 5–7 | `ScreenBegin` / `ScreenChunk` / `ScreenCommit` |
| 8–10 | `HistoryBegin` / `HistoryChunk` / `HistoryCommit` |
| 11 | `SourceGap` |
| 12 | `Error` |

核心标识和顺序约束：

- source key 为 `(deviceId, serverEpoch, entityKind, nativeId)`；`serverEpoch` 是 tmux server 生命周期内稳定的 16 bytes 标识。
- pane 数据为 `(pane target, paneEpoch, seqStart, seqEnd, data)`，且 `seqEnd - seqStart == data.length`。
- pane subscription 携带 pane target 和可选 terminal cursor；terminal cursor 为 `paneEpoch + terminalSeq`，只允许用于同一 pane target 的精确 replay，跨 pane/server epoch 的 cursor 无效。
- history 使用独立的 `paneEpoch + historyEpoch + beforeLine` cursor。`historyEpoch` 只引用 Gateway 内存中的短期分页会话，不写数据库；过期、边界锚点变化或 tmux history 淘汰时显式返回可重试错误，客户端从新 cursor 重新取页。
- metadata 使用独立 `metadataEpoch + revision`；snapshot 是冷启动/恢复屏障，patch 必须连续应用。
- `SetPaneSubscriptions.generation` 单调递增；服务端只保留最新 generation，并以 `SubscriptionApplied` 返回实际 active/hot 集与拒绝项。
- screen、history 事务按 `requestId` 以 Begin/Chunk/Commit 原子提交。`ScreenCommit` 可携带第一条更老 history cursor；`HistoryBegin` 携带 `[lineStart,lineEnd)` 和显式 `truncated`。中途断开或缺块时客户端保留旧画布，不应用半成品。
- `SourceGap` 明确区分 metadata gap 与 pane sequence gap；客户端请求对应 snapshot 恢复，不要求整页刷新。
- 每个完整 canonical Envelope 最大 32KiB；semantic chunk 的数据长度必须为 Envelope 和字段开销预留空间。

### canonical v1.1（能力 `canonical-state-v1.1`）

v1 小节冻结，本节只描述 v1.1 的增量。v1.1 不改 `protocolVersion`（仍为 `1`），也不改任何既有
结构的字段顺序：增量只有「命令枚举尾部追加一个变体」和「metadata 记录的 `fields` 里新增一个字段号」，
两者对 v1 解码方都是安全的——v1 客户端只会遇到自己不认识的 discriminator（网关不会向它发送）
或直接忽略未知字段号。

#### 能力与版本门槛

- HELLO S2C `capabilities` 新增 `canonical-state-v1.1`（`packages/shared/src/capabilities.ts`）。
- 最低对端版本 `1.1.23`（`CANONICAL_V11_MIN_PEER_VERSION`）。判定必须 **fail-closed**：
  版本为 null、空串或无法解析一律视为不支持；唯一例外是开发态自报的 `X.Y.Z_dev`，
  去掉 `_dev` 后按数字部分比较（`peerSupportsCanonicalV11`）。
- `selectedVersion` 继续表示外层 WS Envelope 版本，不复用它表达 canonical 版本。
- 网关必须记录并校验 `HELLO_C2S.clientVersion`：客户端版本不满足门槛时不得按 v1.1 语义处理它的命令。

#### ResizePaneV11（命令 discriminator = 5）

字段（顺序固定，只能尾部追加）：

- `requestId: bytes(16)`
- `pane: CanonicalPaneTarget`
- `rows: u16`
- `cols: u16`
- `geometryReason: u8`
- `sizeEpoch: u64`

`geometryReason` 枚举：

| 值 | 名称 | 含义 |
|---:|---|---|
| 0 | change | 浏览器/布局的视口真的变了 |
| 1 | resend | 暖切换、重连、焦点恢复后补发当前尺寸 |

语义（替代 legacy 的 `TERM_RESIZE` / `TERM_SYNC_SIZE` 之分）：

- `change` 必须先自增 `sizeEpoch`；`resend` 复用上一次 `change` 的 `sizeEpoch`。
- `sizeEpoch` 按 (会话, pane) 单调递增，取值 **从 1 起，0 为保留值**。收到 `sizeEpoch == 0`
  或未知 `geometryReason` 一律回 `ERROR_INVALID_FRAME`（编解码两侧都校验）。
- 网关按 epoch 丢弃过期尺寸：`sizeEpoch` 小于该 (会话, pane) 已记录值的命令直接丢弃。
- 只有 `resend` 允许触发「不信任快照几何」（gateway `distrustLive`）；`change` 走原有去重路径。

#### metadata 携带设备树顺序（字段号 15）

- 新字段号 `SOURCE_FIELD_TREE_ORDER = 15`，值类型 `U32`，出现在 `WINDOW` 与 `PANE` 记录上，
  含义是该实体在用户自定义显示顺序里的 0 基序号。
- v1.1 网关在 metadata snapshot 和 patch 里始终携带它（有保存顺序时）；没有保存顺序的实体不带该字段。
- patch 只携带变化字段：**不带**该字段表示顺序未变，`Unset` 表示该实体退出自定义顺序。
- 客户端排序规则：带序号的实体按序号升序排在前，不带序号的实体保持原有顺序（即 tmux index 顺序）
  追加在后；指向已不存在实体的序号自动失效。与被替换的 legacy `STATE_SNAPSHOT` overlay
  （`applyDeviceTreeOverlay`）逐例等价。
- 自定义 window / pane 名沿用既有的 `SOURCE_FIELD_CUSTOM_NAME = 14`，v1.1 不新增字段。

自此 canonical 客户端不再需要 legacy `STATE_SNAPSHOT` overlay：设备树顺序与自定义名都从 metadata 通路获得。

### AGENT_SUBSCRIBE（0x0601）/ AGENT_UNSUBSCRIBE（0x0602）

字段：

- `sessionId: string`

语义：

- 订阅成功后服务端立即向该客户端单发一条 `AGENT_EVENT(eventType=1 sync)`，包含会话当前状态全量。
- 连接关闭时服务端清理该客户端的全部订阅。

### AGENT_EVENT（0x0603）

字段：

- `sessionId: string`
- `seq: u32`（会话内事件序号；sync 单发时为 0）
- `eventType: u8`
- `payload: bytes()`（JSON bytes，形状约定见 `packages/shared/src/ws-borsh/agent.ts`，先例：TMUX_EVENT.eventData）

eventType 枚举：

| 值 | 名称 | payload 类型 |
|---:|---|---|
| 1 | sync | `AgentSyncEventPayload` |
| 2 | status | `AgentStatusEventPayload` |
| 3 | text_delta | `AgentTextDeltaPayload` |
| 4 | reasoning_delta | `AgentReasoningDeltaPayload` |
| 5 | tool_call | `AgentToolCallPayload` |
| 6 | tool_result | `AgentToolResultPayload` |
| 7 | confirmation_request | `AgentConfirmationRequestPayload` |
| 8 | confirmation_resolved | `AgentConfirmationResolvedPayload` |
| 9 | message_persisted | `AgentMessagePersistedPayload` |
| 10 | error | `AgentErrorEventPayload` |
| 11 | turn_finished | `AgentTurnFinishedPayload` |

### WATCH_EVENT（0x0701）

字段：

- `ruleId: string`
- `deviceId: string`
- `paneId: string`
- `eventType: u8`
- `payload: bytes()`（JSON bytes，形状约定见 `packages/shared/src/ws-borsh/agent.ts`）

eventType 枚举：

| 值 | 名称 | payload 类型 |
|---:|---|---|
| 1 | triggered | `WatchTriggeredPayload` |
| 2 | model_unavailable | `WatchModelUnavailablePayload` |
| 3 | rule_error | `WatchRuleErrorPayload` |

### SITE_THEME_UPDATE（0x0801）

同一 kind 双向，两个方向各一套 schema。

C2S 字段：

- `theme: u8`（0=dark，1=light）

S2C 字段：

- `theme: u8`
- `serverTimestamp: u64`（服务端 `Date.now()` 分配，严格递增，last-writer-wins）

C2S 不带 clientTimestamp，避免多端时钟漂移导致顺序错乱。细节见 `docs/ws-protocol/2026070402-site-theme-update.md`。

### SETTINGS_UPDATE（0x0802）

字段：

- `namespace: string`（设置面标识，如 `site` / `terminal-shortcuts` / `theme` / `llm` / `file-roots` / `webhooks` / `telegram` / `weixin` / `devices` / `tree-order`）
- `serverTimestamp: u64`

语义：

- 纯缓存失效信号，不带设置内容；客户端按 namespace 重拉对应 REST。

### NOTIFY_EVENT（0x0803）

字段：

- `eventType: string`（冗余外提，便于客户端快速过滤）
- `eventJson: string`（完整事件 JSON，形状同 webhook 推送体）
- `timestamp: u64`

字段顺序即 Borsh 线序，已定稿不可变。

### NODE_EVENT（0x0A01）

字段：

- `nodeId: string`
- `status: u8`（0=online，1=offline，2=revoked）
- `reach: option(string)`
- `inventory: option(string)`
- `version: option(string)`
- `directCapable: option(bool)`
- `name: option(string)`
- `transport: option(string)`
- `rttMs: option(u32)`

语义：

- 该 payload 已演进三代（原始四字段 / V2 七字段 / 当前九字段）。解码按新→旧依次尝试（`decodeNodeEvent`），老 node 发来的帧缺后加字段时补 null。

### RTC_SIGNAL（0x0A02）

字段：

- `rtcSession: string`
- `from: u8`（0=browser，1=node）
- `to: string`
- `sdp: option(string)`
- `candidate: option(string)`

### CARRIER_SWITCH（0x0A03）

字段：

- `epoch: u32`
- `to: u8`（0=direct，1=primary）
- `rtcSession: string`

语义：

- `rtcSession` 把切换绑定到具体的直连 attempt：浏览器只接受与当前载体同 session 的切换帧。空串 = 未携带（老 node），由接收方按「只有一个待定 attempt」宽容处理。

### CARRIER_SWITCH_ACK（0x0A04）

字段：

- `epoch: u32`
- `rtcSession: string`（原样回显）

### ENROLL_REDEEMED（0x0A05）

字段：

- `enrollPk: bytes(32)`
- `certificate: bytes()`（不超过 `ENROLL_REDEEMED_MAX_CERT_BYTES` = 2048）
- `certSig: bytes(64)`
- `nodeId: string`（32 位 hex）

发送前由 `assertEnrollRedeemedFields` 校验上述长度与格式约束，不满足直接丢弃。

## 关键时序（必须遵守）

### 1) 连接协商

1. WS open。
2. Client -> `HELLO_C2S`。
3. Server -> `HELLO_S2C`。
4. 进入 READY，开始允许业务消息。

### 2) 切 pane（canonical 首屏事务）

`SetPaneSubscriptions(generation, panes)` → `SubscriptionApplied(generation)` →
`RequestScreen(requestId, pane)` → `ScreenBegin/Chunk/Commit`（`ScreenCommit.baseSeq` 之前的
`PaneData` 直接丢弃）→ 实时 `PaneData`。`TMUX_SELECT` 仍会发（切 tmux 当前 pane、携带视口尺寸），
但不再有屏障帧。1.1.23 前的 `SWITCH_ACK` / `TERM_HISTORY` / `LIVE_RESUME` 三段式时序与它的对应关系见
[ws 状态机](./2026021403-ws-state-machines.md)（第 3 节与文末附录）。

## 兼容与迁移

- 本协议是浏览器 ↔ gateway 的唯一 WS 协议，没有 JSON 回退通道；`magic != TX` 或版本不符即断连。
- 演进只走两条路：`Envelope.version` 与 `HELLO` 协商的 capabilities。当前门槛是
  `canonical-state-v1.1` + 对端版本 ≥ 1.1.23，不满足即 fail-closed（见上文「1.1.23 移除的 kind」）。
- 作废号段永不复用；收到即 `ERROR_UNKNOWN_KIND`。
