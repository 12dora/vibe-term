# 热路径性能优化（2026-08-27）

## 背景

一次针对全仓库热路径的性能审计发现：终端字节从 tmux 到浏览器的整条链路上，每一段都在做与「实际变化量」无关的全量工作——解析器逐字节 push 数组再整段复制、retention 每个分段全表扫描排序、canonical 帧尺寸用 Borsh 实编做二分探测、Ghostty 渲染桥每帧读满全屏 cell、history 每到一页重排整个终端。这些都不是算法选错，而是「按最坏情况一律付全价」。

本轮把这些位置改成按实际增量付费，并为每个改动留下可复跑的基准脚本。

## 目标与非目标

- 目标：降低 gateway 与前端在**持续输出**下的 CPU 与分配量；给关键热点留可复现基准；给内存无界增长的位置补硬上限。
- 非目标：不改 wire 协议语义、不改终端渲染的可观测字节流、不引入新的原生依赖。所有改动都先写特征化测试锁住既有行为，再改实现。

## 基准脚本

| 命令 / 路径 | 覆盖 |
| --- | --- |
| `bun run bench:parser`（`apps/gateway`） | pane VT 解析与 control-mode unescape 吞吐 |
| `bun run bench:retention`（`apps/gateway`） | retention `ingest()` 在不同 pane 数与分段大小下的耗时 |
| `bun run bench:frame-sizer`（`apps/gateway`） | canonical 帧尺寸计算与 `sendPaneData` |
| `packages/ghostty-terminal/bench/render-bridge.bench.ts` | 渲染桥 `updateRenderState + iterateRows + LineModel` |
| `packages/ghostty-terminal/bench/canvas.bench.mjs` | canvas 渲染器 run 批绘 |
| `apps/gateway/bench/control-output-pipeline.bench.ts` | 控制模式输出管线端到端 |
| `apps/gateway/bench/envelope-view.bench.ts` | mesh 中继只读 kind/seq 的 view 解码 |
| `packages/shared/bench/ws-wire-path.bench.ts` | 浏览器侧 canonical 帧解码 |
| `packages/panels/src/files/files-tree-render.bench.tsx` | 文件树 500 行 SSR |

bench 文件不是测试，`bun test` 不会发现它们，需手动跑。

## Gateway

### 1. Pane 解析器零拷贝

`unescapeControlModeData` 先 `indexOf(0x5c)`，**无反斜杠时直接返回 `subarray` view**，不再分配。`pane-stream-parser` 从「逐字节 switch + `number[]` push + 末尾整段复制」改为区间扫描写入可增长 `Uint8Array`：普通字节 run 用 `buf.set` 整段拷贝，只有控制序列进 handler；`findFirstOf2` 先用 `indexOf` 找主终止符再线性找次终止符，消除「找不到 BEL 就扫到 chunk 末尾」的 O(n²)；tmux passthrough 的结束回放从 `processByte` 递归改为入栈迭代。

1 MiB 输入：

| 输入 | BEFORE | AFTER | 加速 |
| --- | ---: | ---: | ---: |
| plain-ascii | 75.8 MB/s | 1639.6 MB/s | **21.6×** |
| ansi-heavy | 41.8 MB/s | 46.1 MB/s | 1.10× |
| osc-kitty-clipboard | 28.4 MB/s | 28.6 MB/s | 1.01× |
| tmux-passthrough | 34.1 MB/s | 38.5 MB/s | 1.13× |
| unescape（无转义） | 1382.5 MB/s | 40233 MB/s | **29.1×** |
| unescape（含转义） | 1146.0 MB/s | 1129.1 MB/s | 0.99× |

plain ASCII 是大块 `%output` 的主形态，收益集中在此。ANSI/OSC 密集输入仍必须逐序列检查（DEC 2031 / kitty / clipboard / OSC 133），memcpy 的赢面被控制序列密度吃掉——这是上限，不是遗留。

### 2. Retention 增量记账

