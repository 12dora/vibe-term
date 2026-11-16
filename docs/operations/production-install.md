# VibeTerm 部署指南

本文是单机生产部署手册：安装、服务与日志、HTTPS 反代、升级、SSH 设备、备份恢复与基础排障；面向部署 VibeTerm 的运维。生产安装走 GitHub Releases 的 `vibeterm-cli` 包（launchd / systemd 用户服务 / OpenRC + SQLite）。多机 mesh、登录、passkey / TOTP、直连与排障见 [mesh 运维](./mesh-operations.md)。Alpine musl 与 OpenRC 见下文专节。

VibeTerm 没有 JWT、管理员密码或 OIDC：standalone 无应用层登录；加入 mesh 后的身份是用户自持根钥。

## 环境要求

- **Bun**：1.3+（生产 runtime 与 CLI 鉴权命令）
- **tmux**：3.0+（本机设备）
- **macOS 或 Linux**（含 Alpine musl 的 x64 / arm64；Windows 不安装服务。直连 native addon 支持 glibc 与 musl，见运维指南平台表）

开发调试用仓库内 `bun run dev`，走 `development.env`，端口与生产 9883 错开。三套环境见 [三套环境](../development/environments.md)。**不要**用生产库或安装目录做开发。

## Alpine Linux（musl）

x64 与 arm64 的 Alpine / musl 主机可以安装、运行、升级与卸载。`install.sh` 缺 tmux / `libstdc++` 时只打印 hint，不失败。

前置（root 或加 `sudo`）：

```sh
apk add tmux libstdc++ libgcc
```

HTTP 客户端二选一：`apk add curl`，或使用 busybox 自带的 `wget`。走官方 musl zip 引导 Bun 时还需要 `unzip`（`apk add unzip`）。非 root 安装 OpenRC 服务需要 `sudo`。

**Bun 如何到位。** `install.sh` 在本机没有合格 Bun（≥ 1.3.0）时：同时有 `bash` 与 `curl` 则执行官方安装器 `curl -fsSL https://bun.sh/install | bash`，装到 `~/.bun/bin`；否则只在 Linux 上下官方 zip（`bun-linux-x64-musl.zip` / `bun-linux-aarch64-musl.zip`，x64 无 AVX2 时带 `-baseline`），对照同一 release 的 `SHASUMS256.txt` 校验后 `unzip` 进 `~/.bun/bin/bun`。缺 `unzip` 会硬失败并提示 `apk add unzip`。Darwin 没有 zip 引导，需自行提供 bash+curl。

## 生产安装（vibeterm-cli）

```sh
curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | sh
# 无 curl 时：
wget -qO- https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | sh
```

安装全程不提问，全部取默认值：角色 `standalone`（单机、无登录页）、监听 `127.0.0.1:9883`、peer 端口 `39001`、开机自启、服务名 `vibeterm`。默认的网关或 peer 端口被占用且未显式指定时，`init` 自动顺延到下一个空闲端口并打印一行说明。

无登录页的单机只接受 IP、`localhost` / `*.localhost`、本机 mDNS 名（`<主机名>.local`）或已配置域名作为 `Host`，其它域名回 421（防 DNS 重绑定）；用自定义域名访问前先把它填进站点 URL 或 `VIBETERM_BASE_URL`。规则见 [登录面安全 §10](../security/login-security.md)。

要改默认值，向 `install.sh` 追加 `init` 参数（交互与 `--no-interactive` 下一致，均为可选）：`--install-dir`、`--host`、`--port`、`--db-path`、`--autostart`、`--service-name`、`--role`、`--peer-port`、`--no-linger`。

要做公网中继入口，改角色即可：

```sh
sh install.sh --role relay --relay-public-url https://<中继域名>
```

或 `relay,node`（中继兼本机设备）。只有这两种角色才会追问公网 HTTPS 端口与中继公开地址，非交互时必须给 `--relay-public-url`。角色只能是 `standalone` | `node` | `relay` | `relay,node`。

默认装成 `standalone` 即可加入 mesh：之后 `vibeterm relay join …` 会自动把角色切为 `node` 并重启服务，安装时无需预先选角色。`vibeterm user add`、`vibeterm relay enroll` / `vibeterm relay join` 的完整步骤在运维指南。

