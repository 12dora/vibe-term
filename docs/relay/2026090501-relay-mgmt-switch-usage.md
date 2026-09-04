# 中继管理 / 中继切换 / 实时用量（1.1.30）

## 背景

1.1.29 的中继相关界面暴露了过多内部量（元数据密钥代数、密钥日志、令牌下限），链路错误直接插值原始字符串且在重连成功后仍显示「最近错误」，配额只有节点数带用量，多中继只能靠优先级 failover 无法手动切换，接入设备向导只覆盖 Hub 路径。本轮（round 27）统一处理。

## 目标

1. 链路错误语义改为「当前错误」并可翻译。
2. 三档配额（节点 / 并发流 / 带宽）都能实时监控，节点侧与运营者侧同源。
3. 节点可手动切换当前中继，选择可持久化。
4. 中继管理页按运营者工作流重排（租户 → 接入节点），表格可检索 / 排序 / 筛选。
5. 接入向导覆盖中继 / Hub / SSH 三条路径并解释差异。

## 设计

### 当前错误与错误码

- 节点侧 `RelayUplinkClient` / `UplinkClient` 认证成功即清空 `lastConnectError`；`UplinkPool` 在 promote 时清空该 URL 的诊断；live 链路终止原因（心跳丢失、被踢、远端关闭）在清理前写回该 URL 的诊断，避免断线后只剩 `null`。
- `apps/gateway/src/mesh/relay-link-error.ts` 把原始错误归一化为闭集 `RelayLinkErrorCode`（connect-failed / connect-timeout / auth-timeout / auth-rejected / heartbeat-lost / kicked / dns / refused / tls / protocol / unknown），`stopped` / `aborted` 视为无错误。
- `GET /api/mesh/relay/status.relays[n]` 新增 `lastErrorCode`；`online === true` 时 `lastError` / `lastErrorCode` / `lastErrorAt` 一律为 `null`（api-client 的 `normalizeRelayStatus` 再兜底一次）。前端只在离线时按 `relay.tenant.linkErrors.<code>` 显示。

### 实时用量

- 控制消息 `relay.quota` 新增可选 `usage { currentNodes, currentStreams, bytesInPerSec, bytesOutPerSec, bandwidthBytesPerSec?, sampledAt }`；接入后立即推一次，此后随 5 s 指标采样、用量指纹变化才推。旧中继不下发，旧节点忽略未知字段。
- `bandwidthBytesPerSec` 用量按令牌桶 `take()` 成功放行的字节计（`RelayMetering.recordAdmitted`），与配额上限同口径；不要用 `bytesIn + bytesOut`（同一 chunk 会在 in/out 各记一次）。
- `GET /api/relay/metrics.tenants[n].quota` 改为生效配额（租户覆盖 ?? 默认），新增 `tenants[n].usage` 与 `totals.bandwidthBytesPerSec`。运营者侧 `GET /api/relay/status` 的 `tenants[n].quota` 仍是原始覆盖值。
- 节点侧 `quota.usage` 只对当前 attached 的中继有值；本机卡片「连接详情」三档配额显示 `used / max` 与进度条，带宽无上限显示「不限」。

### 切换中继

- `POST /api/mesh/relay/switch { url }`（node-session 鉴权）：规范化 URL → 未配置 404 `RELAY_UNKNOWN` / 被踢 409 `RELAY_KICKED` / 已挂载 409 `RELAY_ALREADY_ATTACHED` → `UplinkPool.switchTo(url, signal)` make-before-break，10 s 超时即取消该次切换并回 502 `RELAY_SWITCH_FAILED`（body 带 `lastError` / `lastErrorCode`）；被并发切换取代的调用返回结构化失败，不会写首选。
- 成功后把 URL 写入本机 `gateway_kv` 键 `relay.preferredUrl`，`relay-wiring` 启动时把首选排在候选首位；不改签名的 `set-relays` 记录。
- 前端 `apps/fe/src/node/mesh-relay.ts` 的状态 store 带代数：切换成功后 +1，旧代的轮询结果与在途去重一律丢弃，避免陈旧 `/status` 覆盖新的 attached。切换进行中对话框不可关闭 / 重选。

### 中继管理页

- 标签 `relay.admin.tabLabel` → 「中继管理」，在 `SETTINGS_TAB_BAR` 中紧随 `nodes`；仍属 `OPTIONAL_SETTINGS_TABS`，不进预热列表。
- 页头三点菜单：修改接入密码（弹窗）；未设密码时页头下一条警告。租户卡三点菜单：默认配额（弹窗）。`RelayTabBody` 是 `useRelayMetrics` 的唯一持有者。
- 租户行可选（`aria-selected`），选中后接入节点卡只显示该租户成员；接入节点卡带检索（名称 / nodeId / tenantId）、七列排序（`aria-sort` 仅落在当前列，默认按 `memberTitle` 升序）与状态筛选；纯函数在 `relay-metrics-model.ts`。
- 中继是盲中继，成员 `name` 恒为 `null`，排序键实际是 `name ?? nodeId`。

### 接入向导

`apps/fe/src/components/side-panels/connect-devices/`：第 1 步选路径（经中继 / 经 Hub / SSH 直连，`connect-path.ts` 按 `relayMode && tenantId` / Hub 角色 / standalone 推导默认），二级选加入或自建。自建中继路径：本机设为中继 → 设置接入密码 → 接入本机中继（`relayMode && tenantId` 才算完成）→ 让新机器加入。SSH 路径先登记「打开新建设备」等待器再导航到 `/devices`，等待器不随侧栏卸载。加入码只在所选路径与本机真实上级一致时提供。

### 远程访问

`connectorState` 只在 `reachable === true` 且 `readyConnections` 为有限 0 时判「无边缘连接」，缺失计数一律 `unknown`；降级提示补一行排查指引（7844 端口、`*.argotunnel.com` / `*.cftunnel.com`）。本机实测该状态是真实的：Surge 把 `argotunnel.com` 走了代理策略导致 7844 不通，需在 Surge 加 `DOMAIN-SUFFIX,argotunnel.com,DIRECT`。

## 验收

- 各包 `bun test` 0 fail、tsc 0、根 `bun run lint` 通过（含复杂度门禁）。
- 临时打包实例（relay,node + 纯 relay 两进程）实测：本机卡片两行中继、点击切换 → 确认 → `/switch` 200、attached 变更；连接详情三档配额带用量；中继管理菜单 / 弹窗 / 租户选中过滤 / 检索排序均可用。

## 注意事项

- 临时实例的 `test.env.local` 由 setup 写入且会覆盖 shell 环境变量（`loadEnv` override=true）；多实例并行时要从文件里删掉 `TMEX_ROLES` / `TMEX_RELAY_PUBLIC_URL`，否则第二个实例的 `relayHost` 绑错导致 `RELAY_BAD_PROOF`。测完必须删除该文件。
- 追加中继时中继返回的 `RELAY_*` 401 由 `session-interceptor` 豁免，不再当作本机会话失效。
