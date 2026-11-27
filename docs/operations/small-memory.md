# 小内存主机的内存占用与调优

面向在 ≤ 2 GiB（含 256 MB Alpine 容器）内存的 NAS / VPS / 容器上运行 VibeTerm 的运维人员：说明 gateway 进程的常驻内存由什么构成、`VIBETERM_MEMORY_PROFILE` 两档各收紧了什么、启动路径懒加载与分包的行为，以及如何在不碰生产实例的前提下复测。

## 背景

2.4.1 之前的 runtime 是一份静态 import 图打成的单文件 bundle：无论角色如何，启动即解析 AI SDK、gramio、weixin iLink、ssh2、ACME/x509、ghostty JS 绑定、Mesh / Relay runtime；ssh2 的 poly1305 WASM 在 import 时就分配 16 MiB 线性内存。实测空闲 standalone 进程 RSS 约 192 MB（堆 73 MB、ArrayBuffer 18 MB），带 mesh 与多设备的生产实例约 340 MB。回放、传输分片、直连 fanout 等缓冲上限也按工作站预算设定（每设备回放硬顶 64 MiB、传输分片 8 MiB × 16 并发写、fanout 待发 65 MiB）。

## 现状

### 启动路径懒加载与分包

`packages/app/scripts/build-runtime.ts` 以 `Bun.build({ splitting: true })` 产出 `runtime/server.js` + `runtime/chunks/*`。重量模块只在第一次用到时 `await import()`。managed `bun build --compile` 二进制仍是单文件、模块已内联，不享受懒加载收益；小内存机请用 `run.sh` + ESM runtime。

Linux 上进程 RSS 拆成两类页：

- **file-backed**（`/proc/<pid>/status` 的 `RssFile`）：主要是 bun 二进制本身的映射，多进程可共享。
- **anon**（`RssAnon`）：启动时求值的 JS 代码页、堆、分配器驻留。

经验规则：**常驻内存 ≈ 启动时求值 JS 体积的 8–9 倍**（主要落在 anon）。多一条 eager import 会按这个倍数变成空闲 RSS；要压 256 MB 主机，先砍启动图，而不是调分配器。

| 模块 | 首次加载点 |
|---|---|
| WebAuthn（`@simplewebauthn/server` 及 ASN.1 / CBOR） | 首次通行密钥注册 / 断言 |
| X.509 / ASN.1（`@peculiar/x509`、asn1js、tsyringe、reflect-metadata） | 开启 TLS、签发或解析证书时；selfsigned / none 启动不解析证书 |
| Argon2（`hash-wasm`） | 派生根种子 / 口令哈希时（登录仍是 64 MiB / 次、进程内串行） |
| 服务端 i18n | 启动只带 en_US 服务端子树；zh_CN / ja_JP 在站点语言切换时按 locale `import()` |
| AI SDK / agent supervisor | 启动时已有 `running` / `waiting_confirmation` 会话，或首次写 agent 路由 |
| watch | 启动时已有启用规则，或首次 watch 路由 |
| tunnel manager | 启动时已有 `tunnel_config` / `tunnel_access` 行，或首次 `/api/tunnel` |
| telegram / weixin | 启动时已有启用 bot / 账号，或首次对应路由 |
| 端口映射 | 启动时已有 `port_maps` 行，或首次 portmap 路由 |
| 中继服务端 | 中继角色装配时；node / standalone 启动图不含 |
| setup 向导 | 首次 `/api/setup/*` |
| zod | 不在启动图；随 agent / watch 等子系统加载 |
| ssh2（含 poly1305 WASM） | SSH 设备 `connect()` |
| ghostty JS 绑定 + wasm | 首次 `PaneEmulator.create` |
| MeshRuntime | 对应角色构造时 |
| ACME | 开启 ACME 时 |

纯 relay 启动不拉起 agent / watch / tunnel / telegram / weixin / portmap。push 仍在 live 启动时拉起（未做「有推送渠道才启动」的门闩）。

升级与 `deployRuntimeFiles` 整目录拷贝 `runtime/`（含 `chunks/` 与 `assets/ghostty-vt.wasm`）；包布局校验（`assertRuntimeBundle`）在 `server.js` 引用 `chunks/` 时要求安装树存在 `runtime/chunks/`。

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