本机已有安装（安装目录里存在 `install-meta.json` 或 `app.env`）时，再次执行 `install.sh` / `init` 会直接报错「已安装」并提示用 `vibeterm upgrade`；确需重装才加 `--force`（会删除整个安装目录）。

`init` 会：

- 写入安装目录（macOS `~/Library/Application Support/vibeterm/`，Linux `~/.local/share/vibeterm/`）；
- 生成 `app.env`（含 `VIBETERM_MASTER_KEY`、`VIBETERM_BIND_HOST`、`GATEWAY_PORT`、`DATABASE_URL` 及 mesh 相关键）；
- 部署 `runtime/server.js`、前端静态资源、drizzle 迁移；
- 写 `run.sh`（导出 `VIBETERM_FE_DIST_DIR` / `VIBETERM_MIGRATIONS_DIR` / `VIBETERM_NATIVE_DIR` 后 exec Bun）；
- 按探测结果安装 launchd plist、systemd 用户单元或 OpenRC init 脚本（`/etc/init.d/<服务名>`）。

安装树权限：`init` / `upgrade` apply 把安装根与 `data/`、`versions/`、`backups/`、`staging/` 收成 `0700`（已存在的目录也会 chmod）。目录若是符号链接，只在解析后的目标属于当前 uid 时 chmod 目标，否则告警并继续；`EPERM` / `EACCES` 同样告警、不阻断安装或升级。只有进程自己新建的目录失败才会让 `init` / `upgrade` 失败。`vibeterm.db` 及 `-wal`/`-shm`、备份副本、日志与 pid 文件为 `0600`（gateway 打开库之后也会再 chmod 一次）。不设 systemd `UMask` / launchd `Umask`，以免 tmux 窗格与 `exec` 子进程继承 077、把用户文件默默收成 `0600`/`0700`。

默认 HTTP：`127.0.0.1:9883`。本机浏览器打开该地址即可。需要局域网访问时再把 `app.env` 的 `VIBETERM_BIND_HOST` 改为 `0.0.0.0` 并重启，同时收紧防火墙。

`--no-interactive` 不要求任何参数；显式覆盖默认值的示例：

```bash
vibeterm init --no-interactive --host 0.0.0.0 --port 9884 --autostart false
```

另支持 `--lang en|zh-CN`、`--bun-path`。`init` 结束打印角色入站端口计划（`formatPortList`）与一行放行提示；`install.sh` 从 `init` stdout 解析该清单，不再写死 TURN 口。`doctor` 可检查安装（含端口计划、peer TCP 是否在听、有会话时 self 行 blocked 口）；`--fix` 尝试修复。

### 管道执行时的终端接管

`curl … | sh`（或 `wget … | sh`）下脚本自己的 fd 0 是管道，所以 `install.sh` 用子 shell `( : </dev/tty )` 探测控制终端，成功则把 `/dev/tty` 喂给 `init`，供缺少 tmux / bun 时的依赖安装确认与中继角色的追问使用；接不上就自动补 `--no-interactive`（依赖需 `--install-deps` 才会自动安装，中继角色必须由参数给全）。dash / ash 上失败的 `exec 3</dev/tty` 会直接退出整个非交互 shell，因此不能再用那种写法。

CLI 侧不读 `process.stdin`，而是每次提问自己打开 `/dev/tty`，答完即销毁该句柄。原因是 **Bun 在「被 shell 重新打开的 `/dev/tty`」这种描述符上永远收不到 `process.stdin` 数据**（Node 正常），沿用 `process.stdin` 会让一键安装卡死在第一个提问上——机器没装 Node ≥ 20 时 `install.sh` 正是用 Bun 跑 `init`。句柄必须销毁：留着不销毁会吊住事件循环，答完最后一问也退不出去。`stdin` 不是 TTY 时仍走 `process.stdin`，管道喂答案与非交互行为不变。

`init` 非零退出时 `install.sh` 会打印失败退出码并按原退出码退出，不再静默中断。

