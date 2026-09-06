# 端口映射（node A ↔ node B 的 TCP 隧道）

## 背景

mesh 里已经有一套成熟的流复用器（`packages/shared/src/link/`）：直连 ws-secure、WebRTC DataChannel、
hub/中继三条链路最终都收敛成同一个 `LinkSession`，`openStream(payload)` 就能开一条带信用额度流控的
双向字节流。此前缺的只是两端的原生 TCP：A 上的监听器与 B 上的拨号器。

端口映射解决的场景：把 B 上只监听 `127.0.0.1` 的服务（数据库、调试端口、内网 http）映射到 A 的本机端口，
浏览器/客户端直接连 A 的端口即可，不需要把服务暴露到公网。

## 设计

```
TCP 客户端 ──connect──> [A: net.createServer 127.0.0.1:5678]
                              │ 每条连接一条 LinkStream
                              │ openPayload {"type":"tcp","mapId":…,"host":…,"port":…}
                              ▼
                     PeerManager.getLink(B)（dc / ws-secure / relay 自动择优）
                              ▼
                      [B: acceptTcpStream] ──net.connect──> 127.0.0.1:12345
```

### 流类型与授权

- 新增流类型 `tcp`（`apps/gateway/src/mesh/types.ts` 的 `TcpStreamOpenPayload`）：
  `classifyOpenPayload` 识别，`PeerLiveRegistry.handleInboundStream` 分派到
  `apps/gateway/src/portmap/dispatch.ts`。
- peer 链路本身已完成 Ed25519 双向认证与加密，但它只证明「哪个节点在调用」。B 侧还要求
  `port_map_exports` 里存在一条 `mapId` 相同、`from_node_id` 等于握手对端、且 `enabled` 的记录，
  且请求的 `host`/`port` 与记录一致。否则 `stream.reset('portmap-forbidden')`。
  没有这层放行，任何 mesh 对端都能把节点当成 SOCKS 代理。
- 两条记录都由浏览器分别用各节点的会话建立：先在 B 上 `POST /api/portmap/exports` 拿到 `mapId`，
  再用同一个 `mapId` 在 A 上 `POST /api/portmap`。删除时反序。

### 数据表（迁移 `0050_port_maps.sql`）

- `port_maps`：A 侧监听行（`listen_host` 默认 `127.0.0.1`、`listen_port`、`target_node_id`、
  `target_host`、`target_port`、`paused`），`(listen_host, listen_port)` 有索引。
- `port_map_exports`：B 侧放行行，主键即 `map_id`。

存储层 `PortMapStore` / `PortMapExportStore`（drizzle）与对应的 Memory 实现藏在接口后面，形状照抄
`tunnel/config-store.ts`。

### 生命周期

- `PortMapManager`（`apps/gateway/src/portmap/manager.ts`）是网关级单例：`startLiveGatewayServices()`
  里开机恢复未暂停的行，`GatewayRuntime.stop()` 里收。端口被占的行保留在库里，状态置 `error`
  （`port_in_use`），不阻塞启动。
- mesh 运行时启动时按自身 nodeId 注册绑定（`bindPortMapNode`），提供 `PeerManager` 与本节点的放行表；
  mesh 停止时在 `stopQuietly` 里解绑。同进程跑多个 MeshRuntime（集成测试）因此互不串台。
- 暂停 = 停监听 + 重置在途流，行保留；恢复是「先绑上再落库」：`checkPortAvailable` 或绑定失败时
  行仍是 `paused`，端口空出来后再 PATCH 一次还能重试；只要请求的状态是未暂停且当前没有监听就重试
  绑定，开机时端口被占（`state:'error'`）的行也走这条路。
- 删除 = 暂停 + 删行，并尽力而为地让 B 删掉对应的放行行（见下）。

### 为什么两侧都用 `node:net`

第一版两侧都用 `Bun.listen` / `Bun.connect`，实测（Bun 1.3.14，脚本见本轮存档）在真实的饱和发送
（python `socket.sendall` 循环）下会被 RST 掉，原因是 **Bun socket 的 `pause()` 只在第一次
`resume()` 之前有效**：一旦 resume 过，饱和发送方再打过来时 `pause()` 基本被忽略，即便每个 `data`
回调里都调用也拦不住——实测单条连接的程序内待发队列能涨到 32–43 MiB，泵只能判定
`portmap-buffer-overflow` 并断开。这就是 ≥ 20–50 MiB 的传输在真实中继链路上必然失败的原因。

