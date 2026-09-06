# 端口映射（node A ↔ node B 的 TCP 隧道）

## 背景

mesh 里已经有一套成熟的流复用器（`packages/shared/src/link/`）：直连 ws-secure、WebRTC DataChannel、
hub/中继三条链路最终都收敛成同一个 `LinkSession`，`openStream(payload)` 就能开一条带信用额度流控的
双向字节流。此前缺的只是两端的原生 TCP：A 上的监听器与 B 上的拨号器。

端口映射解决的场景：把 B 上只监听 `127.0.0.1` 的服务（数据库、调试端口、内网 http）映射到 A 的本机端口，
浏览器/客户端直接连 A 的端口即可，不需要把服务暴露到公网。

## 设计

```
TCP 客户端 ──connect──> [A: Bun.listen 127.0.0.1:5678]
                              │ 每条连接一条 LinkStream
                              │ openPayload {"type":"tcp","mapId":…,"host":…,"port":…}
                              ▼
                     PeerManager.getLink(B)（dc / ws-secure / relay 自动择优）
                              ▼
                      [B: acceptTcpStream] ──Bun.connect──> 127.0.0.1:12345
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
- 暂停 = 停监听 + 重置在途流，行保留；删除 = 暂停 + 删行。B 侧的放行行由浏览器自己删。

### 背压

泵（`apps/gateway/src/portmap/pump.ts`）不引入额外缓冲，直接把 TCP 背压与 mux 的信用额度接在一起：

- 远端 → 本地：`stream.readable` 的每一块都要等 `socket.write` 完全写入（部分写入则等 `drain`）
  才拉下一块。mux 只在应用读取时才回 `WINDOW` 额度，所以「不读」就是跨 mesh 的背压。
- 本地 → 远端：`socket.data` 拿到的数据入队后立刻 `socket.pause()`，`await stream.write` 完成再
  `resume()`。队列只在极短窗口内存在，超过 8 MiB 直接判定异常并断开。
- 拨号窗口（`getLink` + `openStream` 期间）不能 `pause`——Bun 的暂停会连 `close` 事件一起压住，
  客户端中途断开就发现不了。这段时间的数据存在 `early` 缓冲里，上限 1 MiB。

### 半关闭与中断

- 本地 FIN → `stream.end()`；对端 END → `socket.end()`；两侧的 RST/异常互相映射为
  `stream.reset()` / `socket.terminate()`。
- Bun 的 `socket.end()` 会连读半边一起关（`shutdown(true)` 实测不发 FIN，不可用），所以收到对端 END
  之后本地 socket 直接关闭；此时不再回 RST，按正常收尾处理。反方向（客户端先 FIN，服务端继续发数据）
  是完整的半关闭语义。
- 链路丢失不重放：字节流没有重放点，`stream.onAbort` 直接关本地 socket，由客户端自己重连。

## 接口

节点 A（node-session 鉴权，错误体统一为 `{ error: { code, message } }`，`code` 见
`packages/shared/src/contracts/portmap.ts` 的 `PortMapErrorCode`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/portmap` | 列表，含实时计数（`activeConnections`/`totalConnections`/`bytesIn`/`bytesOut`） |
| POST | `/api/portmap` | 创建；`mapId` 可指定以对齐 B 的放行行；409 `port_in_use` / `port_reserved` |
| PATCH | `/api/portmap/:id` | 改名 / 暂停 / 恢复 |
| DELETE | `/api/portmap/:id` | 删除，同时停监听 |
| GET | `/api/portmap/probe?host=&port=` | 本机端口占用探测（`free`/`reserved`/`usedByMapId`） |

节点 B：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/portmap/exports` | 放行列表 |
| POST | `/api/portmap/exports` | 建放行行，返回 `mapId` |
| DELETE | `/api/portmap/exports/:mapId` | 删放行行 |
| GET | `/api/portmap/target-probe?host=&port=` | 目标端口是否有服务在监听（1.5 s 超时） |

## 限制

- **每条映射并发连接上限 64**。mux 的 `MAX_LINK_UNACKED = 65 MiB`（65 个满窗）一旦被突破会关掉整条
  peer 链路——那条链路同时承载着终端会话。64 条并发流即使全部打满也还留有一个窗口的余量，超出的
  连接在 accept 时直接断开，不会牵连终端。单节点最多 64 条映射行。
- **中继模式的计费**：peer 链路走中继时，整条链路在中继侧只是**一条**流（内层还有一层 mux），
  端口映射的流量与终端流量混在一起，按租户配额限速与计量，不会额外占用 `maxStreams` 名额，
  但中继也无法区分二者。要做「按功能公平分配」只能在节点侧做。
- **链路升级不迁移**：长连接会把旧载体（如 relay）钉住，DC 升级只对新连接生效，符合 TCP 语义。
- `listen_host` 默认 `127.0.0.1`；填 `0.0.0.0` 等于把 B 的服务开放给 A 所在的局域网，需要使用者自己承担。
- 端口保留：网关端口与 `TMEX_PEER_PORT` 拒绝映射（`port_reserved`）。