> 改名前（1.1.x，产品名 tmex）安装的实例在升到 2.0.0 时**由升级器整体迁移到新路径**：安装目录 `~/Library/Application Support/tmex/` → `.../vibeterm/`（Linux `~/.local/share/tmex/` → `~/.local/share/vibeterm/`），`data/tmex.db{,-wal,-shm}` → `data/vibeterm.db*`，`app.env` 的 `TMEX_*` 键改写为 `VIBETERM_*`（原文件备份进 `backups/`），服务名 `tmex` 改为 `vibeterm` 并显式卸载旧 label。用 `--install-dir` 指定过自定义目录的安装**不迁移**，只改服务与 env 键。迁移细节与回滚见 [改名迁移](./rename-migration.md)。

## 服务与日志

服务名默认 `vibeterm`：systemd 用户单元为 `vibeterm.service`，OpenRC 为 `/etc/init.d/vibeterm`，launchd label 为 `com.vibeterm.vibeterm`。改名前装的实例若用的是旧默认服务名 `tmex`，2.0.0 升级会改成 `vibeterm` 并先 bootout、删除旧的 `com.tmex.tmex.plist` / `tmex.service`；自定义服务名保持不变，只换 label 前缀为 `com.vibeterm.`。定义只在 `init` / `upgrade` 时渲染，已运行实例不会热更新 unit / plist / init 脚本。下面示例里的 `vibeterm.service` 按自己的服务名替换。

**Linux（systemd 用户单元）：**

```bash
systemctl --user status vibeterm.service -l --no-pager
journalctl --user -u vibeterm.service -n 200 --no-pager
journalctl --user -u vibeterm.service -f
```

unit 使用 `KillMode=process`，stop / restart / crash 只杀 VibeTerm 主进程，不连带 tmux。安装树与库文件的权限由上面的显式 `0700` / `0600` 负责，单元不设 `UMask`。开机自启（`--autostart true`，默认）时，`init` 与 `upgrade` 会为当前用户启用 linger（`loginctl enable-linger`），最后一个登录会话退出后服务与 tmux 不再随用户 slice 被拆除；已启用则不做任何改动。无权限或没有 `loginctl` 时只打印一行告警和手工命令 `sudo loginctl enable-linger <user>`，不影响安装。不希望改动账户级配置时，`init` / `upgrade` 加 `--no-linger`，选择记入 `install-meta.json`（`linger: false`），之后的升级沿用。macOS 不涉及。详见 [tmux 进程存活](./tmux-process-survival.md)。

**macOS（launchd）：** plist 含 `AbandonProcessGroup=true`，不含 `Umask`。用 `launchctl` 查看对应 job；标准输出进系统日志。

## OpenRC

Linux 上服务管理器探测顺序：可用的 systemd 用户管理器（`systemctl --user show-environment` 成功）→ 已引导的 OpenRC（存在 `/sbin/openrc-run` 或 PATH 上的 `openrc-run`，且 `/run/openrc/softlevel` 存在；若只有 `/run/openrc` 目录则再看 `rc-status --runlevel` 是否成功）→ `none`。装了 OpenRC 包但未经它引导（容器常见）时，`init` 报错并提示加 `--no-service`，由容器的进程管理负责运行，不会静默回退。

`init` 写入 `/etc/init.d/<服务名>`（默认 `vibeterm`），`command_user` 为安装用户，由 `supervise-daemon` 守护：`respawn_delay=3`、`respawn_max=0`（无限重拉，网页「重启」`process.exit(0)` 后约 3 秒拉回）；`rc_cgroup_cleanup=no` 且不加 `--stop-group`，stop / restart 只向 supervise-daemon 的子进程发信号，tmux 会话得以存活。日志落在 `<installDir>/vibeterm.log` 与 `vibeterm.err.log`（与 launchd 同路径）；init 在 `start_pre` 导出 `VIBETERM_LOG_FILE` / `VIBETERM_LOG_ERR_FILE`，gateway 进程内轮转（默认单文件 16 MiB、保留 3 代）。依赖写成 `want net` 而非 `need net`，避免无 net provider 的容器启动失败。

非 root 安装会提权一次（有 TTY 时先 `sudo -v`，之后 `sudo -n`）。无 TTY、没有 sudo 或被拒则失败，提示以 sudo 运行或加 `--no-service`。

