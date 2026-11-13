# 浏览器文件传输：分块上传、流式下载、进度与取消

本文描述浏览器与节点之间的文件上传 / 下载协议：分块上传与两阶段进度、流式下载、取消、单文件上限、上传路径安全、本机设备免 rsync 与虚拟 `home` 根；面向改动 `apps/gateway/src/files/` 与 `packages/api-client` 传输代码的开发者。节点之间的直推传输见 [节点间文件传输](./node-to-node-transfer.md)。

## 背景

Files Tab 的上传 / 下载入口（右键菜单、长按菜单、拖拽）要求：分块上传（不把整文件读进内存）、上传两阶段进度（含最终 rsync 段速度）、下载流式进度、取消、可配置的 2GB 单文件上限。下载是两步（prepare 流式 NDJSON 进度 + content 流式文件）：大文件 / 远程下载否则会被 Bun.serve 默认 10s 空闲超时打断（`apps/gateway/src/index.ts` 设 `idleTimeout: 255`；prepare 持续吐进度使连接不空闲）。`POST /api/exec` 同样受该空闲上限约束：路由里对该请求 `server.timeout(req, 0)`，并在子进程存活期间每 10 秒发一条 NDJSON `ping`，避免静默命令在 255 s（或更旧的 10 s）处被掐断。Toast 同时显示**两段**进度条（上传：用户→VibeTerm、VibeTerm→服务器；下载：服务器→VibeTerm、VibeTerm→用户）。文件预览页（`FilePage.tsx`）的下载按钮走应用内 `downloadFileWithProgress`（带进度 Toast）；预览用的 `fileRawUrl`（图片/音视频/openRaw）不变；拖到桌面用单次 `GET /api/files/download`（浏览器原生）。

## 配置

- `VIBETERM_TRANSFER_MAX_BYTES`（默认 `2147483648` = 2GB）→ `config.transferMaxBytes`（`apps/gateway/src/config.ts`），上传下载共用。
- 经 `GET /api/system/info` 的 `SystemInfo.transferMaxBytes` 暴露给前端，上传前预校验文件大小。

## 本机设备免 rsync

`device.type === 'local'` 时，list / stat / raw / 文本预览 / mkdir / 上传 commit / 下载都走 `node:fs`（`apps/gateway/src/files/local-fs.ts`），**不 spawn rsync**。无 rsync 的 Docker / 最小主机上，本机设备的 `cp` 与 Files Tab 不再返回 `502 rsync_missing_local`。SSH 设备仍经 `rsync -e ssh`；宿主机 PATH 里没有 rsync 时，SSH 路径继续报 `rsync_missing_local`。

本机上传 commit 用 `copyFile` 把会话临时文件落到目标目录：先 `lstat` 确认 `destDir` 是真实目录（符号链接目录按 `not_a_directory` 拒绝），若目标名已是符号链接则先 `unlink` 再写入，避免写穿到 root 外。完成后回一条 100% 进度事件。本机下载仍直接交出原路径（`cleanup` 为空操作）。

## 虚拟 `home` 根

`GET /api/files/roots` 会附带一条不落库的虚拟根：`id = home-root`，`name = home`，`path = realpath(os.homedir())`，绑定 `sortOrder` 最低的本机设备，`virtual: true`。`resolveFileRoot('home-root')` 无论是否已有其它白名单根都成立，因此 `node:home/rel` 无需先 `files roots add`。访问令牌除外：令牌调用方的根列表不含虚拟根，`home-root` / `fs-root` 对令牌一律 `root_not_found`，令牌只能用管理员显式配置并启用的根（见 [访问令牌](../security/access-tokens.md)）。

用户创建的**启用**根展示名为 `home`（路径 basename）时，该用户根胜出：`resolveFileRoot('home-root')` 返回用户根，列表不再附带虚拟项。禁用的 `home` 名根不遮蔽。`PATCH` / `DELETE /api/files/roots/home-root` 返回 `400 root_virtual`。节点间 grant 的 `destRootId` 接受 `home-root`，边界仍是 grant 绑定的那个目录。

`fs-root`（`/`）语义不变：仅在零条启用根时有效，且**不**出现在 `GET /api/files/roots` 里。

## rsync 进度（跨版本）

