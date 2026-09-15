# 网关事件循环看门狗

本文说明网关主线程因 libdatachannel / libjuice 死锁永久卡住时的真因、进程内事件循环看门狗的设计与配置，以及「服务显示 running 但 HTTP 不通」的排查手册；面向 Linux / macOS / 容器上的安装版运维。

## 背景

安装版网关（`packages/app` runtime，`NODE_ENV=production`）的 HTTP、WebSocket、mesh / 中继控制面都跑在 Bun 主线程上。主线程一旦进入一次永不返回的同步 N-API 调用，进程不会崩溃、也不会退出：

- systemd `is-active` / launchd 仍报 running，`Restart=always` / `KeepAlive` 不会触发；
- 监听套接字还在，但 `accept` 停在主线程，listen backlog 打满后新连接排队、随后被拒；
- `/healthz` 与全部业务 HTTP 超时；
- 日志不再刷（`console.*` 也要主线程）；
- 现有 `EventLoopLagSampler`（`apps/gateway/src/ws/event-loop-lag.ts`）用主线程 `setTimeout` 采样，定时器本身无法到期，看不见这次卡住。

现网已出现过：中继节点（打包 runtime、Linux systemd `--user`）在上述状态下冻住数小时，对外表现为中继离线、`curl /healthz` 超时，而服务管理器认为一切正常。

产品侧的处置不是改 ICE 调用顺序（见下节：JS 避不开），而是用**进程内** Bun `Worker` 做事件循环看门狗：主线程停止心跳后由 Worker 发信号自杀，交给 systemd `Restart=always`（`RestartSec=3`）或 launchd `KeepAlive`（默认约 10 s 节流）拉起。不采用独立子进程（`KillMode=process` / `AbandonProcessGroup=true` 会把它漏掉），也不采用 systemd `WatchdogSec`（launchd 与 Docker 没有等价物）。开发入口 `apps/gateway/src/index.ts` 不接线；dev / test 默认关闭。

## 真因

死锁在 native 层，不在 JS。调用链从 ICE 状态回调进入：

`apps/gateway/src/mesh/rtc/rtc-peer-helpers.ts` 的 `attachPcDiagnostics` 在 `onIceStateChange` 收到 `connected` / `completed` 时调用 `pc.getSelectedCandidatePair()`（`noteSelected` → `logSelectedPair`）。这是同步 N-API：`PeerConnectionWrapper::getSelectedCandidatePair`（node-datachannel 0.33.1 → libdatachannel v0.24.3 → libjuice）。主线程在这次调用里永远等锁，成为死锁的旁观受害者。

libdatachannel 自己的两条线程构成 AB-BA：

| 线程 | 已持有 | 等待 |
| --- | --- | --- |
| libjuice poll | juice registry 互斥量，并正在跑 ICE 状态回调 → `PeerConnection::initDtlsTransport` → `DtlsTransport::start()` → `handleTimeout()` | `mSslMutex` |
| RTC worker | `DtlsTransport::doRecv()` 持有 `mSslMutex`，并在 `juice_send` → `agent_send` → `conn_lock`（TURN relay 路径会再锁 registry） | juice registry 互斥量 |

触发前提（三者同时）：

1. 本端是 **offerer**，即 DTLS **server** 角色；
2. ICE 选中的 pair 是 **TURN relay**；
3. 对端 `ClientHello` 已经排队，DTLS 在 `start()` 里走 `handleTimeout()` 而不是单纯等 I/O。

