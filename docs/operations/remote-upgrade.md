# 远程升级：投递通道、推包续传与进度

本文描述入口把升级包送到远程节点的决策树、协议（偏移 / 乱序续传、`.part` 生命周期、重试预算）与前端进度展示；面向改动 `apps/gateway/src/system/remote-upgrade-*.ts` 的开发者。本机自升级见 [自更新](./self-update.md)，签名校验见 [发行包签名](./release-signing.md)。

## 背景

入口经中继向节点推送升级包（10–14 MB）时，中继隧道流被 RST（节点顶号重连、心跳判死、上行切换）会让整条 peer 链路连坐；若把 PUT 视为不可重试并删除 `.part`，整次升级就失败。中继 RST 在接收端表现为请求体「干净结束」而非报错，不比对 `content-length` 就会把半成品当坏包删掉。因此推包按偏移 / 区间续传。

节点若能自己从 GitHub 拉包，就不必走这条中继推送。2.3.7 起远程升级按三通道投递：先让节点速度门控自拉，慢或不通则入口代下再推，推失败再强制节点打 GitHub。

## 三通道决策树

`POST /api/mesh/nodes/:id/upgrade`（`apps/gateway/src/system/upgrade-service.ts` + `remote-upgrade-delivery.ts`）：

1. **版本**：body `{version}` 必须是已发布且带 CLI tarball 的 tag，否则 `400 RELEASE_NOT_FOUND`。缺省仍走 latest（查不到 `502 RELEASE_UNAVAILABLE`）。`vibeterm nodes upgrade --version <ver>` 把该字段写入 POST body。
2. **有 `release-speed-probe`**：job 先 `POST /api/system/upgrade {version, source:'release', requireFastSource:true}`。节点探测发行资产（默认 3 s / 64 KiB Range）：`fast` 启动自拉并 hand-off；`slow` / `unreachable` → `409 RELEASE_SLOW` / `RELEASE_UNREACHABLE` 且**不改**升级状态。
3. **无该能力（≤ 2.3.6）**：跳过门控自拉，直接推包。
4. **推包失败**（入口下载失败 / push timeout / `NODE_UNREACHABLE` / 启动失败，含重试用尽）→ `POST {source:'release', requireFastSource:false}` 强制节点打 GitHub。
5. **推包已成功、启动未确认**：`POST {source:'staged'}` 非成功同样回退强制节点 GitHub，失败细节进入聚合串。例外：`409 UPGRADE_IN_PROGRESS` 视为节点已经开始装包（handed-off），不再发第二次 start；启动超时后若 `GET /api/system/upgrade` 已是 `executing` / 非 idle，同样视为 handed-off。
6. **全失败**：`UpgradeStatus.error` 为聚合串，例如 `github(node): slow 12KB/3s; push: timeout; github(node, forced): fetch failed`。GUI `upgradeErrorText` 与 CLI 轮询均原文展示（不再依赖旧的 `^push failed:` 前缀）。
7. **无 `staged-package` 且无 `release-speed-probe`**：仍转发 `POST {version}`，不启入口 job。

进度：`progress.channel = 'node-github' | 'push' | 'node-github-forced'`。job running 时：`push` + `phase=start` → `UpgradeStatus.state=executing`，其余 `downloading`（`phase=push` 时前端仍靠 `transfer.kind==='push'` 显示推送）。旧入口不上报 `channel`。

本机 `POST /api/system/upgrade` / `vibeterm upgrade` 不走第二通道，见 [自更新](./self-update.md)。

线兼容：2.3.6 入口不发 `requireFastSource`、不读 `ranges`、不广告新能力；解析器忽略未知 JSON 字段。旧节点无 `release-speed-probe` → 今日「入口下再推」，推失败才强制 `source:'release'`（旧节点忽略该 flag，照常自拉）。

## 发行包下载

入口代下与本机 / CLI 自升级共用 `downloadAssetRanged`（`packages/shared/src/release/`，Node-only）：