`ingest()` 不再对所有 pane 做 `sweep()` 与 `Array.from + filter + sort`。全局 `retainedBytes` 随 append / trim / checkpoint / makeCold / epoch rotate / pane 删除增量维护；单次 ingest 只处理当前 pane 的 replay 字节上限与 TTL。全局 sweep 只在定时器、订阅变更（`refreshModes`）或 `retainedBytes` 越过 `maxRetentionBytes` 时运行。hot pane 用 Map 索引，`hot_limit` 只在 implicit 数量超额时排序；`retention_limit` 的最老 replay chunk 用懒 min-heap，不再每踢一条就全表 `filter + sort`。驱逐顺序由改动前写好的表征测试逐条锁定。

`bun run bench:retention`（每组 8000 次 ingest，µs/ingest）：

| pane 数 | 分段 | BEFORE | AFTER | 加速 |
| ---: | --- | ---: | ---: | ---: |
| 10 | 1 KiB | 2.77 | 1.03 | 2.7× |
| 10 | 16 KiB | 3.54 | 2.59 | 1.4× |
| 100 | 1 KiB | 8.57 | 0.62 | 14× |
| 100 | 16 KiB | 9.72 | 2.24 | 4.3× |
| 500 | 1 KiB | 36.44 | 0.64 | **57×** |
| 500 | 16 KiB | 35.91 | 2.00 | **18×** |

改前 per-ingest 随 pane 数线性增长；改后 1 KiB 路径与 pane 数无关，16 KiB 的剩余成本主要是 `copyBytes`。

语义上唯一的变化：其它 pane 的 replay TTL 不再在每次 ingest 时顺带清理，改由定时器 / 订阅变更 / 越过全局 cap 触发；定时器 deadline 补上了 `oldest replay + replayTtlMs`，避免 TTL 只能等到 grace/hot 边界才生效。

### 3. Canonical 帧精确尺寸

原来 `eventFits()` 每次完整 Borsh 序列化，`maxVariableDataBytes()` 用二分探测（1 MiB 上限约 20 次，每次新建 `Uint8Array`）。现在新增 `apps/gateway/src/ws/canonical/encoded-size.ts` 按 schema 直接算 payload 字节数（定宽字段 + `u32` 长度前缀 + option tag + enum tag + 16 字节 envelope），一次算出最大 data；按 `(eventKind, deviceId, paneId, serverEpoch 长度, paneEpoch 长度)` 缓存；已按 max 切好的 PaneData / ScreenChunk / HistoryChunk 走 `sendFitted()`，不再二次 `eventFits`。

| 路径 | cap | BEFORE hot | AFTER hot | fitChecks BEFORE → AFTER |
| --- | --- | ---: | ---: | --- |
| `maxPaneDataBytes` | 4 KiB | 357.49 µs | 872 ns | 12 → 0 |
| `maxPaneDataBytes` | 64 KiB | 1.82 ms | 227 ns | 16 → 0 |
| `maxPaneDataBytes` | 1 MiB | 5.52 ms | 254 ns | 20 → 0 |
| `sendPaneData` | 4 KiB | 219.31 µs | 4.40 µs | 14 → 0 |
| `sendPaneData` | 64 KiB | 2.02 ms | 11.49 µs | 19 → 0 |
| `sendPaneData` | 1 MiB | 5.42 ms | 10.88 µs | 23 → 0 |

即 sizing 约 400×–20,000×、`sendPaneData` 约 50×–500×，且计算结果（maxData）前后逐位一致，由 64 组随机 size-invariant 测试钉死。出站时仍需在 codec 编一次 envelope——那不属于 sizing。

### 4. 输出门控字节上限

选择切换的输出门控原先只限 1000 条、不限字节，卡住的 select 能堆到约 64 MiB/设备/连接。现在同时维护 `bufferBytes`，硬上限默认 **8 MiB**（`DEFAULT_OUTPUT_GATE_MAX_BYTES`，可经 `SessionStateStore({ maxOutputBufferBytes, maxOutputBufferFrames })` 配置）。超限（条数或字节）时清空缓冲、标记 `overflowed`、发既有的 canonical `SourceGap`（`reason = SOURCE_GAP_REASON_RESOURCE_EXHAUSTED`，`scope = Stream`），门控保持 `BUFFERING`，画面靠客户端收到 gap 后重新快照。条数溢出也从「静默丢最旧帧」改为同样走 gap——那条路径本来就已经造成缺口。