- macOS 自带 openrsync 不支持 `--info=progress2`，但 openrsync 与 GNU rsync **都支持 `--progress`**；本项目每次 rsync 只传一个文件，单文件进度即整体进度，故统一用 `--progress`（加在 `rsyncUploadArgs`/`rsyncCopyArgs`），无需版本探测。
- `runRsync`（`apps/gateway/src/files/rsync.ts`）新增 `onProgress` 模式：增量读 stdout，按 `\r`/`\n` 切行，用 `parseRsyncProgress` 解析共有进度行 `<bytes> <pct>% <rate>/s`；并改用**空闲超时**（有进度即重置），对慢速大文件友好。

## 上传（分块 + 两阶段 + 取消）

会话模型（`transfer-session.ts` 管状态，`device-storage.pushFileToDevice` 把临时文件推到设备——本机走 fs、SSH 走 rsync，`api/files.ts` 接 HTTP）：

| 端点 | 作用 |
| --- | --- |
| `POST /api/files/mkdir` | 在文件根下建目录（`0755`；`recursive: true` 等价 `mkdir -p`）。路径规则与 `upload/init` 相同；已存在目录幂等返回 `created: false` |
| `POST /api/files/upload/init` | 校验 destDir 是已存在目录 + `size ≤ transferMaxBytes` + 文件名消毒；建会话与临时文件；返回 `{uploadId, chunkSize, ranged, commitProgress}`（`commitProgress`：提交段是否逐步回报进度，本机 `copyFile` 为 `false`、SSH rsync 为 `true`，旧节点缺省按 `true`） |
| `PUT /api/files/upload/:id?offset=N&length=M` | 按区间写入临时文件，允许乱序与并行（重叠区间 409，客户端退避续传） |
| `POST /api/files/upload/:id/commit` | 推送到设备（本机 `copyFile`，SSH rsync），**流式 NDJSON** 回传进度（`{type:'progress'|'done'|'error'}`），完成/失败/取消后清理 |
| `DELETE /api/files/upload/:id` | 取消：中止进行中的 rsync + 删临时文件 |

- 阶段一（浏览器→服务器）：`ApiClient.upload()` 用 XHR 发 PUT，按 `upload.onprogress` 逐字节回报（经网关闸门的远端节点同样走 XHR）；失败的区间回滚已计字节，总量不会超过「已落盘 + 在途」。阶段二（服务器→设备）由 commit 流回传。
- 两段合成一条进度时按 `onLegWeights` 加权：上传 `[1, commitProgress ? 1 : 0]`，下载 `[准备段有逐步进度 ? 1 : 0, 1]`；未完成前封顶 99%。
- 每个 chunk PUT ≤ chunkSize（8MB），远低于 Bun 默认 128MB body 上限，故 2GB 文件无需调高 `maxRequestBodySize`。
- 会话懒式 GC：>30min 未完成的僵尸会话在下次 create 时清理。
- 前端 `uploadFileChunked`（`packages/api-client/src/upload-transfer.ts`）串起 init→chunk→commit，`signal` 取消时 `DELETE` 会话。

## 路径安全（上传）

上传写远端路径，是文件子系统里唯一的写入面，规则固定在 `apps/gateway/src/files/device-storage.ts`：

