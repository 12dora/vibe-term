# tmex → VibeTerm 改名迁移（2.0.0）

本文是产品改名的迁移参考：命名表、永久冻结的协议常量、全网升级后可删除的兼容桥、升级事务内的安装目录迁移与回滚、升级手册；面向发版维护者与升级现网节点的运维。

## 背景

仓库 `12dora/tmex-enhanced`（`krhougs/tmex` 的 fork，已独立发行：GitHub Releases + `install.sh`）整体改名为 **VibeTerm**，仓库改名为 `12dora/vibe-term`。改名不是一次文本替换：现网的 1.1.x 节点靠**应用自身的升级流程**升到新版，而这条流程会硬校验发行资产名、包名与 `bin/tmex.js`；节点之间的密码学域串、mesh 头、cookie、tmux 选项名跨版本互通；安装目录、`app.env` 键与服务 label 都被旧版 `run.sh` 与 plist 引用。

2.0.0 是「改名完毕」的版本：安装布局与线上标识一次迁移到位，只保留一组明确定义、可在全网升级后删除的兼容桥。CLI 命令名变更属破坏性变更，因此主版本从 1.1.x 直接跳到 2.0.0。

## 命名表

| 场景 | 名称 |
| --- | --- |
| 品牌 / 显示名（三语不翻译） | `VibeTerm` |
| slug / 标识符 / 路径 / 存储 key | `vibeterm` |
| workspace scope / root package | `@vibeterm/*` / `vibeterm` |
| CLI 包名 / 命令 | `vibeterm-cli` / `vibeterm`（`bin/vibeterm.js`；保留 `tmex` shim 与 `bin/tmex.js` 别名） |
| 环境变量前缀 | `VIBETERM_*` |
| GitHub 仓库 | `12dora/vibe-term`（旧名由 GitHub 永久重定向） |
| 安装目录 | macOS `~/Library/Application Support/vibeterm`，Linux `~/.local/share/vibeterm` |
| launchd / systemd | `com.vibeterm.<服务名>` / `<服务名>.service`，默认服务名 `vibeterm` |
| DB / pid / log | `data/vibeterm.db`、`vibeterm.pid`、`vibeterm.log` |
| CSS 变量 / 类 | `--vibeterm-*`、`.vibeterm-*` |
| 浏览器持久化 key | `vibeterm-ui`、`vibeterm.site.language`、`vibeterm:*`、IndexedDB `vibeterm-auth` |
| 测试 harness | tmux socket `vibeterm-e2e*`、docker 项目 `vibeterm-e2e`、域名 `hub.vibeterm.test` / `entry.vibeterm.test`、容器内 `/opt/vibeterm`、`/var/lib/vibeterm` |
| 版本 | `2.0.0` |

## 冻结值（永久不改）

只有**签名 / HKDF 域串**是永久冻结的。它们已经进了持久化的 `user_key_log`、节点证书与已发布的签名文件；改一个字节，历史记录就验不过，等于让全网重置身份。

`tmex/delegation/v1`、`tmex/login/v1`、`tmex/enroll/v1`、`tmex/nodecert/v1`、`tmex/keylog/v1`、`tmex/peer/v1`、`tmex/hub-enroll/v1`、`tmex/uplink-auth/v1`、`tmex/relay-enroll/v1`、`tmex/redeem-pop/v1`、`tmex-sc/v1/`、`tmex-relay-wrap/v1`、`tmex-relay/`、`tmex-relay-pack/v1`、`tmex-totp`、`tmex-release-sig`。

代码里持有这些字面量的 TS 常量已改成 VibeTerm 命名，值不变，定义处带注释说明原因。

此外有两个非协议的历史名字保持原样：用户本机的生产 tmux 会话名 `tmex`（`devices.session` 里已有行的显式值，改它等于把用户的会话改名），以及维护者离线签名密钥的备份文件名。

`devices.session` 的**列默认值**由一条新的 drizzle 迁移改为 `vibeterm`，运行时空值回退同步改为 `vibeterm`——已有行都带显式值，因此只影响新建设备。历史迁移文件与 drizzle 快照不可变，不回改。

## 兼容桥（全网升级到 ≥ 2.0 后删除）

### 1. 发行资产 `tmex-cli-<v>.tgz`

