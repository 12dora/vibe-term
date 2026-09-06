# 消息指令（Telegram / 微信）

本文描述平台无关的消息命令层：解析、授权、命令表、渲染与分片，以及新平台适配器要实现什么；面向改动 `apps/gateway/src/messaging/` 与 `packages/shared/src/messaging/` 的开发者。

## 背景

Telegram、微信（以及未来的钉钉 Bot）共用同一套命令、解析、节点定位、渲染与测试；新平台只实现适配器。入站消息可以查询 mesh 节点、设备与终端，向终端发送输入，并批准 / 拒绝智能体确认项；长消息按平台上限分片。

## 架构

```
入站文本
  → parseCommand（@vibeterm/shared/messaging，纯函数）
  → authorizeMessagingActor（已授权 + allowCommands；群聊还要 from.id = 绑定 user_id）
  → resolveNodeTarget
  → 仅本机执行 handler
  → CommandResult（结构化，不含平台 markup）
  → MessagingAdapter.render → 分片后回复
```

- 共享包：`packages/shared/src/messaging/`，经 `@vibeterm/shared/messaging` 导出，**不**进入浏览器主入口。
- 网关：`apps/gateway/src/messaging/`（registry / executor / adapter / handlers / inbound）。
- Telegram：`TelegramService.handleIncomingText`；精确 `/start` 仍走绑定，其余进命令层。
- 微信：`WeixinService.handleInbound` 在既有 upsert 之后，已授权且文本非空才 dispatch。

### 运行时挂钩（`registerMessagingRuntime`）

`packages/app` / `runtime.ts` 可稍后注入：

- `getUplinkStatus`：上行种类与是否已连接。未注册时 `status` 报 `unknown`（standalone 为 `none`）。
- `listMeshNodes`：与 `GET /api/mesh/nodes` 相同的投影。未注册时回退 `node_identity` + `peer_cache`（对端在线状态可能不准）。
- `getDeviceTree` / `capturePane` / `sendKeys`：tmux 快照与输入。未注册时设备视为未连接。
- `decideConfirmation`：应接到 `AgentSupervisor.resolveConfirmation`（与 HTTP `POST /api/agent/confirmations/:id/decide` 相同）。未注册时回退 `db/agent.decideAgentConfirmation`（不广播 WS 事件）。
- `remoteExecutor`：预留跨节点执行。当前**不会调用**；远程 `--node` 一律返回 `messaging.error.remoteNodeUnsupported`。

## 命令表

| 命令 | 权限 | 说明 |
|---|---|---|
| `help` | read | 列出命令 |
| `status` | read | 本机名、版本、角色、上行 |
| `nodes` | read | 互联节点；standalone 说明未加入 |
| `devices [--node]` | read | 本机设备 |
| `windows <device>` | read | tmux 窗口 |
| `panes <device> [window]` | read | 终端 |
| `tail <device> <pane> [lines=30]` | read | 最近输出，最多 200 行 |
| `run <device> <pane> -- <text>` | execute | 发送按键 + Enter |
| `approve <id>` | approve | 批准智能体确认 |
| `deny <id> [reason]` | approve | 拒绝 |

设备可用唯一名称（大小写不敏感）或 id；终端可用 `%N` 或 `窗口.终端`（如 `1.0`）。

解析支持可选前导 `/`、`/cmd@botname`、引号参数、`--node` / 前导 `@node`、`--` 后的自由文本。

## 新增平台（钉钉适配器须实现）

1. `MessagingAdapter`：`platform`、`limits.maxTextChars`、`supportsActions`、`render(result)`（内部已分片）。
2. 入站：把平台消息映射为 `CommandActor`（`accountId` / `conversationId` / `userId`），调用 `processInboundCommand`，把 `chunks` 发回同一会话。
3. 授权表：与 Bot 配置绑定的会话行 + `allow_commands`。未授权保持静默。
4. 不要在适配器里解析命令或拼平台 markup 进 `CommandResult`。

Telegram：HTML（须转义），代码块 `<pre>`，分片 4000 字。微信：纯文本，分片 2000 字（iLink 单条 text item，协议未写硬限制）。钉钉按该平台上限选择 `maxTextChars`。

## 限制：只在本机执行

Bot 凭证和会话授权都是节点本地表，没有可用于远程节点的服务端凭证。`--node` 若解析到非本机，返回 `messaging.error.remoteNodeUnsupported`。`remoteExecutor` 仅作后续扩展挂钩。

## 权限

- `telegram_bots.allow_commands` / `weixin_accounts.allow_commands`，默认 0。创建 / 更新 API 校验布尔值 `allowCommands`。
- 命令（含 `help`）要求：会话已授权 **且** `allowCommands`。未授权、待授权、或开关关闭：**静默**（不回复），`/start` 绑定除外。
- Telegram 群聊：`/start` 只在 pending 行写入 `from.id`；已授权行不得改 `user_id`。命令只接受同一 `from.id`。私聊（`chat.id === from.id`）不校验 `user_id`。
- 迁移 0044 之前授权的群聊 `user_id` 为空：命令静默拒绝。须在设置中删除该绑定，再 `/start` 并由管理员审批；不能靠再发 `/start` 认领。
- `execute` / `approve` 与 `read` 共用这一开关（前端开关后续任务再加）。

## i18n

键在 `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的顶层 `messaging`（rest 包，不进 `core-keys`）。网关 `t()` 读完整 `I18N_RESOURCES`。改文案后跑 `bun run build:i18n` 生成 `resources.ts`。
