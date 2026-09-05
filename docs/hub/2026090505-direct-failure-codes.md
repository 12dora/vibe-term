# 直连失败码与链路信息窗的 i18n（1.1.34）

## 背景

链路徽标的信息窗（`apps/fe/src/node/device-node-badges.tsx`，`data-testid="ice-diagnostics"`）里所有
**label** 早就 i18n 了，但**值**全是服务端或浏览器的原始英文：未直连原因（`failure.ws` / `failure.dc`）、
ICE 状态、候选类型、候选对。中文界面上一半是中文一半是 `all endpoints backing off (next eligible in 42s)`。

除了没翻译，还有两个更实际的问题：

- **静默洞**：一个可拨地址都没有时 `dialWsSecure` 直接 `return null`，什么都不记，浮层上那一行是空的；
  熔断冷却期间 `tryDc` 返回 null 不设 `dcError`，DataChannel 那半边整个消失，用户只会以为「没试过」。
- **原文不可解析**：原因是自由文本（`Error.message` 直传），前端没法按语义分档，也没法做等价判断。

## 设计

服务端把两类原因收敛成**稳定错误码**（`DirectFailureCode`）连同插值参数一起下发，原文保留给旧前端兜底；
前端按码翻 `nodes.badge.failure.<code>`，码缺失或不认识就显示原文。

码表是对外契约：`packages/api-client/src/auth/types.ts` 的 `DIRECT_FAILURE_CODES`（运行时常量数组，
`DirectFailureCode` 由它推出）。网关不依赖 `@tmex/api-client`，在
`apps/gateway/src/mesh/peer-manager-types.ts` 镜像一份——**改码表要两边一起改，并同步三语文案**。

23 个码：`timeout`、`refused`、`unreachable`、`reset`、`tls`、`handshake`、`revoked`、`untrusted`、
`backoff`、`no_endpoints`、`ice_failed`、`no_candidates`、`dc_open_timeout`、`dc_closed`、
`liveness_timeout`、`signal_dropped`、`signaling_state`、`rtc_unavailable`、`not_direct_capable`、
`breaker_cooling`、`breaker_paused`、`aborted`、`other`。

DTO（`MeshNodeDirectFailure`）：

```ts
{ at, ws?, wsCode?, wsParams?: { url?, seconds? }, dc?, dcCode?, dcParams?: { until? } }
```

`ws` / `dc` 是原文，`*Code` / `*Params` 是新增字段；旧网关不下发 code，前端自动回落原文。
链路详情本来就是整个对象透传，网关到前端不需要逐字段搬运。

## 映射表

映射与 `dcFailureReason` 都在 `apps/gateway/src/mesh/direct-failure-codes.ts`（抽成独立模块，
既是为了两个调用方共用，也是为了 `peer-manager.ts` / `peer-dc-upgrade.ts` 不顶破行数门禁）。

### ws 侧：`WsDialFailureKind` → 码

分类器是 `peer-ws-race.ts` 的 `classifyWsDialKind`，本轮补了三类：`PeerHandshakeError.code === 'revoked'`
单独成 `revoked`；证书类报文（`certificate` / `self-signed` / `unable to verify` / `err_cert` / `ssl` /
`hostname mismatch`）成 `tls`；`not-trusted` 类成 `untrusted`。

| kind | 码 |
|---|---|
| `timeout` / `open-timeout` | `timeout` |
| `refused` | `refused` |
| `unreachable` | `unreachable` |
| `reset` | `reset` |
| `protocol` | `handshake` |
| `tls` / `revoked` / `untrusted` / `aborted` / `other` | 同名 |

`raceWsSecureEndpoints` 的返回值改成 `WsSecureRaceResult`，多带 `lastKind`（此前分类算完就被丢掉）与
`lastUrl`。三个记录点（都在 `peer-direct-attempt.ts`，`peer-manager.ts` 侧各一行调用）：

| 场景 | 记录函数 | 码 | 参数 |
|---|---|---|---|
| 一个地址都没公布 | `noteNoEndpoints` | `no_endpoints` | — |
| 全部地址在退避中 | `noteWsBackoff` | `backoff` | `seconds` |
| 竞速失败 | `noteWsRaceFailure` | `wsFailureCode(lastKind)` | `url` |

### DataChannel 侧：`classifyRtcDialFailure` → 码

`dcFailureReason` 从 `peer-dc-upgrade.ts` 移到 `direct-failure-codes.ts`（纯函数），返回
`{ text, code, params? }`。分类复用熔断器已有的 `classifyRtcDialFailure`；分类前先摘出
「no (ice) candidates / candidates exhausted」→ `no_candidates`。