非 root 还会写 `/etc/sudoers.d/vibeterm-<服务名>`（0440，先 `visudo -cf` 校验）：只放行 `rc-service <服务名> start|stop|restart|status`，`NOPASSWD`。网页升级没有 TTY，不能再交互输入密码，所以需要这条规则才能做到「只 sudo 一次」。已有等价规则则跳过；写入失败只告警、不阻断安装。卸载删除该文件。

没有用户级 systemd 时不可用：窗口内存限额、tmux cgroup 归位、`DefaultOOMPolicy=continue` drop-in。读数仍走进程树 RSS。见 [窗口内存](./window-memory-limits.md) 与 [tmux 进程存活](./tmux-process-survival.md)。

**状态与日志：**

```sh
rc-service vibeterm status
tail -n 200 ~/.local/share/vibeterm/vibeterm.log
tail -n 200 ~/.local/share/vibeterm/vibeterm.err.log
```

`rc-service … status` 与 `rc-update show default` 不需要 root。

健康检查（任意平台；mesh 下无会话只返回 `{status:'ok'}`）：

```bash
curl -sS http://127.0.0.1:9883/healthz
```

## HTTPS 与反向代理

生产建议在前面加 HTTPS（nginx、Caddy、Cloudflare Tunnel 均可）。Tunnel 指到 `127.0.0.1:9883` 时，必须在 `app.env` 设置 `VIBETERM_TRUST_PROXY=true` 并重启，否则 cookie 的 `Secure` 与 passkey origin 会按本机 HTTP 计算。客户端 IP 只读 `VIBETERM_CLIENT_IP_HEADER` 指定的一个头：Cloudflare Tunnel 设 `cf-connecting-ip`，nginx / Caddy 保持缺省 `x-forwarded-for`（取最右一项）。细节与 WebSocket 反代注意点见运维指南「Cloudflare Tunnel」一节。

不要再为「登录」配置 JWT 或 OIDC；应用层会话由各 node 签发的 `node-session` cookie 承担。

## 升级

终端：

```bash
vibeterm upgrade
```

或指定版本：`vibeterm upgrade --version 2.0.0`（也可 `VIBETERM_VERSION=2.0.0` 再跑 `install.sh`）。旧命令名 `tmex` 作为别名保留，`tmex upgrade` 等价。升级会停服务、部署新 runtime、只向 `app.env` **追加缺失键**、按需重下 native addon，再拉起服务。携带服务定义修复的那一次升级，其自身的 stop 仍按旧 kill 策略执行，可能掉一次 tmux。

CLI 安装且 `canSelfUpdate` 时，设置页「版本与更新」可在程序内升级。发版流程见 [发布流程](./release-process.md) 与 [自更新](./self-update.md)。

卸载：`vibeterm uninstall`；`--purge` 删除数据。

## SSH 设备配置

加入 mesh 之后，每台 node 内部仍是原来的 `local` / `ssh` 设备。在设备管理里添加 SSH 远程设备。主机、用户名与 ssh_config 别名在创建 / 修改与每次连接时校验：不得以 `-` 开头，不得含空白或控制字符；`_`、IPv6 字面量与 ssh_config 别名可用。OpenSSH argv 在目标前插入 `--`，避免目标被当成选项。

### 密码认证

1. 添加设备，类型选 SSH。
2. 填主机、端口、用户名。
3. 认证方式选密码并保存。密码由 `VIBETERM_MASTER_KEY` 加密落库。

### 私钥认证

```bash
ssh-keygen -t ed25519 -C "vibeterm"
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@remote-host
```

在 VibeTerm 中认证方式选私钥，粘贴 `~/.ssh/id_ed25519` 内容。

### SSH Agent

适用于开发机或密钥有口令的情况。确保 `ssh-agent` 已启动且 `ssh-add -l` 能列出钥匙；gateway 进程继承 `SSH_AUTH_SOCK`。launchd / systemd 用户服务默认不一定有 agent 套接字，需要时在服务环境里显式传入。

### SSH Config 引用

`~/.ssh/config` 已配置 `Host` 块时，认证方式选 SSH Config，引用填 Host 别名（如 `myserver`）。服务账户必须能读到该 config 与 `IdentityFile`。

