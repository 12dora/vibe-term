# 节点间文件传输（round 32）

## 背景

浏览器侧的文件传输一直是「下载到本地再上传到另一台」：两跳、两份带宽、大文件基本不可用。
节点间传输让源节点 A 直接把字节推给目标节点 B，链路复用现成的 peer 通道
（dc / ws-secure / relay 自动选择），断点续传与并行分片复用共享引擎 `@vibeterm/transfer`。

实现分布在 `apps/gateway/src/transfer/`，A 侧与 B 侧是同一份代码的两个角色；A === B 时
走本机通道，调用的仍是同一个接收服务，两条路径语义一致。

## 授权模型

`/api/mesh-internal/*` 的 peer 标记只证明「对端是本用户的某台受信任节点」。仅凭它，任何一台
节点都能往别的节点上写文件，所以传输另有一层一次性授权：

1. 浏览器用**自己在 B 上的会话**调 `POST /n/<B>/api/transfer/grants`，声明「哪个源节点、写到
   哪个 root 的哪个目录」。B 校验目录落在 root 内，签发 `{grantId, token}`，10 分钟有效。
2. 浏览器带着这张 grant 在 A 上建任务：`POST /n/<A>/api/transfer/jobs`。
3. A 用 grant 向 B 建会话，B 一次性核销（`consumed` 即删），并把会话绑死在
   `fromNodeId + destRootId + 授权目录` 上。之后每个会话请求都会复核 peer 标记与会话归属。

**落点边界是 grant 绑定的那个目录，不是 root。** 本机目标从授权目录的 realpath 出发逐段
`lstat` 下探：遇到符号链接直接判 `outside_roots`，缺失的段就地创建后再复核 realpath 仍在边界内；
半成品文件名（`.part-<hash>`）也一并检查，那个命名空间里出现符号链接只可能是攻击。
ssh 目标在远端用一条 `sh` 命令完成同样的核对（root → destDir 的 realpath 包含关系、
每段不是符号链接、缺失目录就地创建），字节先落本机暂存目录，再 rsync 推到核对过的真实目录。

残余风险：ssh 目标的核对与 rsync 之间存在 TOCTOU 窗口（对端有写权限的进程可在两步之间把目录
换成符号链接）。本机目标没有这个窗口。

## 协议

**A 侧（浏览器可见）**

```
POST   /api/transfer/grants                 { fromNodeId, destRootId, destPath } → { grantId, token, expiresAt }
POST   /api/transfer/jobs                   { toNodeId, items, destRootId, destPath, grant, onConflict? }
GET    /api/transfer/jobs                   → { jobs }
GET    /api/transfer/jobs/:id               → { job }
DELETE /api/transfer/jobs/:id               取消
GET    /api/transfer/jobs/:id/events        NDJSON：snapshot → progress/item/state… → end
```

**B 侧（peer-only，`/api/mesh-internal/transfer/*`）**

```
POST   /sessions                            { grantId, token, onConflict } → { sessionId, capabilities, maxFileBytes, chunkSize, expiresAt }
POST   /sessions/:sid/status                { relPath, size } → { receivedBytes, ranges }
PUT    /sessions/:sid/files?rel=&size=&offset=&length=   原始字节 → { received, complete }
POST   /sessions/:sid/commit                { relPath, size } → { ok, skipped }
POST   /sessions/:sid/dirs                  { relPath } → { ok }          // 空目录条目
POST   /sessions/:sid/keepalive             → { ok, expiresAt }           // 源侧暂存期间续期
DELETE /sessions/:sid                       → { ok }                      // 等在跑的操作收尾后才返回
```

任务在 A 上的顺序是**先建会话、再展开目录**：grant 没过就遍历磁盘等于让未授权的调用方白使唤
一遍 IO。展开用一次递归 `rsync --list-only`（浏览用的分页列表会在 2000 条截断，传输不能吃
这种截断），目录条目也进清单，空目录因此不会丢。

冲突策略 `onConflict`：
- `skip`：本机目标由 sink 用 `link(2)` 原子抢占（EEXIST 即跳过，不会误删别人刚落位的文件）；
  ssh 目标额外带 rsync 的 `--ignore-existing`。
- `overwrite`：`rename(2)` 原子替换。

落位分两步记账：本机 rename 完成只算 `stagedDone`，ssh 推送成功才算 `committed`——推失败时
重复 commit 会从推送这一步接着来，不会谎报完成。

## 限制

| 项 | 值 | 位置 |
|---|---|---|
| 单文件上限 | `VIBETERM_TRANSFER_MAX_BYTES`（默认 2 GiB）与中继下发上限取小 | `files/transfer-limit.ts` |
| 单次 PUT 分片 | 8 MiB（`VIBETERM_TRANSFER_CHUNK_BYTES` 可覆盖，下限 64 KiB） | `transfer/limits.ts` |
| 展开文件数 / 访问条目数 / 层级 | 5000 / 20000 / 32 | `transfer/expand.ts` |
| 单会话文件数 / 累计字节 / 并发写 | 5000 / 64 GiB（`VIBETERM_TRANSFER_SESSION_MAX_BYTES`）/ 16 | `transfer/limits.ts` |
| 会话数（每源节点 / 全节点） | 4 / 32 | 同上 |
| 任务数（每用户 / 全节点，排队+在跑） | 8 / 32，超出 429 `too_many_jobs` | 同上 |
| 并行流 | 中继 2、直连 4、A === B 1 | `transfer/bridge.ts` |
| 会话空闲回收 | 10 分钟；字节在动或有进行中的操作都算活着 | `transfer/receiver.ts` |
| 完成任务保留 | 30 分钟，最多 200 条，独立定时器淘汰 | `transfer/job-registry.ts` |
| 单订阅者事件预算 | 256 条（进度/条目就地合并），超出断开但保留 `end` | `transfer/job-events.ts` |

## 清理

- **会话关闭**：先置 `closing` 拦住新操作，再等在跑的操作收尾，最后才丢弃半成品、清暂存文件、
  摘掉会话。顺序反了会出现「清理跑完之后又冒出一个旁挂 `.rx`」这种没人再管得到的残留。
- **取消**：任务信号一路传到本机通道的读取管道、推送驱动、以及 ssh 落位的 rsync 子进程；
  终态判定里取消优先——只要任务被取消过，结果一定是 `cancelled`。
- **断点续传的身份**：半成品名字由 `(授权作用域, relPath, size)` 确定，与会话 id 无关。
  进程崩溃后换一张 grant、换一个会话，仍然接着上次的偏移传。同一时刻同一个半成品只允许一个
  会话在写（进程内声明），第二个会话拿到 `dest_conflict`。
- **孤儿清扫**（`transfer/sweep.ts`）：开机 30 s 后跑一次，之后每 6 小时一次。
  本机 root 下按广度优先扫 `.part-<16 位十六进制>`（目录数 ≤ 2000、层级 ≤ 6，不跟符号链接），
  ssh 暂存目录 `vibeterm-rx-*` 整目录按 TTL（24 小时）回收；正在被会话使用的一律跳过。
  测试环境（`NODE_ENV=test`）不挂这两个定时器。