前端侧对应地把 history 门控整体抽成 `packages/ws-client/src/pane-history-gate.ts`，缓冲**完整帧**而非裸字节（默认 3000 ms / 2 MiB），修掉了原先回放时丢 `paneEpoch` / `seqStart` / `seqEnd` 的问题。

另外，`notificationThrottles` 补了 TTL prune（默认 30 s 一次），入站 WS 帧不再 `new Uint8Array(message)` 整帧复制——`decodeEnvelope` 走 zorsh `b.bytes()` 本就会把 payload 拷进新数组，不会把底层 buffer 留过回调。

### 5. DB 索引与 seq 分配

先用 `EXPLAIN QUERY PLAN` 验证再加索引，只加了两条（迁移 `drizzle/0018_agent_query_indexes.sql`）：

| 查询 | BEFORE | AFTER |
| --- | --- | --- |
| `agent_queued_messages WHERE session_id=? ORDER BY seq` | `SCAN` + `TEMP B-TREE FOR ORDER BY` | `SEARCH USING INDEX agent_queued_messages_session_seq_idx` |
| `agent_confirmations WHERE session_id=? AND status='pending' ORDER BY created_at` | `SCAN` + `TEMP B-TREE FOR ORDER BY` | `SEARCH USING INDEX agent_confirmations_session_status_created_at_idx` |

`appendAgentMessage` / `enqueueAgentMessage` 从「`max(seq)` + `INSERT` + `SELECT by id`」三趟同步语句收成一条 `INSERT … (SELECT COALESCE(MAX(seq), -1) + 1 …) RETURNING *`（用 `-1` 保持既有 0-based 语义）。另补了 `listWatchRulesWithState()`（单条 LEFT JOIN），调用方尚未切换。

## 前端

### 6. Ghostty 渲染桥

调研结论先行：**当前 wasm 构建没有任何 damage / row-version / 内容哈希导出**，`ghostty_render_state_get(state, 3)` 每帧恒返回 `full`，每行的 `row_dirty` 恒为 `1`——也就是说改动前 canvas 每帧都在全屏重画，`dirty === 'partial'` 分支从未被真实数据触发过。

因此行级 dirty 只能在「反正要读」的过程中顺带算出来：

- `bindings.view()` 缓存整块 `DataView`，按 `memory.buffer` 对象身份判失效（不能省——`ghostty_render_state_update` 帧内会 `memory.grow` 导致 detach）。
- 每个 render state 一块常驻暂存区，替代原先每次读取一对 `alloc/free`。
- 调色板/meta 按 `snapshotVersion` 跨帧缓存，颜色变更靠 784 字节 memcmp 判定，不再每帧重建 256 个 palette 对象。
- style 打包成整数键内插，颜色按 `(r<<16)|(g<<8)|b` 内插；cell 与整行在内容未变时复用上一帧对象，行内容全同则整行复用并把 `row.dirty` 置 `false`。
- 迭代结束后把内核恒报的 `full` 按实际变化行数降级为 `partial` / `clean`；首帧、resize、主题切换一律保持 `full`。
- Canvas 侧：选区层与光标层记住上次画过的矩形与颜色，未变则整帧不动笔；光标重画只 `clearRect` 上一格。颜色/字体缓存键从字符串改为打包整数与定长数组。

120×40，120 个计时帧（`updateRenderState + iterateRows + LineModel`，不含 canvas）：

| 场景 | BEFORE mean | AFTER mean | 提升 |
| --- | ---: | ---: | ---: |
| full update（40/40 行重写） | 6.75 ms | 1.37 ms | 4.9× |
| single dirty row（1/40） | 6.41 ms | 1.24 ms | 5.2× |
| 20% dirty rows（8/40） | 6.55 ms | 1.28 ms | 5.1× |

下游效果更关键：single dirty 场景每帧判脏行数 40.0/40 → **0.8/40**，20% 场景 40.0/40 → 8.0/40，`meta.dirty` 非 `full` 的帧数 0/120 → 120/120。主画布从「每帧重画 4800 个 cell」变成「每帧重画约 1–8 行」，这部分收益不在上表毫秒数里。每 cell 的 wasm 导出调用 24.82 → **8.97**（−64%），`bindings.view()` 17.76 → 7.82 且不再每次 `new DataView`。