### 256 MB 主机

验收环境：Alpine 3.24 容器，`memory=256m`、无 swap，OpenRC 系统服务，musl 版 Bun 1.4。覆盖安装、终端大流量输出、300 MB 文件上传与下载、创建账号（Argon2id）、服务重启与网页重启，全程无 OOM。RSS 含约 46 MB 的 bun 二进制文件页（只读、可回收，与 JS 启动图无关），容量规划以 anon 为准。

| 场景 | gateway RSS / anon | 容器内存峰值 |
|---|---:|---:|
| 空闲（启动 30 秒后） | 83 / 36 MB | anon 37 MB |
| 终端连续输出约 50 MB | 116 MB | anon 77 MB |
| 上传 / 下载 300 MB 文件 | 141 MB | anon 99 MB（另有可回收页缓存） |
| `vibeterm user add`（CLI 子进程 Argon2id 64 MiB） | 116 MB | anon 186 MB |
| `vibeterm init` | — | anon 26 MB（CLI 进程约 70 MB） |

同条件下改造前的空闲读数为 RSS 108 / anon 63 MB；`init` 曾因原生库解包时 `Uint8Array.from` 逐字节复制峰值达 270 MB，在 256 MB 主机上被 OOM 终止。

注意事项：

- 真实 256 MB VPS 还要扣除内核与系统服务（通常 30–50 MB）。创建账号、改密码这类一次性操作峰值最高，建议预留 zram 或小 swap。
- 不要在启动路径新增大依赖的静态 import：常驻内存约为启动时求值 JS 体积的 6–9 倍，新代码请走按需加载并补 `packages/app/src/runtime/boot-graph.test.ts` 的守卫。
- 字节拷贝一律用 `new Uint8Array(src)`，不要用 `Uint8Array.from(src)`：后者在 JSC 上逐元素迭代，9 MB 拷贝额外占用约 166 MB、耗时约 700 ms。

### 仍占空闲 RSS 的

- bun 二进制的 file-backed 映射（Linux `RssFile`，数量级约数十 MB，随 bun 版本变）。
- 启动图求值后的 anon（代码页、JS 堆、分配器驻留）；经验倍数见上。新的 eager import 会按 8–9 倍变成常驻。
- push 在 live 启动时对每个已登记设备拉起一条 `tmux -C`（每设备一条子进程 + 2 × 256 KiB 管道）；无浏览器时的响铃推送依赖这条连接。
- 生产实例额外的 mesh peer、RTC 原生库（`node-datachannel` 映射，仅直连启用时）、每个热 pane 的回放。

## 复测方法

用独立 tmux socket 与临时库起临时实例，绝不碰生产 `~/Library/Application Support/vibeterm/`、9883 端口、名为 `tmex` 的 session：

```bash
NODE_ENV=test VIBETERM_ROLES=node VIBETERM_TMUX_SOCKET=vibeterm-mem-x GATEWAY_PORT=19960 \
VIBETERM_PEER_PORT=39960 DATABASE_URL=/tmp/vt-mem/vibeterm.db VIBETERM_STUN_SERVERS=none \
VIBETERM_MASTER_KEY=<env/test.env 里的 key> VIBETERM_MIGRATIONS_DIR=apps/gateway/drizzle \
VIBETERM_FE_DIST_DIR=apps/fe/dist bun packages/app/dist/runtime/server.js
```

另开终端 `ps -o rss= -p <pid>`；Linux 再拆 file / anon：

```bash
awk '/^(VmRSS|RssAnon|RssFile):/{print}' /proc/<pid>/status
```

中继角色可 `GET /api/relay/metrics` 读 `process.memory`。对比时同一入口、同一角色、各跑两次；差值小于 10 MB 视为噪音。

## 注意事项

- 不要为了省内存预读 `fe-dist`，当前本来就是按请求流式下发。
- 小内存档会让 `cache_evicted` 更常见、agent `read_screen` 更易 miss、传输吞吐下降；这是有意取舍。
- `VIBETERM_DIRECT_ENABLED=false` 可彻底避免加载 RTC 原生库。
