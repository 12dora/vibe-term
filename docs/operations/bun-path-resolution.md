# CLI 的 bun 路径解析

本文描述 `vibeterm-cli` 如何定位要用的 bun（优先级、`VIBETERM_BUN_PATH`、shell 输出净化、超时）以及 `run.sh` 的 PATH 与安全约束；面向改动 `packages/app/src/lib/bun.ts` 的开发者。

## 背景

`Bun check failed: Failed to execute bun --version`（带路径 `/opt/homebrew/bin/bun`）这类报错对应 `checkBunVersion()` 的 `bun.versionExecFailed` 分支，即 bun 已被检测到、失败在「执行该路径」。真因是 shell 探测的输出污染：`locateBunFromShell()` 用 `zsh -lic 'command -v bun'`，`-i`（交互式）会加载 `.zshrc`，prompt 框架 / instant-prompt / banner 会向 stdout 注入 ANSI 控制序列；`trim()` 去不掉中间的控制字符，返回的路径串夹带控制字符，`spawn()` 因字面路径不存在而 ENOENT。终端显示时控制序列（如 `ESC[2K\r`）让路径「看起来干净」。在 `locateBunFromShell()` 之后追加 homebrew 路径检查无效：污染值已先返回短路。

## 设计：bun 路径来源优先级

`checkBunVersion(minVersion?, { explicitPath?, metaBunPath? })` 按以下优先级解析，每个候选都过 `validateBunAt`（执行 `--version` + 版本比对）：

1. **显式** `--bun-path` flag / `VIBETERM_BUN_PATH` env —— 必须是「存在的绝对路径」，否则直接报 `explicitInvalid`，**不静默回退**。
2. **`process.execPath`**（仅当 `process.versions.bun` 存在，即 cli 被 bun 拉起，如自更新链路）—— 最权威。
3. **`meta.bunPath`**（init 持久化到 `install-meta.json`）。
4. **动态探测**：登录 shell 解析（`$SHELL` / zsh / bash 的 `-lic 'command -v bun'`，经净化 + 存在性校验）→ 当前进程 PATH 的裸 `bun`。
5. **硬编码常见安装路径**（`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/home/linuxbrew/.linuxbrew/bin`）—— **仅作 fallback**，动态探测全部失败时兜底。

核心思路：路径是**安装期一次性决策**，应持久化复用，而非每个命令现场探测；动态探测反映用户实际在用的 bun，硬编码只兜底。

### 输出净化 `sanitizeBunPath`

用码点判断（避免源码中出现不可见控制字符）剥离 ANSI CSI / OSC 转义与控制字符，按换行拆分后**优先返回最后一个绝对路径行**（应对 banner 出现在路径前/后的污染），否则返回最后一个非空行（如版本号）。

## 兼容性（现有用户）

升级本就会重写 `install-meta.json`，故 `bunPath` 只需纳入重写字段。`InstallMeta.bunPath` 声明为**可选**（旧 meta 无此字段，运行时为 `undefined`，由优先级链安全处理）。

- **网页自更新**：新 cli 被旧 gateway 用 bun 拉起 → `process.versions.bun` 存在 → #2 `process.execPath` 确定性命中正确 bun，**不依赖旧 meta、不依赖旧 gateway 改动**，结果写入重建的 meta。
- **手动 `vibeterm upgrade`**：execPath 为 node（#2 不命中）、旧 meta 无 bunPath（#3 不命中）→ #4 动态探测（已修健壮）→ 结果写入重建 meta。
- gateway 侧 `spawnUpgrade` 额外显式传 `--bun-path process.execPath`，对装新版后的后续升级生效（属显式加固，非兼容必需）。

## 非交互环境 / fail-fast

`runCommand` 新增 `timeoutMs`（超时 SIGKILL + reject）；`stdio: 'pipe'` 时 stdin 重定向 `/dev/null`。shell 探测带 5s 超时，确保 `zsh -lic` 这类交互式 shell 在无 TTY 的 CI / launchd / systemd 自更新场景**不挂起**，超时即继续 fallback。

## run.sh 健壮性与安全

- `writeRunScript` 写入的 `exec` 用 bun 绝对路径；PATH 显式补全：动态 `${HOME}/.bun/bin` 条件块 + `extraPathDirs`（bun 实际目录 + homebrew/usr-local/linuxbrew，去重并排除 `~/.bun/bin` 以免与条件块重复）。
- bunPath 校验：含 shell 元字符（`"` `` ` `` `$` `\` 换行回车）时抛 `unsafePath`，防止生成的 run.sh 被注入 / 语法损坏（DoS）。

## 受影响范围

- `packages/app/src/lib/bun.ts`（核心）、`lib/process.ts`（超时）、`lib/install.ts`（run.sh）、`types.ts`、`commands/{init,doctor,upgrade}.ts`、`i18n/index.ts`。
- `apps/gateway/src/system/{install-info,upgrade}.ts`（meta 形状 + 自更新显式传参）。
- 新增 `packages/app/src/lib/bun.test.ts`。

## 测试

`packages/app/src/lib/bun.test.ts` 覆盖污染净化、优先级链与显式路径校验（含相对路径拒绝）；`vibeterm doctor` 是端到端冒烟入口。