### 7. History 分页单次写入

gateway 的 history 是**自新向旧回溯**（`lineStart` 逐页递减，行号 0 最老），终端只有 append 原语、无法向 scrollback 顶部插入，所以每页到达都必须 reset + 整屏重排——O(P²) 的字节量是分页方向决定的，不可消除（除非放弃「每页到达即刻可见」）。优化因此落在单次重排内部：新增 `buildCanonicalSnapshotPayload` 一次性拼出「清屏前缀 + 升序 history + 快照正文」，`writeCanonicalSnapshot` 从 `2P+2` 次 `terminal.write()` 降为**单次**；每页规范化字节用 `WeakMap` 缓存，`TextDecoder.decode` + 两次正则改写从每次重排重做变为每页只算一次。

64 页 × 128 KiB：

| 实现 | write 调用 | 交给终端的字节 | 耗时 |
| --- | ---: | ---: | ---: |
| legacy | 4288 | 263.4 MiB | ≈133 ms |
| batched | 64 | 263.4 MiB | ≈21 ms |

write 调用 −98.5%，CPU −84%（省掉的是 O(P²) 的 `TextDecoder` + 正则，剩下的是 O(P²) 的 memcpy）。字节流逐字节不变，由改动前写好的特征化测试锁死。

同时把 `applyHistoryPage` 的校验拆到 `terminal-history-validation.ts`，用判别联合把「结构性断链需重取首屏」（7 种 `recover`）与「容量到顶只停止分页」（2 种 `stop_paging`）在类型上分开，结构性判定优先于容量判定。

### 8. Shared 编解码

canonical `assertCanonicalEncoding()` 原先对 decoded 对象**重新序列化并逐字节比较**，改为用 reader 直接验证长度/枚举/canonical 约束：

| 载荷 | 校验 BEFORE | 校验 AFTER | 加速 |
| --- | ---: | ---: | ---: |
| PaneData 64 B | 2.53 µs | 0.36 µs | 6.9× |
| PaneData 4 KiB | 51.58 µs | 0.12 µs | 421× |
| PaneData 31 KiB | 355.61 µs | 0.12 µs | **2970×** |
| SetPaneSubscriptions ×16 | 22.91 µs | 1.76 µs | 13.0× |

即校验开销从「解码成本的 2–4 倍」降到「解码成本的 5%–25%」。

legacy metadata diff 从「全量 clone + 多次线性查找」改为「目标 window 直查 + 懒建全局索引」（中间结论：**每次 apply 都建全量索引比旧的全量克隆更慢**，P 个 Map 条目加 P 个位置对象的分配不比 P 次浅拷贝便宜）。40 windows × 16 panes / 10 upserts：19.36 µs → 4.89 µs（4.0×）。差分测试用 500 组随机快照 + 200 步连续 diff 对照参考实现逐字段比对。

### 9. React 订阅与缓存失效

- 侧栏设备树：`SideBarDeviceList` 不再订阅整张 `snapshots` 大表，改为按设备切片的 `useDeviceWindows` / `useDeviceOnline`；`DeviceRow` / `WindowRow` / `PaneRow` 全部 `React.memo`，handler 与 id 数组用 `useCallback` / `useMemo` 稳定引用。结果：设备 A 的 metadata patch 只让 A 的 `DeviceRow` 重渲染，A 内部只有被 diff 触碰的 window / pane 重渲染。
- 遗留：`device-tree-navigation.ts` 仍订阅整张 `snapshots`，根组件在任意 patch 上仍会重渲染（子行被 memo 挡住，代价从 O(全树) 降到 O(设备数)，未归零）。
- react-query 缓存失效：网关的 `KIND_SETTINGS_UPDATE` 此前只有 `site` 命名空间被消费，其余（llm / webhooks / telegram / weixin / devices / file-roots / terminal-shortcuts）跨端不失效。新增 `SettingsEventsInit` 把 10 个网关命名空间全量映射到对应 query key。
- Watch 规则列表去掉了逐行拉状态的 N+1（用 `getQueryCache()` 的 key 列表断言：列表渲染 3 条规则 → 新增 cache 条目 0）。

