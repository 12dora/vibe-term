# WebRTC 直连熔断器重做

## 背景

旧熔断器只在 `dialDc()` 的 catch 里计数（8 次、冷却 6h），且成功一次或 peer 元数据变化就清零。真正的病灶——**通道能打开但立刻死掉**（`datachannel closed/error`、liveness timeout、missed pong）——完全不计数，`dropPeer` 还会直接排下一轮升级重试（5/15/30/60/120s）。结果是「开了就死」的链路永远熔断不了，`[mesh][rtc] dial failed` 刷屏。

本轮把 gateway 与浏览器两侧都换成同一套真实策略。

## 策略

两侧参数一致：

| 项 | 值 |
| --- | --- |
| 触发阈值 | 连续 **3** 次失败 |
| 冷却阶梯 | 30s → 60s → 120s … 上限 **30min** |
| 复位条件 | 通道保持健康 **≥ 60s** |

- `cooldownLevel` 在冷却过期后**仍然保留**，下次再触发直接用更长的一档。短命通道（开了不到 60s 就死）计一次失败，不会把 level 降回去。
- 复位只认「健康满 60s」。`noteSuccess()` 已废弃成 no-op；`notePeerChanged()`（endpoints / inventory / `direct_capable` 变化）只清掉在途 attempt 标记，不再清零计数。
- 失败按 attempt / session id 去重：同一次尝试从多条路径报错只计一次。

### 什么算失败

拨号失败，以及通道打开后的异常关闭：`liveness-timeout`、`missed-pong`、`timeout`、`ice`、`channel-error`、`channel-closed`、`protocol`、`transport-lost`。

**不算失败**（有意的关闭）：`stopped`、`revoked`、`idle`、`replaced`、`stale`、`not-trusted`、`lower-priority`、`simultaneous-dial`。`dialDc` 对 `AbortError` 及消息里含 `abort` 的错误也不计，避免 `stop()` 与竞态 abort 误触发。

### 冷却期间

不自动拨 DC，保持 ws-secure / relay。`armDcUpgradeRetry` 只在 `until` 时刻排**一次**探测。强制探测各有一个入口：

- gateway：`PeerManager.forceDcProbe(nodeId)`（**尚无 HTTP 接口 / UI 按钮**）。
- 浏览器：`GatewayConnection.retryDirect()` → `DirectCarrierController.retryDirect()`，冷却中恰好放行一次。`retry()` 走同一条路径，**不再**清零失败计数；连接 ACTIVE 本身也不清零，仍要满 60s 才 reset。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TMEX_RTC_DIAL_BREAKER_MS` | `30000` | **起始**冷却时长。语义已变——旧版是「熔断后的总时长 6h」，现在是阶梯的第一档，指数上限仍是 30min，失败阈值不受影响 |

`init` / `upgrade` 不写这个键，只有手动配置才出现。

## 日志

```
[mesh][rtc] breaker trip peer=<id> fails=<n> level=<n> cooldown_ms=<ms> until=<iso>
[mesh][rtc] breaker reset peer=<id> healthy_ms=<ms>
```

每次状态迁移各一条。冷却期内跳过的拨号打在既有的 `dial failed` 上，带 `cause=breaker_cooling`，同一 peer 仍按 60s 聚合并带 `count=`。

## 对外字段

`GET /api/mesh/nodes` 的行上新增可选字段：

```ts
MeshNode.dcBreaker?: {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
} | null
```

本机（self）为 `null`。

**WS `NODE_EVENT` 帧不带 `dcBreaker`**：borsh schema 未升版，进程内的 `NodeEventPayload.dcBreaker` 只用于 gateway 侧事件去重。前端若只订阅 WS 事件，要等下一次 REST 刷新才能看到熔断状态变化。

浏览器侧 `DirectDiagnostics` 增加可选的 `cooling` / `until` / `failures` / `level` / `lastFailureKind`，由 `DirectCarrierController` 快照填充。

## 注意

- 熔断只关 DataChannel 这一档，不改 transport 优先级，也不改 `directCapable !== false` 的门闩：ws-secure 与 relay 不受影响，用户看到的是链路徽标从「直连」退到「局域网 / 中继」。
- UI 目前不展示熔断状态（节点徽标 / 诊断面板留待后续小任务），排查请看日志或直接读 REST。