同一台机器上 `node:net` 的 `pause()` 是**真背压**：pause 之后一个字节都不再上来，
`readableLength` 停在 ~3 MiB，发送方的 `sendall` 被内核堵住。所以监听端与拨号端都换成 `node:net`。

`node:net` 在 Bun 上有三个必须绕开的坑（都已实测确认）：

- `createServer({ allowHalfOpen: true })` / `connect({ allowHalfOpen: true })` 的选项**被忽略**
  （accept 出来的 socket 读回来是 `false`），于是对端的 FIN 会直接把 socket 销毁。必须在每个
  socket **实例**上打 `socket.allowHalfOpen = true`（`prepareSocket()`），打了之后 FIN 之后 300 ms
  才写出的回包能正常送达。
- `socket.end()` 仍然是两半一起关，所以写半边关闭继续走 `bun:ffi` 的 POSIX
  `shutdown(fd, SHUT_WR)`，只是作用对象换成 `socket._handle`（node:net socket 底下的原生句柄，
  带 `fd` 与 `readyState`，服务端 accept 的 socket 与 `net.connect` 连上后的 socket 都有）。
- 对端被 RST 掉时 Bun 的 net 壳同样只报 `end`，不报 `error`/`close`；区别在于此时 `socket._handle`
  已经没了（正常 FIN 时它还在且 `readyState === 1`）。`attachPumpSocketHandlers` 用这一点把「对端
  消失」与「对端半关闭」分开：句柄没了就当连接消失，销毁 socket 让 `close` 事件把并发名额还回来。

### 背压

泵（`apps/gateway/src/portmap/pump.ts`）不引入无界缓冲，直接把 TCP 背压与 mux 的信用额度接在一起：

- 远端 → 本地：`stream.readable` 的每一块写进 socket 后，只要 `socket.write()` 返回 `false`（越过
  socket 的 `writableHighWaterMark`）就等 `drain` 再拉下一块。mux 只在应用读取时才回 `WINDOW`
  额度，所以「不读」就是跨 mesh 的背压。
- 本地 → 远端：待发字节越过**高水位 1 MiB** 就 `socket.pause()`，`await stream.write` 把队列消到
  **低水位 256 KiB** 以下再 `resume()`。硬上限 `MAX_PENDING_BYTES = 8 MiB` 只兜异常，正常路径碰不到：
  实测 300 MiB 的饱和发送 + 慢消费者（每块 sleep 2 ms）跑满 20 s，队列峰值 1.49 MiB（≈ 1.5× 高水位），
  进程 RSS 158 MiB，全程没有 overflow。
- 拨号窗口（`getLink` + `openStream` 期间）：连接刚建立时**不**停读，收到第一块数据才
  `socket.pause()`——多余的字节留在内核缓冲里由 TCP 自己背压，程序内最多压一块。之所以不一上来就
  停读，是为了让「连上就走」的客户端立刻被发现。
- 拨号有 15 s 时限（`PORT_MAP_DIAL_DEADLINE_MS`）。超时后迟到的流会被 `reset`，socket 先 `resume`
  再关掉，让被压住的 `close` 事件出来归还名额——名额只在 socket 真正处置掉时才还。

### 半关闭与中断

- 本地 FIN → `stream.end()`；对端 END → 只关本地 socket 的**写半边**，读半边继续泵，直到目标自己
  发 FIN；两个方向都结束才整条关闭。目标服务完全可能读到 EOF 之后才产出响应（`nc -N`、某些
  行协议），少了这一步那类响应会被吞掉。
- **写半边关闭只能走 FFI**（实测矩阵见 `apps/gateway/src/portmap/half-close.ts`）：
  `Bun.Socket.end()` 立刻把本地句柄摘掉（`readyState` 变 -1，读半边一起没）；
  `socket.shutdown(true)` 只触发自己的 `end` 回调，对端根本收不到 FIN；`node:net` 的 `socket.end()`
  同样两半一起关。所以用 `bun:ffi` 直接调 POSIX 的 `shutdown(fd, SHUT_WR)`（与 `log/rotate.ts`
  加载 `dup2` 同一套路子，macOS 用 `libSystem.B.dylib`，Linux 依次试 glibc / musl 的 so 名），
  作用对象是 `socket._handle`。加载不到就退回 `socket.end()`，那类环境下 EOF 之后才产生的响应会丢。
