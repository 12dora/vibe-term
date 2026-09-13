# 单一上游与派生约定

本文列出应派生、不要再复制一份平行实现的模块；面向改前端、gateway、shared 契约与 CLI 的开发者。复杂度阈值见 [客户端 CLI 架构「复杂度门禁」](./cli-architecture.md)。

规则：展示口径、设置标签、确认框、接入表单、mesh / 中继 DTO、站点字段、消息通道 CRUD、端口 / 布尔解析、STUN / TURN 探测调度，一律从下表上游派生。新代码不要在调用方再写一份同构函数、类型或 REST 封装。

## 前端展示

| 上游 | 派生 |
|---|---|
| `apps/fe/src/node/node-view-model.ts` `buildNodeView` | 节点表 / 详情 / 待批准行的状态、REACH、地址、离线时间。REACH 组合文案走懒模块 `reach-label.ts`（`nodes.link.*`） |
| `apps/fe/src/lib/tone.ts` `Tone` / `TONE_CLASS` | badge、端口灯、中继 chip、状态色、表单 notice。`NoticeTone` 对外 union 保留，内部映射到 `Tone` |
| `apps/fe/src/lib/format-relative.ts` `formatRelative` / `formatCompactDuration` | 节点相对时间、分享时长、中继磁贴时长。薄封装不要再各写一套 |

## 设置页与确认框

| 上游 | 派生 |
|---|---|
| `apps/fe/src/pages/settings/settings-tabs.ts` `SETTINGS_TAB_SPECS` | 标签栏、空闲预热、预取、是否依赖站点设置。加标签：改 `SettingsTab` union + 一条 spec；有预取在 `settings-prefetch.ts` 登记同一函数（注册表带 i18n key，不能进 eager 图） |
| `@vibeterm/ui/confirm-dialog` `ConfirmDialog` | 吊销 / 卸载 / 退出 mesh / agent 删除 / 设置页重启。用 `extra` / `input` / `actions` / `hideCancel` / `confirmPending`，不要再包 `danger-confirm-dialog` 别名。键入确认（租户编号）仍手写 AlertDialog |

## 接入向导表单

单一上游：`apps/fe/src/pages/settings/nodes/setup/form-parts.tsx`。`DirectEnableSwitch`（`kind: 'hub' \| 'relay'`）、`NodeNameField`、`AccountCredentialFields`、`SetupSubmitRow`（可选 `submitError`）。testid 由调用方传入，保持 `setup-direct-enable` / `setup-join-direct-enable` / `setup-relay-join-direct-enable`。

## 契约（`@vibeterm/shared`）

| 上游 | 派生 |
|---|---|
| `contracts/mesh-node.ts` `MeshNode` / `DIRECT_FAILURE_CODES` / reach / transport / dc-breaker / `MeshPortReach` | gateway 投影与 `NODE_EVENT` wire、api-client 再导出、CLI 行类型。JSON 形状不变 |
| `relay/status-row.ts` `RelayStatusRow` | gateway `buildRelayStatusRow`、api-client `RelayLinkStatus`、CLI 读侧宽松别名 |
| `relay/link-error.ts` `RELAY_LINK_ERROR_CODES` | 分类器仍在 gateway `classifyRelayLinkError`；码表只此一份 |
| `relay/presence.ts` / `relay/metrics.ts` | presence 快照类型；`RelayMetricsResponse`（api-client `metrics-types.ts` 只再导出） |
| `contracts/site-settings.ts` `SITE_SETTING_FIELDS` | 类型、PATCH 归一化、merge、CLI 键 / 旗标 / USAGE。drizzle 列仍手写。见 [站点设置联动](../architecture/site-settings-node-linkage.md) |
| `contracts/transfer.ts` `TRANSFER_CAPABILITIES` | `getSystemInfo().transferCapabilities` 拷贝该数组 |

## 消息通道

Telegram / 微信的 DB store、REST 路由、api-client 走三套工厂，渠道只做薄实例：

- `apps/gateway/src/db/messaging-channel.ts` `createMessagingChannelStore`
- `apps/gateway/src/api/messaging-channel-routes.ts` `createMessagingChannelRoutes`
- `packages/api-client/src/messaging-channel.ts` `createMessagingChannelClient`

渠道特有 upsert（TG pending chat / WX inbound user）留在各自 db 模块。公开方法名与错误文案不变。

## 环境解析与探测

| 上游 | 派生 |
|---|---|
| `packages/shared/src/env/parse.ts` `parsePort` / `parseBoolEnv` | gateway `resolveGatewayPort` / `getBooleanEnv` / `parsePeerPort`；app 端口计划、mesh / upgrade 命令。Node 相对 import，勿从浏览器主入口导出。见 [三套环境](./environments.md) |
| `apps/gateway/src/mesh/rtc/probe-loop.ts` `MeshProbeLoop` | STUN / TURN 共用调度（stagger、min-interval、inflight）。`stun-probe.ts` / `turn-probe.ts` 只做门面与 `urlsOf` / `applyResults` |

## REST 不要在 FE 再包一层

本机登录开关走 `packages/api-client/src/auth/account-security.ts`；多节点通知汇聚走 `packages/api-client/src/notifications-mesh.ts`（GET 404 / 501 → `supported: false`，不当错误）；站点 PATCH 走 `requestJson`。不要在 `apps/fe` 再写平行的 `*-api.ts`。

## 拆分后的入口路径

近天花板的 UI 文件拆到同目录模块后，**原路径继续 re-export**，调用方不必改 import：远程访问向导步骤、加入码会话 / hook、中继磁贴格子、账号安全改密 / TOTP、侧栏节点分节、节点行吊销 / 批准。gateway `PeerManager` 的 ctl / lifecycle / wire、升级事务 commit / stage、CLI `dispatch.ts` 同理——公开符号仍从原文件出去。