上游修复是未合入的 [libdatachannel PR #1630](https://github.com/paullouisageneau/libdatachannel/pull/1630)（一行：`handleTimeout()` 改为 `enqueueRecv()`）。**已发布的 node-datachannel 不含该修复**：0.33.4 / libdatachannel v0.24.5 同样没有。发行包当前钉的是 `node-datachannel@0.33.1`。

JS 侧无法绕开：状态回调里不读 selected pair，下一次任意 native 调用（关闭 PC、发信令、下一次 ICE 查询）仍会在主线程同步进同一把锁。根因要等上游发版或我们 vendor 打过补丁的构建。

## 看门狗设计

Worker 源码是**内联 JS 字符串**，经 `URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))` 交给 `new Worker(url)`。不另打 bundle、不新增 `run.sh` 环境变量。已在 Bun 1.3.14 上验证：主线程 `Bun.sleepSync(20000)` 会在超过阈值后被 Worker 杀掉（退出码 134）。

心跳用 `SharedArrayBuffer` + `Int32Array` + `Atomics`，不依赖 `postMessage`：

| 单元 | 含义 |
| --- | --- |
| 0 | 世代计数：启动时为 `1`（与未写入的 `0` 可区分），主线程每 1 s `Atomics.add(cells, 0, 1)`。Worker 用 `!==` 判断是否推进（i32 从 `2147483647` 回绕到 `-2147483648` 仍算一次变化）。不存 unix 秒 |
| 1 | 启动标志：`0` = 仍在启动（迁移 / native 装载 / mesh start），`1` = 已 `markStarted()` |
| 2 | 专用 wait 单元。Worker 用 `Atomics.wait(cells, 2, 0, 1000)` 睡眠；`stop()` 时主线程 `Atomics.notify` |

主线程每 1 s 把单元 0 加一，定时器 `.unref()`，不阻止进程退出。Worker 每次 `Atomics.wait` 返回后读单元 0：与上次 `seen` 不同则 `seen = cur; staleTicks = 0`，相同则 `staleTicks++`。`staleTicks >=` 当前阈值即击杀。决策路径不用 `Date.now()`，整机休眠 / `SIGSTOP` / 虚拟机暂停时两侧一起冻结，`staleTicks` 不增加；恢复后至多一拍陈旧，随后心跳推进并清零。单元 1 为 0 时用启动阈值（默认 180 s，覆盖升级后首次迁移），为 1 后用运行阈值（默认 30 s）。`stalledSec` 等于 Worker 观测到的陈旧秒数（即 `staleTicks`）。

接入点在 `packages/app/src/runtime/server.ts` 的 `main()`：

1. **在 `assembleVibeTerm` 之前**启动，覆盖 native 装载、迁移、mesh 启动阶段的挂死；
2. 打出 `[vibeterm] Service started on …`（中文 locale 为 `服务已启动：…`；preflight 同样）之后立刻 `markStarted()`；
3. 关机期间看门狗**保持武装**：`stopAll` 不调用 `watchdog.stop()`。优雅关机只要主线程还在跳心跳就不会误杀；若关机卡在 native（例如 `mesh.stop()` 关闭 PeerConnection 再次撞上同一把锁），正是需要击杀的场景。进程内重启路径没有 systemd `SIGTERM` / `TimeoutStopSec` 兜底。进程退出时 Worker 随主进程结束。

超时后 Worker 按固定顺序：

1. `console.error('[vibeterm][loop-watchdog] main thread stalled for <n>s (threshold <t>s, phase boot|running); sending <SIGNAL>')`。`<n>` 是 Worker 观测到的陈旧秒数（`staleTicks`）。`[vibeterm][…]` 前缀与 `server.ts` 的 fatal / uncaught 行一致，journald 与 darwin `*.err.log` 都能收到。Worker 的 `console.error` 直接写 fd 2，不经过主线程。
2. 若设置了 `VIBETERM_INSTALL_DIR`，向 `<installDir>/loop-watchdog.log` **追加一行 JSON**（`appendFileSync`，失败吞掉；**不要**复用 `upgrade.log`）：

   ```json
   {"ts":"2026-09-15T04:00:00.000Z","pid":1234,"version":"2.6.1","phase":"running","stalledSec":31,"thresholdSec":30,"signal":"SIGKILL","rssBytes":198000000,"uptimeSec":21600,"staleTicks":30}
   ```

   字段：`ts`、`pid`、`version`（主线程启动时用 `getDisplayVersion()` 捕获并经 init 消息传入，Worker 不能 import 该函数）、`phase`（`boot` | `running`）、`stalledSec`（Worker 观测到的陈旧秒数，等于 `staleTicks`）、`thresholdSec`、`signal`、`rssBytes`、`uptimeSec`、`staleTicks`。无墙钟心跳字段。
3. `process.kill(process.pid, signal)`。

信号默认所有平台均为 `SIGKILL`：Bun 会接管 `SIGABRT` 并打印一份误导性的「Bun has crashed」报告，Ubuntu 的 apport 也不会给非 deb 二进制留 core，SIGABRT 只留作有真实 core 处理器的主机显式选用（`VIBETERM_LOOP_WATCHDOG_SIGNAL=SIGABRT`）。随后 systemd 约 3 s、launchd 约 10 s 拉起新进程。自杀会丢掉数秒内的在途终端流，对端会自动重拨。

启动成功打一行（仅此一次）：

```text
[vibeterm][loop-watchdog] armed stall=30s boot=180s signal=SIGKILL
```

关闭时（默认 dev / test，或显式 `0` / `false`）**不打任何日志**。

## 配置项

四个键运行时直接读 `process.env`（布尔走 `parseBoolEnv`，整数走 `envInt`）。**`init` / `upgrade` 不写入** `app.env`；生产要改就手写后重启。完整环境模型见 [三套环境](../development/environments.md)。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VIBETERM_LOOP_WATCHDOG` | `NODE_ENV=production` 开；`development` / `test` 关 | 显式 `1` / `true` / `yes` 在任意环境打开；显式 `0` / `false` 在任意环境关闭 |
| `VIBETERM_LOOP_WATCHDOG_STALL_SEC` | `30`（最小 5） | 已 `markStarted()` 后的心跳超时。低于最小值回退默认 |
| `VIBETERM_LOOP_WATCHDOG_BOOT_SEC` | `180`（最小 10） | 启动到 `markStarted()` 前的心跳超时。低于最小值回退默认 |
| `VIBETERM_LOOP_WATCHDOG_SIGNAL` | `SIGKILL` | 超时后发给**本进程**的信号，仅 `SIGABRT` \| `SIGKILL` |

Docker / 独立 `run.sh` 路径无需额外接线：Worker 与主进程同命运，容器 / 服务管理器按原策略重启主进程即可。

## 排查手册：服务活着但不可达

### 从运维机上看到的

- `vibeterm relay list` 该中继离线；
- `curl https://<relay>/healthz` 超时（或经反代 502 / 504）。

### 在故障机上确认（先取证，再重启）

```bash
# 服务管理器仍认为在跑
systemctl --user status vibeterm          # active (running)
curl -sS --max-time 3 http://127.0.0.1:9883/healthz   # 超时

# listen backlog 打满：Recv-Q ≥ Send-Q（现网曾见 513/512）
ss -ltnp | grep 9883

# 主线程卡在 futex，而不是 epoll 等 I/O
# <pid> 取自 status / ss
cat /proc/<pid>/task/*/wchan
```

主线程的 `wchan` 若是 `futex_wait_queue`（或 `futex_wait`），而不是 `epoll_wait` / `io_uring`，再抓用户态栈。**重启前**安装 elfutils 并抓栈（或用 gdb）：

```bash
sudo apt-get install -y elfutils
sudo eu-stack -p <pid>
```

在栈里找这些帧即可定性为本死锁，而不是普通事件循环过载：

- `agent_get_selected_candidate_pair` / `PeerConnectionWrapper::getSelectedCandidatePair`
- `DtlsTransport::handleTimeout`
- `agent_send` / `juice_send` / `conn_lock`

### 恢复

Linux：

```bash
systemctl --user kill -s SIGKILL vibeterm && systemctl --user restart vibeterm
```

macOS（`KeepAlive` 会立刻拉起；`-k` 是先杀再启）：

```bash
launchctl kickstart -k gui/$UID/com.vibeterm.vibeterm
```

看门狗生效后，超过阈值应自行自杀并被拉起，不必每次手工 SIGKILL。手工路径留给看门狗未开、或阈值尚未到达的现场。

### 事后

```bash
journalctl --user -u vibeterm | grep loop-watchdog
# 期望：armed 行；卡死当时的 stalled 行；随后 Restart=always 的新进程 armed 行

# JSON 击杀记录（安装目录；macOS 为 ~/Library/Application Support/vibeterm/）
cat ~/.local/share/vibeterm/loop-watchdog.log

# 仅当显式设置 VIBETERM_LOOP_WATCHDOG_SIGNAL=SIGABRT 且主机配置了 core 处理器时
coredumpctl list
coredumpctl info <pid>
```

`vibeterm doctor`：服务在跑但本机 HTTP 无响应时 **FAIL**，检查项 id 为 `loop-stall`；若安装目录里有上次看门狗击杀记录则 **WARN** 并带上最后一行摘要。

## 验收

- 生产启动日志出现一行 `armed stall=…s boot=…s signal=SIGABRT|SIGKILL`；dev / test 或显式关闭时无看门狗日志。
- 主线程超过运行阈值无心跳：fd 2 出现 `main thread stalled … sending …`，`<installDir>/loop-watchdog.log` 多一行 JSON，进程被信号杀掉，服务管理器在数秒内拉起。
- 启动阶段（`markStarted()` 前）使用 boot 阈值，不会把升级后的慢迁移误杀。
- 关机期间看门狗保持武装；优雅关机继续心跳，native 卡死仍会在 stall 阈值后被杀。
- `vibeterm doctor` 在「服务 running + HTTP 无响应」时 FAIL `loop-stall`。

## 已知限制

- **根因仍在。** 在 node-datachannel 发布含 PR #1630 的版本（或本仓库 vendor 打过补丁的构建）之前，DTLS server + TURN + 已排队 ClientHello 仍会走进同一把锁。看门狗只是把「永久挂死」变成约 10–20 s 的一次重启。
- 阈值是误报与发现延迟的折中：同步工作（大迁移、偶发长时间 native 调用）超过 stall / boot 秒数会被杀掉；调大则卡死更久才恢复。
- 自杀会短暂丢掉在途终端流与 mesh 连接，对端重拨后恢复。业务 tmux 会话不受影响（`KillMode=process` / `AbandonProcessGroup`，见 [tmux 进程存活](./tmux-process-survival.md)）。
- 看门狗杀的是**本进程**。它看不见「主线程仍在跑、但卡在别的子系统」的软故障（例如健康检查仍 200、业务却停了）。

## 相关链接

- [已知问题 KI-17](../known-issues.md)
- [mesh 运维](./mesh-operations.md)（环境变量表与排障入口）
- [部署指南](./production-install.md)（服务与 `/healthz`）
- [tmux 进程存活](./tmux-process-survival.md)（`Restart=always` / `KeepAlive` 的 kill 范围）
- [三套环境](../development/environments.md)
- [libdatachannel PR #1630](https://github.com/paullouisageneau/libdatachannel/pull/1630)