- FFI 的 `shutdown` 绕过了 node 的写队列，所以必须等本 socket 上排队的写全部落盘（适配器记录在途
  写的回调）之后再关，否则未发出的字节会被丢掉。
- `socket.allowHalfOpen = true` 是必须的（实例级，见上）：它保证收到对端 FIN 之后本地还能继续写。
  代价是半关闭的连接要等目标那侧也结束才会释放；对端硬断（RST）靠 `_handle` 消失识别，立即释放。
- 链路丢失不重放：字节流没有重放点，`stream.onAbort` 直接关本地 socket，由客户端自己重连。
  B 侧的中断处理在拨号之前就注册好，流被 RST 时立刻取消底层的 `net.connect`——只丢 SYN 的地址
  否则能靠反复开流把 fd 耗光。

## 接口

节点 A（node-session 鉴权，错误体统一为 `{ error: { code, message } }`，`code` 见
`packages/shared/src/contracts/portmap.ts` 的 `PortMapErrorCode`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/portmap` | 列表，含实时计数（`activeConnections`/`totalConnections`/`bytesIn`/`bytesOut`） |
| POST | `/api/portmap` | 创建；`mapId` 可指定以对齐 B 的放行行；409 `port_in_use` / `port_reserved` |
| PATCH | `/api/portmap/:id` | 改名 / 暂停 / 恢复 |
| DELETE | `/api/portmap/:id` | 删除，同时停监听；返回 `{ ok, exportRemoved }`，`exportRemoved` 表示 B 上的放行行是否已一并清掉 |
| GET | `/api/portmap/probe?host=&port=` | 本机端口占用探测（`free`/`reserved`/`usedByMapId`） |

节点 B：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/portmap/exports` | 放行列表 |
| POST | `/api/portmap/exports` | 建放行行，返回 `mapId` |
| DELETE | `/api/portmap/exports/:mapId` | 删放行行 |
| GET | `/api/portmap/target-probe?host=&port=` | 目标端口是否有服务在监听（1.5 s 超时） |

节点间（peer 身份，`apps/gateway/src/portmap/internal-routes.ts`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| DELETE / POST | `/api/mesh-internal/portmap/exports/:mapId` | A 删除映射后顺手清 B 的放行行；只删 `from_node_id` 等于握手对端的行，缺失视为已清。失败只记日志，A 侧照删，界面按 `exportRemoved` 提示使用者自己去 B 上收尾。同时接受 POST 是因为节点间转发只发 POST |

## 限制

- **并发上限按 peer 链路算**。mux 的 `MAX_LINK_UNACKED = 65 MiB`（65 个满窗）一旦被突破会关掉整条
  peer 链路——那条链路同时承载着终端会话与文件传输。所以 A 侧指向同一节点的所有映射、B 侧来自同一
  对端的所有入站流共用一份名额：`PORT_MAP_MAX_PEER_STREAMS = 48`，给其它流量留 17 个窗口；超出的
  TCP 连接在 accept 时就断开、超出的入站流直接 RST，都发生在开流之前。单条映射另有 64 条的上限
  （`PORT_MAP_MAX_CONNECTIONS`），单节点最多 64 条映射行。
- **中继模式的计费**：peer 链路走中继时，整条链路在中继侧只是**一条**流（内层还有一层 mux），
  端口映射的流量与终端流量混在一起，按租户配额限速与计量，不会额外占用 `maxStreams` 名额，
  但中继也无法区分二者。要做「按功能公平分配」只能在节点侧做。
- **链路升级不迁移**：长连接会把旧载体（如 relay）钉住，DC 升级只对新连接生效，符合 TCP 语义。
- **绑定失败的报错时机**：`net` 的 `listen()` 只在事件里报错，但绑定本身是同步完成的——
  `server.address()` 立刻为 `null` 就说明端口被占，`PortMapListener.start()` 据此照旧同步抛
  `PortMapError('port_in_use')`；异步才冒出来的 `error` 事件走 `onBindFailed`，把行改回 `error` 态。
- `listen_host` 默认 `127.0.0.1`；填 `0.0.0.0` 等于把 B 的服务开放给 A 所在的局域网，需要使用者自己承担。
- 端口保留：网关端口与 `TMEX_PEER_PORT` 拒绝映射（`port_reserved`）。