## 备份与恢复

安装目录内需要一起备份：

- `data/vibeterm.db`（WAL 模式下含 `-wal` / `-shm`）
- `app.env`（尤其 `VIBETERM_MASTER_KEY`；库与 key 不匹配会启动失败，见 [排障](./troubleshooting-db-master-key.md)）

```bash
# 示例：Linux 默认路径，先停服务再拷
systemctl --user stop vibeterm.service   # OpenRC：rc-service vibeterm stop
cp -a ~/.local/share/vibeterm/data/vibeterm.db* ./backup/
cp ~/.local/share/vibeterm/app.env ./backup/
systemctl --user start vibeterm.service  # OpenRC：rc-service vibeterm start
```

恢复时必须同时放回对应的 `VIBETERM_MASTER_KEY`。不要把测试库拷进生产目录。mesh 节点身份在库内，只恢复单机库不会自动出现在其它入口，需保持各机备份一致或重新 `vibeterm relay join`。

## 故障排查

### 服务起不来

```bash
# Linux（systemd）
systemctl --user status vibeterm.service -l --no-pager
journalctl --user -u vibeterm.service -n 200 --no-pager

# Linux（OpenRC）
rc-service vibeterm status
tail -n 200 ~/.local/share/vibeterm/vibeterm.log
tail -n 200 ~/.local/share/vibeterm/vibeterm.err.log
```

核对 `app.env` 里生产契约键是否齐全：`VIBETERM_MASTER_KEY`、`GATEWAY_PORT`、`VIBETERM_BIND_HOST`、`DATABASE_URL`。`run.sh` 必须能找到 `VIBETERM_FE_DIST_DIR` 与 `VIBETERM_MIGRATIONS_DIR`。

### 打不开页面

1. 默认只绑 `127.0.0.1`，远程访问需要改 `VIBETERM_BIND_HOST` 或走 Tunnel。
2. 防火墙 / 安全组是否放行你实际暴露的端口（本机 9883 通常不必对公网开放）。
3. 反代是否升级 WebSocket（`/ws`、`/n/:id/ws`、`/mesh/ws`、`/relay/uplink`）。

### WebSocket 立刻断开

mesh 角色下无 cookie 的 `/ws` 会以 **4401** 关闭并跳登录页，这不是 JWT 过期。见运维指南排障表。standalone 无此守卫。

### SSH 连不上

在运行 VibeTerm 的同一用户下 `ssh -v user@host` 验证。核对密钥权限与 `SSH_AUTH_SOCK`。

### tmux 不可用

`tmux -V` 应 ≥ 3.0。服务 PATH 由 `run.sh` 补全；仍找不到时看 `install-meta.json` 的 bun / 依赖检测，或跑 `vibeterm doctor`。

登录、节点不可达、密钥日志分叉、直连降级等见运维指南，不要在本机生产目录里用手工改库的方式「修复」mesh 状态。

## 安全建议

1. 生产必须设置强随机 `VIBETERM_MASTER_KEY`，并与数据库一起备份。
2. 口令按 argon2id 成本假设可被离线爆破来选；独立第二因素用 passkey。
3. 对公网只暴露 HTTPS 反代；peer 口仅内网需要。
4. Cloudflare Tunnel 等场景打开 `VIBETERM_TRUST_PROXY` 并按代理设置 `VIBETERM_CLIENT_IP_HEADER`；网关端口不要让公网绕过反代直连。
5. 不要用 TCP 层转发（frp、`ssh -R`、socat 等不加 HTTP 头的方式）把网关端口暴露到公网：经它来的请求在网关看来就是本机，会免掉通行密钥与登录限流（见 [登录面安全](../security/login-security.md) §7）。确需如此时关闭 `exemptLocal`，并先在本机完成初始化。
6. 定期 `upgrade`；不要把生产 `app.env` 提交进 git。

## 参考

- [mesh 运维](./mesh-operations.md)
- [多节点架构](../architecture/mesh-architecture.md)
- [三套环境](../development/environments.md)
- [tmux](https://github.com/tmux/tmux/wiki)
- [Bun](https://bun.sh/docs)
