# 远程升级：推包续传与进度

本文描述入口把升级包推给远程节点的协议（偏移续传、`.part` 生命周期、重试预算）与前端进度展示；面向改动 `apps/gateway/src/system/remote-upgrade-*.ts` 的开发者。本机自升级见 [自更新](./self-update.md)，签名校验见 [发行包签名](./release-signing.md)。

## 背景

入口经中继向节点推送升级包（10–14 MB）时，中继隧道流被 RST（节点顶号重连、心跳判死、上行切换）会让整条 peer 链路连坐；若把 PUT 视为不可重试并删除 `.part`，整次升级就失败。中继 RST 在接收端表现为请求体「干净结束」而非报错，不比对 `content-length` 就会把半成品当坏包删掉。因此推包按偏移续传。

## 协议

- `GET /api/system/upgrade/package?version=&sha256=` → `{ version, sha256, receivedBytes, complete }`。
- `PUT /api/system/upgrade/package?version=&sha256=&offset=N`：从 N 续写；磁盘大小 ≠ N → `409 UPGRADE_OFFSET_MISMATCH { receivedBytes }`；实收少于声明长度 → `500 PACKAGE_INCOMPLETE { receivedBytes }` 并保留 `.part`；`offset` 缺省/0 从头写（截断）。`offset == size` 的空体 PUT 触发校验并提交。
- `.part` 改为确定名 `…tgz.part-<sha 前 16 位>`，链路类失败保留，24 h 过期清理（`repairStagingArtifacts`），`DELETE` 一并清半成品；同一 `(version, sha256)` 的续传不受「同时只允许一个 staging」限制。
- `GET /api/system/info` 能力位新增 `staged-package-resume`。
- `GET /api/mesh/nodes/:id/upgrade` 新增 `progress { phase, pushedBytes, totalBytes, attempt }`，推送过程中每 ≥ 1 s 更新 `pushedBytes`。
- `NodeUnreachableReason` 新增 `link_lost`（`stream-aborted` / `relay-rst*` / `link-closed` / `replaced` / `stopped`），`no_link` 只表示压根没链路。
- `forwardAuthorizedHttp` 新增 `retry?: { attempts }`（带 rawBody 强制 1 次，JSON 体每次重建流）；`IDEMPOTENT_HTTP` 未扩大。

## 入口推送流程

查偏移 → `complete: true` 则跳过推包 → 否则从偏移只补发缺失段 → 失败退避 1/2/4/8/15 s、最多 8 次（旧节点无能力位：从零最多 3 次）、共用 15 min 推送预算；成功回包读 `text()`（消除 `forward aborted status=200 sent=0` 假告警）。满长度但 `complete: false` 的 `.part` 走空体 PUT 完成校验提交。

## 前端

预算「有进展就重新计时」（按阶段覆盖后端超时：下载 10 min / 推送 15 min / 启动 60 s，硬顶 30 min；旧后端无 `progress` 字段沿用 6 min）；按钮显示「推送中 3.20 MB / 12.9 MB」；`link_lost` / `push failed …` / `UPGRADE_OFFSET_MISMATCH` 映射为中文文案。

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

本机自升级（`UpgradeController`）没有进度上报面，仍只有阶段名：`UpgradeStatus` 的 `progress` 面按合约只服务远程升级，`stageGithubRelease` 没有上报出口（见 [已知问题](../known-issues.md) KI-9）。推包途中重启中继 / 节点顶号的现网验证仍待做（KI-6）。