- `sanitizeUploadName(raw)`：只取路径最后一段，拒绝空串、`.`、`..`，以及含 `/`、`\`、NUL 的名字，防目录穿越。
- 令牌对本机根的改动另有不可覆盖拒绝集（`tokenMutationDenied`）：删除 / 移动 / 改名 / 建目录 / 上传提交 / 打包共用同一判定。源路径含祖先；目标按最终落点含祖先。会话调用方不走这套闸门。见 [访问令牌](../security/access-tokens.md)。
- **目标文件不存在时不能对目标文件跑 `checkAndNormalize`**：local 分支的 `realpathSync` 会因路径不存在直接报 `not_found`。正确顺序是——校验**已存在的** `destDir` 落在 root 内，再 `statViaRsync` 确认它确实是目录（否则 `not_a_directory`），最后 `posixJoin(destDir, sanitizeUploadName(name))` 拼出远端路径。
- 上传**不创建**远端父目录，`destDir` 必须已存在。CLI `cp -r` 本地→节点前应先调 `POST /api/files/mkdir`：请求体 `{ rootId, path, recursive? }`，`path` 与 `statFile` / `upload/init` 相同（root 内绝对路径，经同一套词法规范化；`..` 越界、绝对路径逃逸、禁用根、root 外走 `file-http.ts` 既有 403 码）。成功 200 `{ path, created }`（已存在且为目录则 `created: false`）；目标是文件 400 `not_a_directory`（与 `upload/init` 共用 `CODE_STATUS`）；路径上的符号链接（含指向 root 外的目标）403 `outside_roots`；非 recursive 且父目录缺失 404 `not_found`；权限不足 403 `permission_denied`。`recursive` 超过 64 段或路径超过 4096 字节返回 400 `invalid`。本机创建后 `chmod 0755`（绕开 umask）；远端走 `mkdir -m 0755 --`。
- 设备 IO 经 `enqueueDeviceJob(deviceId, kind, job)`（`apps/gateway/src/files/queue.ts`）按三类排队：`transfer`（拉取 / 推送，同设备并发 3）、`read`（列目录 / stat / 读文本，同设备并发 4，不占传输名额）、`mutation`（改名 / 删除 / 建目录，独占）。排在 mutation 之后的任务一律等它完成，mutation 之间保持 FIFO；全局并发上限 8。推送到 SSH 设备时建目录与 rsync 分开排队。
- `rsyncUploadArgs` 与 `rsyncCopyArgs` 对称地调换源/目标，且上传**不加** `-L`（不跟随符号链接）。

## 下载（流式 + 进度 + 取消）

- `GET /api/files/download?rootId=&path=`：`pullFileFromDevice` 把文件准备到可读路径（本机设备直接读原文件；SSH 用 rsync 拉到 gateway 临时文件），校验 `size ≤ transferMaxBytes`，再流式返回。SSH 路径流结束/取消后删临时文件；本机路径的 `cleanup` 是空操作。
- 前端 `downloadFileWithProgress`（`packages/api-client/src/download-transfer.ts` + `ranged-download.ts`）：prepare 后按 8 MiB 分块，以 `streams` 条并行 `Range: bytes=a-b` 拉取（本机 4、经中继 2），首块取得强 `ETag` 后其余块带 `If-Range`；源文件变化回 200 即报「传输期间源文件发生变化」。节点不支持区间时退回单流续传。每个请求中断后从自身已收偏移续传；只要有新进度就重置失败计数，连续 4 次零进度才报 `TransferInterruptedError`；4xx（408/429 除外）立即失败。分块按序组装为 `Blob` 保存。
- 文件端点（`download/:id/content`、`download`、`raw`）统一带强 `ETag`（源文件身份的哈希，SSH 临时副本按源文件 size + mtime + 路径生成）、`Last-Modified`、`Accept-Ranges`、`X-VibeTerm-Entity-Length`；`If-Range` 只认强 ETag；畸形或多段 Range 忽略并回 200。
- 经入口转发到远端节点时，路由切换 / 直连重掷会关闭旧链路；转发层对可续传的 GET 响应（强 ETag + 长度已知 + `Accept-Ranges`）在新链路上以 `Range` + `If-Range` 无缝接续，浏览器无感知。不可续传的流（如打包下载）两端按流计数，提速类切换等其结束再退役旧链路。强制下载分支保留消毒后的文件名，打包下载经转发仍是 `*.tar.gz`。
- 拖到桌面（`DownloadURL`）改指向 `/api/files/download`（浏览器原生下载，支持大文件流式，无应用内进度）。`/api/files/raw` 仍用于文件查看器内联预览（小文件）。

## 文件字节响应头

文件字节在入口 origin 下回给浏览器，带脚本的文件（SVG、HTML）不得按可执行类型内联。本机 `serveFileBytes`（`raw`、`download`、`download/:id/content`）与入口转发的 `/n/:id/*` 响应共用 `applySafeFileHeaders`（`apps/gateway/src/files/safe-file-headers.ts`），同一文件经本机或经转发访问，浏览器行为一致：

- 只有白名单类型可内联：`image/png image/jpeg image/gif image/webp image/avif video/mp4 video/webm audio/mpeg audio/ogg audio/wav text/plain application/json application/x-ndjson application/pdf application/octet-stream`。其余（`text/html`、任何 XML、脚本类型等）改为 `application/octet-stream` + `Content-Disposition: attachment`。
- SVG 例外：浏览器以图片目的地拉取（`Sec-Fetch-Dest: image`，即 `<img>`、CSS 背景，脚本不会执行）时按 `image/svg+xml` 回，文件查看器与 Markdown 里的 SVG 图照常显示；直接打开（「打开原文件」、地址栏）时按附件下载。响应带 `Vary: Sec-Fetch-Dest`。不发 `Sec-Fetch-Dest` 的旧浏览器一律下载。
- 一律带 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`：导航打开时在 opaque origin 渲染，碰不到入口的 cookie 与 API。PDF 在 sandbox 下仍可 iframe 内联（Chrome 91+、Safari 18.4+）。
- `download=1` 与下载端点仍是附件；附件的 `Content-Type` 只保留白名单类型，其余为 `application/octet-stream`。
- 打包下载固定 `application/gzip` + 附件，不经这条规则。

## 进度 Toast（`packages/panels/src/files/transfer-toast.tsx`）

- 一次传输（单个或一批文件）一张 sonner Toast。单文件：文件名 + 直连/中转标记（仅远端节点）+ 一条进度条 + 阶段 + 速率与字节。批量：整体进度（按字节加权）+ `已完成 x/N` + 各文件小进度条与阶段。
- 批量上传由 `transfer-batch.ts` 并发调度：本机 3 个文件、经中继 2 个；所有文件共享 4 条流的预算（单文件仍用满 `pickTransferStreams`），避免占满浏览器 HTTP/1.1 每主机 6 连接。
- 失败卡片给出具体原因（`describeTransferError`：网络中断、需要登录该节点、节点不可达、超过大小上限、源文件变化、浏览器保存失败或文件操作错误码）；批量失败列出前 3 个 `文件名：原因`。
- **工作态 `duration: Infinity` + `dismissible: false`**：不会自动消失、也不可手动关闭，唯一中止途径是取消按钮（触发 `AbortController`）。完成后短暂停留自动消失；失败/取消保留可手动关闭。

## 测试

- 单测：`parseRsyncProgress`（openrsync/GNU 样例）、`rsyncUploadArgs`/`rsyncCopyArgs` 含 `--progress`、`transfer-session` 的 chunk offset/越界校验、`sanitizeUploadName` 穿越用例、本机 list/stat/push 不 spawn rsync、虚拟 `home-root` 解析与 `root_virtual`。
- e2e（`apps/fe/tests/files-context-menu.spec.ts`）：经真实 local 设备 + rsync——菜单分块上传出现进度 toast 且文件入树；菜单流式下载触发 download 事件且内容一致。

## 临时文件清理与权限

- **临时目录位置/权限**：浏览器经网关的上传会话（`vibeterm-up-*`）与下载拉取（`vibeterm-dl-*`）均用 `os.tmpdir()` + `mkdtempSync`（每用户临时区，目录权限 `0700`）。节点间传到 SSH 设备的本机暂存不走这里，见 [节点间传输](./node-to-node-transfer.md)。
- **清理三重保障**（成功 / 失败 / 中断 / 取消都妥善清理）：
  1. **显式清理**：上传 commit 的 `.finally` 与流 `cancel`、`DELETE` 端点均 `removeUploadSession`（中止 rsync + 删临时）；下载流 `pull` 完成 / `cancel` / `error` 均 `cleanup`，rsync 失败/超限路径也先 `cleanup`；下载拉取成功后若构造响应流同步失败也兜底 `cleanup`。
  2. **周期 GC**：每 5min 扫描内存会话，清理 >30min 未完成的遗弃会话（如客户端关页面未发 DELETE）；定时器 `unref`，不阻塞退出。
  3. **启动孤儿扫描**：gateway 启动调用 `sweepOrphanTransferTemps()`，清理上次崩溃残留的 `vibeterm-up-*`/`vibeterm-dl-*`（>1h，多实例安全）。

## 注意 / 限制

- 下载在浏览器侧用 `Blob` 累积全部分块再保存：2GB 接近浏览器 Blob 内存上限（Chrome 通常会落盘），超大文件可能吃紧。
- 下载的「设备→服务器 rsync」段显示为「准备中」。
- 下载临时文件落在 gateway 磁盘（rsync 机制所限），靠流结束删 + 取消清理。
- 拖到桌面为浏览器原生，无应用内进度/取消。
