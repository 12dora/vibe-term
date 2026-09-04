# 消息命令模板（Telegram / 微信）

## 背景

Telegram Bot 原先只识别精确字符串 `/start` 做绑定；微信 iLink 入站只 upsert 用户、不解析命令。两条渠道都是通知出口，不知道 mesh 节点、Hub / 中继，也不能批准智能体确认项。长消息也不分片。

本设计抽出一套平台无关的命令层，使 Telegram、微信和未来的钉钉 Bot 共用同一套命令、解析、节点定位、渲染与测试。新平台只实现适配器。

## 架构

```
入站文本
  → parseCommand（@tmex/shared/messaging，纯函数）
  → authorizeMessagingActor（已授权 + allowCommands；群聊还要 from.id = 绑定 user_id）
  → resolveNodeTarget
  → 仅本机执行 handler
  → CommandResult（结构化，不含平台 markup）
  → MessagingAdapter.render → 分片后回复
```

- 共享包：`packages/shared/src/messaging/`，经 `@tmex/shared/messaging` 导出，**不**进入浏览器主入口。
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

键在 `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的顶层 `messaging`（rest 包，不进 `core-keys`）。网关 `t()` 读完整 `I18N_RESOURCES`。指挥官需跑 `bun run build:i18n` 生成 `resources.ts`。