≤ 1.1.40 的节点自升级时按旧资产名拼 URL、按旧文件名在 `SHA256SUMS` 里找摘要、解包后断言 `package.json.name === 'tmex-cli'` 且 `bin/tmex.js` 存在。因此 CI 在 `npm pack` 产出 `vibeterm-cli-<v>.tgz` 之后，用 `scripts/release/build-legacy-asset.ts` 解包、把 `package.json.name` 改回 `tmex-cli`、重打成 `tmex-cli-<v>.tgz`；两个资产写进同一份 `SHA256SUMS`，由同一把 `r1` 私钥签一次。新代码读侧同时接受两种资产名与包名，hub 向旧节点推包时选旧资产名。详见 [发布流程](./release-process.md#兼容资产-tmex-cli-versiontgz)。

### 2. 环境变量别名

`packages/shared/src/env/load-env.ts` 的 `applyLegacyEnvAliases()` 在启动时把残留的 `TMEX_X` 复制到未设置的 `VIBETERM_X`；`mergeMissingEnvFileKeys` 把 `TMEX_X` 视为 `VIBETERM_X` 已存在，不会重复追加。迁移后的 `app.env` 已经是 `VIBETERM_*`，这条别名只覆盖「未迁移」与「回滚到旧 env」两种场景。新 `run.sh` 只导出 `VIBETERM_*`；事务在停服前把旧 `run.sh` 备份到 `backups/<txn>/run.sh`，回滚 / repair 时原样还原，旧 runtime 因此仍能读到 `TMEX_*` 路径变量。自定义 `--install-dir` 的安装不搬目录，但同样在事务内把 `app.env` 的 `TMEX_*` 键改写为 `VIBETERM_*`（有备份、可回退）；`readEnvFile` 读取时也做同样别名，CLI 各命令在迁移前就能读到新键。

### 3. 安装识别与双 shim

`INSTALL_MARKER` 新旧都认；pid 文件读 `vibeterm.pid` 回退 `tmex.pid`；`locatePackageRoot` 接受 `vibeterm-cli|vibeterm|tmex-cli|tmex` 四种包名与 bin 名；shim 标记新旧都认（`LEGACY_SHIM_MARKER`），安装 `vibeterm` 与 `tmex` 两个 shim，内容一致。

### 4. 线上标识双发双读

- **HTTP 头**：正式名 `x-vibeterm-*`，旧名 `x-tmex-*` 同时发送；读取新名优先、回退旧名；转发规则与 uplink 帧白名单两种前缀都认。唯一定义处是 `packages/shared/src/http/mesh-headers.ts` 的 `HeaderNamePair`。
- **Cookie**：签发时同时设 `vibeterm_s_*` / `vibeterm_sh_*` 与 `tmex_s_*` / `tmex_sh_*`，读取新名优先，清除时两者都清，peer 合成转发同样双发。
- **单字段值**（`tmex-close:`、`tmex-rtc-wake`）：发新名、读两种。混合版本期旧节点对这两个信号退化为「通用关闭」与「不唤醒直连」，全网升级后消失。

### 5. tmux 选项迁移

`@vibeterm-server-epoch`、`@vibeterm_2031`、`vibeterm-cwd:` / `vibeterm-command:`、`vibeterm-hb`、`vibeterm-park`。tmux server 在升级期间不重启，所以 attach 时若**旧选项存在而新选项不存在**，就复制到新名再删旧值；`tmex-park` 窗口一并 rename。不做这一步会导致 epoch 错配（误判 server 重启）与 TUI 主题订阅状态丢失。

### 6. Cloudflare Access

读侧接受 `tmex-allow|vibeterm-allow`、`tmex-bypass*|vibeterm-bypass*`、app 名 `tmex|VibeTerm`；新建一律用新名。

### 7. 前端持久化

localStorage / sessionStorage 一次性 `getItem(old) → setItem(new) → removeItem(old)`（含 `main.tsx` 里防 FOUC 的裸读）；IndexedDB `tmex-auth` → `vibeterm-auth` copy-forward，失败则退化为重新登录。PWA 图标用新文件名，旧文件名保留一版。

## 安装迁移

由 `packages/app/src/lib/upgrade-migrate-dir.ts` 实现，跑在升级事务内部。

**触发条件很窄**：`installDir` 恰好等于当前平台的旧默认路径（`~/Library/Application Support/tmex` / `~/.local/share/tmex`），且新默认路径尚不存在。用 `--install-dir` 指定过自定义目录的安装**永远不搬家**，只做服务 relabel 与 env 键改写。

**时序**：preflight 通过 → 停旧服务 → **迁移** → 切换 `current` → 装服务 → 健康检查。整目录 `rename` 是同卷原子操作，之后所有路径按新目录重新推导。

**迁移内容**：

1. 目录 `~/Library/Application Support/tmex` → `.../vibeterm`（Linux 同理）。
2. `app.env`：原文件先备份到 `<新目录>/backups/app.env.<txnId>`（0600），再把 `TMEX_X` 键改写为 `VIBETERM_X`，并把指向旧目录的值重写到新目录；旧键改名后与已有新键冲突时以已有新键为准。
3. DB：`data/tmex.db{,-wal,-shm}` → `data/vibeterm.db*`，同步改写 `DATABASE_URL`。只处理安装目录 `data/` 下的库，`DATABASE_URL` 指向别处时不动。
4. 服务：服务名若为旧默认 `tmex` 则改为 `vibeterm`（label `com.vibeterm.vibeterm`、单元 `vibeterm.service`）；自定义服务名保留，只换 label 前缀。装新服务之前显式 bootout 旧 label 并删除 `com.tmex.<服务名>.plist` / `tmex.service`（存在才做），避免两个实例抢 9883。
5. `run.sh`、shim、plist / unit、`install-meta.json` 一律按新路径与新服务名重写。

**journal 与回滚**：升级日志新增 `migrate-install-dir` 阶段。迁移记录（新旧路径、新旧服务名、env 备份路径、DB 是否已改名）在目录 rename **之前**先写入 journal，之后每一步完成再更新，所以任意时刻崩溃都能由 `upgrade --repair` 按记录续做或回退。健康检查失败时先确认新服务的进程已退出（launchd job 卸载 + pid 消失为硬条件，端口释放只等待 5 秒后告警继续），再写入 `reverting` 阶段并反向执行：目录搬回旧路径、按备份还原 `app.env`、DB 文件名改回、旧 `run.sh` 原样还原、旧 label 重新装上；记录标记为 `undone`，直到旧版本切回并通过健康检查才清除。恢复的目标版本低于 2.0 时一律使用旧 label 与旧日志文件名（无论是否发生过迁移），2.x 之间的失败回滚保持新 label。停止新服务失败时不动目录与 DB，保留 journal 交给 `--repair`。

## 运维手册：升级一片 1.1.x 的节点

1. **先升 hub / 入口**。入口向节点推包时要能选旧资产名，旧入口推给新节点会因缺清单而在装包一步被拒。
2. 逐台升级：终端 `vibeterm upgrade`，或设置页「版本与更新」，或从入口批量推包。命令别名 `tmex upgrade` 等价。
3. 每台升完核对：
   - `vibeterm doctor` 通过；`curl -sS http://127.0.0.1:9883/healthz` 返回 `ok`；
   - macOS：`launchctl list | grep vibeterm` 只剩 `com.vibeterm.<服务名>`，`~/Library/LaunchAgents/` 下没有 `com.tmex.*.plist` 残留；
   - Linux：`systemctl --user status <服务名>.service` 为 running，旧 `tmex.service` 已消失；
   - 安装目录已在 `.../vibeterm/`，`data/vibeterm.db` 存在，`app.env` 的键全是 `VIBETERM_*`，`backups/app.env.<txnId>` 有备份；
   - 页面品牌显示 VibeTerm，登录 / passkey / TOTP / 主题 / 布局设置均未丢。
4. 全网升完之后，用 `vibeterm hub list` 与中继租户列表逐台核对版本 ≥ 2.0.0，再考虑拆桥。
5. **拆桥**（后续版本，一次一项，各自发一版观察）：删 `build-legacy-asset.ts` 与 workflow 里的兼容资产步骤 → 删旧头 / 旧 cookie 的发送侧、再删读取侧 → 删 `applyLegacyEnvAliases()` 与 `run.sh` 的 `TMEX_*` 导出 → 删旧安装目录识别、旧 shim 标记与 `bin/tmex.js`。签名 / HKDF 域串永远不动。

## 已知限制

- **迁移后不支持降回 1.x**：旧 CLI 只认旧目录、旧 label 与 `TMEX_*` 键，手工降级会得到一个找不到自己数据的实例。需要回退时只能走升级事务自身的 rollback / `--repair`（那条路径仍然安全：旧 `run.sh` 有事务备份并原样还原）。
- **自定义安装目录不迁移**。目录名保持原样，只改服务 label 与 `app.env` 键。想改目录名只能停服务后手工搬并同步改 `install-meta.json`、`run.sh`、plist / unit，不推荐。
- **混合版本期的功能降级**：未升级的节点收不到 `tmex-close:` 的精确关闭原因，也不会被 `tmex-rtc-wake` 唤起直连，表现为关闭提示变笼统、直连建立更慢。全网升级后自愈。
- **tmux 选项迁移只在 attach 时发生**。升级后从未被访问过的 pane 保留旧选项，直到下一次 attach。
- **`SHA256SUMS` 两行期间**，任何手工核对摘要的脚本都要按文件名取行，不能假设只有一行。