## Rust / WASM 移植评估

**结论：现在不做。** 依据是实测，不是偏好。

- 单次 wasm 导出调用约 **8.3 ns**；`get_multi(3 keys)` 为 23.5 ns，而 3 次 `single_get` 为 24.9 ns——把 3 次边界穿越合并成 1 次只省约 1 ns。**成本在 wasm 函数体内部的 key switch 分发与写回，不在 JS→wasm 的穿越本身。** 按每 cell 能合并掉 4 次调用算，全屏收益约 4800 × 5 ns ≈ 24 µs/帧，占 1.28 ms 的 2%。
- 因此「打包行 ABI」（一次调用把整行按定长 struct 写进调用方缓冲）的理论上限只有约 **2–2.5×**（1.28 ms → 约 0.5 ms），赢在彻底不做逐 key 分发，而不是少穿越。
- 代价是真实的：`vendor/ghostty` 是钉死 commit 的上游 submodule，`packages/ghostty-terminal/scripts/build-wasm.sh` 会强制校验 submodule HEAD 与超项目记录一致；加 ABI 意味着长期背一个 fork patch，并在每次跟进上游时 rebase + 重编 wasm。
- 同理，gateway 侧的 parser / canonical codec 也不移 napi-rs：JS zero-copy 改造后 plain ASCII 已到 1.6 GB/s，NAPI 单次传 4–64 KiB 才可能超过 2×，而按字节或按控制事件回调 JS 会把收益全吃掉；managed gateway 用 Bun `--compile`（已需 externalize `cpu-features`），再加多平台 native prebuild 的分发成本不划算。
- 1.28 ms/帧在 16.7 ms 预算里已不是瓶颈，真正的大头（每帧全屏 canvas 重绘）已被行级 dirty 判定拿掉。

**什么时候回头做**（满足其一即重新评估）：

1. **上游 ghostty 补上真正的 damage / dirty 追踪**——这是数量级改动，优先级最高。现在「哪一行变了」只能靠把整屏读出来逐 cell 比对，读取本身就是那 1.28 ms；有 damage API 就能整行跳过不读，空闲帧掉到几十微秒。若要向上游提 PR，提 damage API 的性价比远高于提打包行 ABI。
2. **视口显著变大**——240×80 约 19200 cell，按当前系数约 5 ms/帧，届时应动手。
3. **profile 显示 parser 稳定占 gateway CPU 20% 以上**，且 NAPI 原型 benchmark 实测超过 2×。

## 遗留与待确认

- **ghostty scrollback 容量存疑**：探针显示 `createTerminal(80, 24, max_scrollback)` 传 `10000 / 100000 / 1000000` 三个值，写入 20000 行后 `readScrollbar()` 结果**完全相同**（`{ total: 1153, offset: 1129, len: 24 }`），即实际保留恒为约 1129 行，与 `TERMINAL_SCROLLBACK = 10000` 无关。客户端 history 预算已顺势从 8 MiB / 64 页收到 `MAX_SURFACE_HISTORY_BYTES = 10_000 × 200`（约 1.9 MiB）/ `MAX_SURFACE_HISTORY_PAGES = 22`，对齐 `useTerminalBootSurface` 声明的 `TERMINAL_SCROLLBACK = 10000` 行——但**探针测到的实际保留量远低于该声明值**，若探针成立预算仍偏大，多缓存的分页写进去即被挤掉，且被挤掉的恰好是用户刚滚上去要看的最老内容。仓库内无 zig 源码，无法判定 `max_scrollback` 的单位与该构建是否忽略此字段，**只报告不下结论**，需由 ghostty-terminal 的 owner 验证。
- `listWatchRulesWithState()` 已就位但调用方（`watch/service.ts`、`api/watch.ts`）未切换。
- 出站仍会 Borsh 编码一次 envelope：要做到「编一次、sizing 与 send 共用 payload」，需在 `packages/shared` 暴露「只算长度」或「接受已编码 payload」的 helper。
- `DeviceConnectionAdapter` 的 `useMemo` 依赖整张连接态表，任一设备连接态变化会击穿所有 `DeviceRow` 的 memo——**故意保留**（连接态必须实时反映到每行，且变更频率远低于终端输出）。