- 人工跟随最多 5 跳（`redirect:'manual'`）。**每一跳**必须 `https:`；缺 Location / 非法 URL / 非 https / 主机不在允许名单 → `redirect_rejected`（探测判 `unreachable`，下载抛 `RedirectRejectedError`）。允许主机：起始 origin、`github.com`、`*.githubusercontent.com`。起始 URL 本身不强制 https（本地 `Bun.serve` / `VIBETERM_RELEASE_BASE_URL=http://127.0.0.1` 仍可用）。
- 分片请求打已解析的最终 URL，`redirect:'error'`；中途再 302 视为错误，从原始 URL 再解析一次后重试该分片。
- 默认 4 流 × 4 MiB Range（流数帽 8）。第一次带 Range 的 GET 若是 **200 或缺少 Content-Range**，把该响应当单流写完，不当成分片。`Content-Range` 的 total 与已知 `totalBytes` 不一致则失败。
- body `read()` 与 `AbortSignal` race；默认 60 s 无字节 → idle 超时（不是 AbortError）。分片失败退避重试（默认 3 次）。整包 sha256 仍 fail-closed。
- 入口 `downloadVerifiedRelease`：仍用 `.part` / sidecar / inflight 单飞 / 进度节流 512 KiB 或 500 ms / 失败删 `.part`。成功一行日志：`[upgrade] download url=<host> streams=N bytes=… ms=… verdict=fast|slow`。

速度探测 `probeReleaseAssetSpeed`（能力 `release-speed-probe`）：跟 302 到 CDN 后 Range `bytes=0-<minBytes-1>`，默认 `deadlineMs=3000`、`minBytes=64KiB`。调用方 abort → `AbortError`（`UPGRADE_CANCELLED`），不当成 unreachable。

## 协议

- `GET /api/system/upgrade/package?version=&sha256=` → `{ version, sha256, receivedBytes, complete, ranges? }`。`ranges` 为半开 `[start,end)`；有 `'staged-package-ranged'` 的节点会填。已落位包 `ranges: [[0, bytes]]`。旧入口忽略 `ranges`，按 `receivedBytes` 前缀处理。
- `PUT /api/system/upgrade/package?version=&sha256=&offset=N`：从 N 续写（追加）。磁盘大小 ≠ N → `409 UPGRADE_OFFSET_MISMATCH { receivedBytes }`；实收少于声明长度 → `500 PACKAGE_INCOMPLETE { receivedBytes }` 并保留 `.part`；`offset` 缺省/0 从头写（截断）。`offset == size` 的空体 PUT 触发校验并提交。
- 成对 `length` + `total`：乱序区间写入 `[offset, offset+length)`（可并行）。区间盖满 `total` 后整包 sha256，失败删半成品，成功 rename 落位。不带 `length`/`total`（2.3.6 入口）仍是 append-only。
- `.part` 为确定名 `…tgz.part-<sha 前 16 位>`，链路类失败保留，24 h 过期清理（`repairStagingArtifacts`），`DELETE` 一并清半成品；同一 `(version, sha256)` 的续传不受「同时只允许一个 staging」限制。乱序同 key 允许多条并行 PUT；追加同 key 可 preempt 挂死的流。
- `GET /api/system/info` 能力位：`staged-package`、`staged-package-resume`、`staged-package-ranged`、`release-speed-probe`、`signed-package`、`upgrade-cancel`、`uninstall`。旧节点无对应字段。
- `GET /api/mesh/nodes/:id/upgrade` 的 `progress { phase, channel?, pushedBytes, totalBytes, downloadedBytes?, downloadTotalBytes?, attempt }`，推送过程中每 ≥ 1 s 更新 `pushedBytes`（跨流只升不降）。
- `NodeUnreachableReason` 含 `link_lost`（`stream-aborted` / `relay-rst*` / `link-closed` / `replaced` / `stopped`），`no_link` 只表示压根没链路。
- `forwardAuthorizedHttp` 新增 `retry?: { attempts }`（带 rawBody 强制 1 次，JSON 体每次重建流）；`IDEMPOTENT_HTTP` 未扩大。

## 入口推送流程