| 分类 | 码 |
|---|---|
| `signal-dropped` | `signal_dropped` |
| `liveness-timeout` / `missed-pong` | `liveness_timeout` |
| `timeout` | `dc_open_timeout` |
| `ice` | `ice_failed` |
| `abort` | `aborted` |
| `protocol` | `handshake` |
| `channel-error` / `channel-closed` / `transport-lost` | `dc_closed` |
| `signaling-state` | `signaling_state` |
| 其余 | `other` |

前置判定（不进分类器）：`directCapable === false` → `not_direct_capable`；WebRTC 不可用 →
`rtc_unavailable`；熔断未放行 → `breaker_cooling` / `breaker_paused`（见下）。

## `breaker_cooling` 与 `breaker_paused`

`dial()` 把 `dcBreaker.shouldTry()` 的 `until` 记进 `dcCoolingUntil` 传给 `finishDirectAttempt`。
`dcFailureReason` 里 **`coolingUntil !== undefined` 就表示这轮压根没拨号**（`undefined` 才是「拨了但失败」），
于是：

| 情况 | 码 | 参数 | 文案 |
|---|---|---|---|
| 熔断冷却，有解除时刻 | `breaker_cooling` | `until`（epoch ms） | 「暂停至 {{until}}」 |
| 熔断生效但无解除时刻（永久禁拨） | `breaker_paused` | — | 「直连已暂停」 |

分成两个码是因为 `breaker_cooling` 的三语模板都要 `{{until}}`：永久禁拨走同一个码会在界面上原样显示
`暂停至 {{until}}`，而且把「禁用」误描述成「冷却」。前端对**不下发新码的旧网关**也兼容——
`dcCode === 'breaker_cooling'` 且没有 `until` 时按 `breaker_paused` 显示。

## 前端渲染

`directFailureRows(failure)`（`device-node-badges.tsx`）：

```ts
function failureRow(labelKey, raw, code, params) {
  if (!code || !KNOWN_FAILURE_CODES.has(code)) return { labelKey, value: raw };  // 原文兜底
  return { labelKey, valueKey: `nodes.badge.failure.${code}`, valueParams: params, mono: false };
}
```

- **原文兜底**：码缺失（旧网关）或不在 `DIRECT_FAILURE_CODES` 里（新网关配旧前端）一律显示原文，
  并用等宽字体——等宽只留给机器措辞。
- `until` 在前端按本地时区格式化成 `HH:MM` 再插值（跨天的冷却本就不该发生，不带日期）。
- `direct-diagnostics.ts` 的 `normalizeDirectFailure` 先校验一遍码与参数（不认识的码丢弃、回落原文），
  组件侧再兜一层。

ICE 明细同样按枚举翻译：`connectionState` / `iceConnectionState` → `nodes.badge.ice.<state>`（W3C 枚举 8 个），
候选类型 → `nodes.badge.candidate.<host|srflx|prflx|relay>`，浏览器方言原样展示。`selectedPair` 保持
`本端 → 对端` 形状、两端各自翻译（`DiagnosticRowSpec.valueParts` + `resolveRowValue`），两端都取不到时
退回整串原文。RTT 单位仍是 `ms`，`peerAddress` 保留原文。

## 文案

三语同步新增：`nodes.badge.failure.*`（23）、`nodes.badge.ice.*`（8）、`nodes.badge.candidate.*`（4）。
ja 用名词短语，与表格里 `測定中` / `不明` 的风格一致，也免得在 288 px 宽的浮层里被截断。

有意**没改**的两处 locale：`nodes.hub` 的 zh_CN 是 `Hub`（文案规范要求直接写 Hub，且 zh 语料里统一是
`主 Hub` / `备 Hub`）；`relay.admin.tenants.columns.id` 的 ja_JP 是 `ID`（ja 语料里标识符一律写 `ID`）。

## 测试

- `apps/gateway/src/mesh/direct-failure-code.test.ts`：ws 分类 → 码全表、`revoked`/`tls`/`untrusted` 的窄化、
  竞速带出 `lastKind`/`lastUrl`、13 条 dc 原文 → 码、`dcFailureReason` 的四种分支
  （不支持直连 / 无 WebRTC / 熔断冷却带与不带 `until` / 真实错误）。
- `apps/gateway/src/mesh/peer-direct-attempt.test.ts`：码与参数随原文一起写入 / 一起清空。
- `apps/fe/src/node/device-node-badges.test.tsx`：按码翻译 + 参数、`until` 本地时间格式化、
  无码 / 未知码回落原文、无 `until` 换 `breaker_paused`、ICE 枚举与候选类型的翻译与方言兜底、候选对退回原串。

## 相关

`docs/hub/2026090306-rtc-dial-breaker.md`、`docs/hub/2026090305-peer-endpoint-backoff.md`、
`docs/hub/2026090502-rtc-signaling-epoch-link-liveness.md`。
