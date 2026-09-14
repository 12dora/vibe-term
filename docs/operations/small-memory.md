# 小内存主机的内存占用与调优

面向在 ≤ 2 GiB 内存的 NAS / VPS / 容器上运行 VibeTerm 的运维人员：说明 gateway 进程的常驻内存由什么构成、`VIBETERM_MEMORY_PROFILE` 两档各收紧了什么、按角色懒加载与分包的行为，以及如何在不碰生产实例的前提下复测。

## 背景

2.4.1 之前的 runtime 是一份静态 import 图打成的单文件 bundle：无论角色如何，启动即解析 AI SDK、gramio、weixin iLink、ssh2、ACME/x509、ghostty JS 绑定、Mesh / Relay runtime；ssh2 的 poly1305 WASM 在 import 时就分配 16 MiB 线性内存。实测空闲 standalone 进程 RSS 约 192 MB（堆 73 MB、ArrayBuffer 18 MB），带 mesh 与多设备的生产实例约 340 MB。回放、传输分片、直连 fanout 等缓冲上限也按工作站预算设定（每设备回放硬顶 64 MiB、传输分片 8 MiB × 16 并发写、fanout 待发 65 MiB）。

## 现状（2.4.2 起）

### 按角色懒加载与分包

`packages/app/scripts/build-runtime.ts` 以 `Bun.build({ splitting: true })` 产出 `runtime/server.js` + `runtime/chunks/*`。重量模块只在第一次用到时 `await import()`：

| 模块 | 首次加载点 |
|---|---|
| AI SDK / `@ai-sdk/*`、agent supervisor、watch | 首次 agent 运行 / watch 规则 / `resolveLanguageModel` |
| gramio / weixin iLink | 配置了 bot / 账号后的 `refresh()` |
| tunnel manager | 非 relay-only 的 live 启动 |
| ssh2（含 poly1305 WASM） | SSH 设备 `connect()` |
| ghostty JS 绑定 + wasm | 首次 `PaneEmulator.create` |
| MeshRuntime / RelayRuntime | 对应角色构造时 |
| ACME / x509 | 开启 TLS、签发或解析证书时 |

relay 单跑不再启动 agent / tunnel / push / watch / portmap / 即时通讯，仍保留 messaging hooks 与事件循环延迟采样（中继指标依赖）。

升级与 `deployRuntimeFiles` 整目录拷贝 `runtime/`（含 `chunks/` 与 `assets/ghostty-vt.wasm`）；包布局校验（`assertRuntimeBundle`）在 `server.js` 引用 `chunks/` 时要求安装树存在 `runtime/chunks/`。managed `bun build --compile` 二进制仍是单文件、模块已内联，不享受懒加载收益；小内存机请用 `run.sh` + ESM runtime。

首次使用某能力会多一次 import 延迟（数十到数百毫秒），换取空闲 RSS 下降。

### 内存档位

`VIBETERM_MEMORY_PROFILE=standard|small`；未设置时取 `min(os.totalmem(), process.constrainedMemory() || ∞) ≤ 2 GiB` 自动 `small`（cgroup 限内的容器也会落到 small），启动日志一行 `[memory] profile=…`。生产 `app.env` 不必写该键。

| 项 | standard | small |
|---|---:|---:|
| PaneRetention 每设备硬顶 | 64 MiB | 16 MiB |
| 每 pane 回放 / checkpoint / 热 pane 数 | 2 MiB / 512 KiB / 8 | 512 KiB / 256 KiB / 4 |
| emulator 池 | 32 | 8 |
| 传输分片 / 每会话并发写 | 8 MiB / 16 | 1 MiB / 4（`VIBETERM_TRANSFER_CHUNK_BYTES` 仍优先） |
| 直连 fanout 待发 | 65 MiB | 16 MiB |
| canonical 背压 hold | 2 MiB | 1 MiB |
| SQLite `cache_size` | 约 4 MiB | 约 2 MiB |

两档共同：SQLite `mmap_size=0`、`wal_autocheckpoint=500`；静态压缩内存 LRU 64 → 8 MiB（生产 fe-dist 自带 `.br/.gz` sidecar，几乎用不到）；输入命令窗口 pending 深度 ≤ 256 条（只卡已排队，单次粘贴按字节预算）/ 3 MiB（覆盖 1 MiB WS 帧粘贴的 hex argv）、控制口命令队列深度 ≤ 512（满则返回 `input_queue_full` / `control_queue_full`，不再无界堆积）；事件节流表 10 分钟过期清理；登录口令 Argon2id 仍是 64 MiB / 次（参数不能改，否则破坏已有哈希），但进程内串行，不会两笔叠成 128 MiB。

### 实测（空闲、单台本地设备、无浏览器，`process.memoryUsage`）

| 角色 | 2.4.1 整包 | 懒加载 + 分包 |
|---|---:|---:|
| standalone | RSS 192 / 堆 73 / ArrayBuffer 18 MB | RSS 153 / 堆 29 / ArrayBuffer 1 MB |
| node | 193 / 54 / 16 | 154 / 29 / 1 |
| relay | 178 / 53 / 16 | 105 / 17 / 0 |

small 与 standard 在空闲时几乎相同——档位收的是峰值上限，不是启动常驻块。

### 仍占空闲 RSS 的

- Bun 自身约 22 MB 与 bundle 源文本（ModuleRecord 约 10 MB）。
- push 在启动时对每个已登记设备拉起一条 `tmux -C`（每设备一条子进程 + 2 × 256 KiB 管道）；无浏览器时的响铃推送依赖这条连接。
- 生产实例额外的 mesh peer、RTC 原生库（`node-datachannel` 约 8 MiB 映射，仅直连启用时）、每个热 pane 的回放。

## 复测方法

用独立 tmux socket 与临时库起临时实例，绝不碰生产 `~/Library/Application Support/vibeterm/`、9883 端口、名为 `tmex` 的 session：

```bash
NODE_ENV=test VIBETERM_ROLES=node VIBETERM_TMUX_SOCKET=vibeterm-mem-x GATEWAY_PORT=19960 \
VIBETERM_PEER_PORT=39960 DATABASE_URL=/tmp/vt-mem/vibeterm.db VIBETERM_STUN_SERVERS=none \
VIBETERM_MASTER_KEY=<env/test.env 里的 key> VIBETERM_MIGRATIONS_DIR=apps/gateway/drizzle \
VIBETERM_FE_DIST_DIR=apps/fe/dist bun packages/app/dist/runtime/server.js
```

另开终端 `ps -o rss= -p <pid>`；中继角色可 `GET /api/relay/metrics` 读 `process.memory`。对比时同一入口、同一角色、各跑两次；差值小于 10 MB 视为噪音。

## 注意事项

- 不要为了省内存预读 `fe-dist`，当前本来就是按请求流式下发。
- 小内存档会让 `cache_evicted` 更常见、agent `read_screen` 更易 miss、传输吞吐下降；这是有意取舍。
- `VIBETERM_DIRECT_ENABLED=false` 可彻底避免加载 RTC 原生库。