查偏移 → `complete: true` 则跳过推包 → 否则只补发缺失段。目标有 `staged-package-ranged`：`runPush({ streams: 4, maxRangeBytes: 4MiB })`（流数 `min(requested, 8)`），PUT 查询串始终带 `offset/length/total`，断链后 GET `ranges[]` 补缺口。否则 `streams: 1`，查询串与今日相同（仅 `offset>0` 时带 offset）。同一 `(version, sha256)` 的 `total` 由首个 ranged PUT 钉死（`.part.total` 旁挂 + 闸门），后续不同 → `409 UPGRADE_TOTAL_MISMATCH` 且不写盘；`offset+length > total` → `400`。推包成功后的 staged `POST /api/system/upgrade` 非 2xx 回退到强制节点 GitHub；例外：`409 UPGRADE_IN_PROGRESS`（节点已在升）与 start 超时后 GET 已 `executing` 视为已交出，不重复启动。失败退避 1/2/4/8/15 s、最多 8 次（旧节点无续传能力：从零最多 3 次）、共用 15 min 推送预算；成功回包读 `text()`（消除 `forward aborted status=200 sent=0` 假告警）。满长度但 `complete: false` 的 `.part` 走空体 PUT 完成校验提交。日志：`[upgrade] push node=… streams=N bytes=… ms=…`。

## 前端

预算「有进展就重新计时」（按阶段覆盖后端超时：下载 10 min / 推送 15 min / 启动 60 s，硬顶 30 min；旧后端无 `progress` 字段沿用 6 min）；按钮显示「推送中 3.20 MB / 12.9 MB」或「下载中 3.20 MB / 12.9 MB」。稳定错误码（`NODE_UNREACHABLE`、`UPGRADE_NOT_ALLOWED`、`UPGRADE_IN_PROGRESS` 等）翻成中文；`link_lost` / 旧式 `push failed …` / `UPGRADE_OFFSET_MISMATCH` 仍映射；通道聚合串原文展示。

## 下载阶段的字节进度

入口从发行源拉包这一段同样上报字节进度，否则慢网下载十几分钟里前端毫无动静，看门狗会按「进度没动」把仍在正常下载的升级报成未确认：

- `downloadVerifiedRelease` 的选项新增 `onProgress(downloadedBytes, totalBytes)`。多个节点共享同一次
  inflight 下载时，进度按订阅者集合扇出；`totalBytes` 取响应的 `content-length`，缺失或不合法一律为 0
  （不猜总量）。下载在途时才订阅的调用方，注册后立刻补发一次当前计数，不用干等下一个分片。
- 上报在既有的哈希 Transform 里做，按「累计增量 ≥ 512 KiB 或距上次 ≥ 500 ms」节流，落盘收尾再补一次
  完整计数。作业结束（成功 / 失败 / 取消）即从订阅集合移除，不会向已结束的作业回调。
- `GET /api/mesh/nodes/:id/upgrade` 的 `progress` 新增可选的 `downloadedBytes` / `downloadTotalBytes`。
  两个字段独立于 `pushedBytes` / `totalBytes`——下载量不借用推包计数，旧入口不上报时前端按缺省处理。
- 前端把「入口在搬字节」统一成一个 `transfer { kind, transferredBytes, totalBytes }`：推包摆
  「推送中 3.20 MB / 12.9 MB」，下载摆「下载中 3.20 MB / 12.9 MB」，发行源没给 `content-length` 时
  退化成「下载中 3.20 MB」。看门狗的进度指纹把下载字节与推包字节同等看待，慢但在动的下载不再被判停摆。
- 节点自拉（`channel=node-github` / `node-github-forced`）入口不搬字节，前端只有阶段名。

本机自升级（`UpgradeController`）没有进度上报面，仍只有阶段名：`UpgradeStatus` 的 `progress`
面按合约只服务远程升级，`stageGithubRelease` 没有上报出口（见 [已知问题](../known-issues.md) KI-9）。推包途中重启中继 / 节点顶号的现网验证仍待做（KI-6）。

> 推包经转发链路上传时，转发层的「等待响应头」计时只在请求体全部写完后才开始，且授权转发的总期限按 `content-length / 128 KiB/s`（上限 10 分钟）追加上传预算；此前远端节点（如跨境 160 ms+ RTT）推 30 MB 包会在 20 s 内报 `NODE_UNREACHABLE http head timeout`。
