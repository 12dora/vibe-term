# 远程升级推包续传（1.1.31）

## 背景

入口经中继向节点推送升级包（10–14 MB）时，中继隧道流被 RST（节点顶号重连、心跳判死、上行切换）会让整条 peer 链路连坐，`forwardAuthorizedHttp` 视 PUT 为不可重试，节点删除 `.part`，整次升级失败并给用户一串英文原始错误。实测还发现：中继 RST 在接收端表现为请求体「干净结束」而非报错，不比对 `content-length` 就会把半成品当坏包删掉。

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

## 验证建议

上线后按 EX1 复现路径实测一次：推包途中重启中继或让节点顶号，确认 `.part` 保留、只补发剩余字节、最终升级成功。
