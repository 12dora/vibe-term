# tmex 部署指南

生产安装走 GitHub Releases 的 `tmex-cli` 包（launchd / systemd 用户服务 + SQLite），不要再用仓库里的 Docker Compose 或手写 JWT。多机 mesh、登录、passkey / TOTP、直连与排障见 [hub / node 运维指南](../hub/2026082800-hub-node-operations.md)。

历史上本文中的 `JWT_SECRET`、`TMEX_ADMIN_PASSWORD`、OIDC、以及「用 `.env` 密码登录」均已删除：standalone 无应用层登录；加入 hub 后的身份是用户自持根钥，而不是网关签发的 JWT。

## 环境要求

- **Bun**：1.3+（生产 runtime 与 CLI 鉴权命令）
- **tmux**：3.0+（本机设备）
- **macOS 或 Linux**（Windows 不安装服务；直连 native addon 另需 glibc，见运维指南平台表）

开发调试用仓库内 `bun run dev`，走 `development.env`，端口与生产 9883 错开。三套环境见 [三套环境](../env/2026061301-three-tier-env.md)。**不要**用生产库或 `~/Library/Application Support/tmex/` 做开发。

## 生产安装（tmex-cli）

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash
```

默认角色 `standalone`（单机、无登录页）。要做公网入口：

```bash
tmex init --role hub,node
```

随后 `hub user add`、`enroll`、各机 `hub join` 的完整步骤在运维指南。

`init` 会：

- 写入安装目录（macOS `~/Library/Application Support/tmex/`，Linux `~/.local/share/tmex/`）；
- 生成 `app.env`（含 `TMEX_MASTER_KEY`、`TMEX_BIND_HOST`、`GATEWAY_PORT`、`DATABASE_URL` 及 mesh 相关键）；
- 部署 `runtime/server.js`、前端静态资源、drizzle 迁移；
- 写 `run.sh`（导出 `TMEX_FE_DIST_DIR` / `TMEX_MIGRATIONS_DIR` / `TMEX_NATIVE_DIR` 后 exec Bun）；
- 按平台安装 launchd plist 或 systemd 用户单元。

默认 HTTP：`127.0.0.1:9883`。本机浏览器打开该地址即可。需要局域网访问时再把 `app.env` 的 `TMEX_BIND_HOST` 改为 `0.0.0.0` 并重启，同时收紧防火墙。

非交互示例：

```bash
tmex init --role standalone --no-interactive \
  --install-dir "$HOME/.local/share/tmex" \
  --host 127.0.0.1 --port 9883 \
  --db-path "$HOME/.local/share/tmex/data/tmex.db" \
  --autostart true
```

全局还支持 `--install-dir`、`--lang en|zh-CN`、`--bun-path`。`doctor` 可检查安装；`--fix` 尝试修复。

## 服务与日志

服务名默认 `tmex`。定义只在 `init` / `upgrade` 时渲染，已运行实例不会热更新 unit / plist。

**Linux（systemd 用户单元）：**

```bash
systemctl --user status tmex.service -l --no-pager
journalctl --user -u tmex.service -n 200 --no-pager
journalctl --user -u tmex.service -f
```

unit 使用 `KillMode=process`，stop / restart / crash 只杀 tmex 主进程，不连带 tmux。跨 logout 存活需自行 `loginctl enable-linger <user>`，安装程序不会代开。详见 [进程存活](../service/2026061400-process-survival.md)。

**macOS（launchd）：** plist 含 `AbandonProcessGroup=true`，语义同上。用 `launchctl` 查看对应 job；标准输出进系统日志。

健康检查（mesh 下无会话只返回 `{status:'ok'}`）：

```bash
curl -sS http://127.0.0.1:9883/healthz
```

## HTTPS 与反向代理

生产建议在前面加 HTTPS（nginx、Caddy、Cloudflare Tunnel 均可）。Tunnel 指到 `127.0.0.1:9883` 时，必须在 `app.env` 设置 `TMEX_TRUST_PROXY=true` 并重启，否则 cookie 的 `Secure` 与 passkey origin 会按本机 HTTP 计算。细节与 WebSocket 反代注意点见运维指南「Cloudflare Tunnel」一节。

不要再为「登录」配置 JWT 或 OIDC；应用层会话由各 node 签发的 `node-session` cookie 承担。

## 升级

终端：

```bash
tmex upgrade
```

或指定版本：`tmex upgrade --version 1.1.0`（也可 `TMEX_VERSION=1.1.0` 再跑 `install.sh`）。升级会停服务、部署新 runtime、只向 `app.env` **追加缺失键**、按需重下 native addon，再拉起服务。携带服务定义修复的那一次升级，其自身的 stop 仍按旧 kill 策略执行，可能掉一次 tmux。

CLI 安装且 `canSelfUpdate` 时，设置页「版本与更新」可在程序内升级。发版流程见 [CLI 发布](../release/2026041300-cli-release-process.md) 与 [自更新](../update/2026061406-self-update.md)。

卸载：`tmex uninstall`；`--purge` 删除数据。

## SSH 设备配置

加入 hub 之后，每台 node 内部仍是原来的 `local` / `ssh` 设备。在设备管理里添加 SSH 远程设备：

### 密码认证

1. 添加设备，类型选 SSH。
2. 填主机、端口、用户名。
3. 认证方式选密码并保存。密码由 `TMEX_MASTER_KEY` 加密落库。

### 私钥认证

```bash
ssh-keygen -t ed25519 -C "tmex"
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@remote-host
```

在 tmex 中认证方式选私钥，粘贴 `~/.ssh/id_ed25519` 内容。

### SSH Agent

适用于开发机或密钥有口令的情况。确保 `ssh-agent` 已启动且 `ssh-add -l` 能列出钥匙；gateway 进程继承 `SSH_AUTH_SOCK`。launchd / systemd 用户服务默认不一定有 agent 套接字，需要时在服务环境里显式传入。

### SSH Config 引用

`~/.ssh/config` 已配置 `Host` 块时，认证方式选 SSH Config，引用填 Host 别名（如 `myserver`）。服务账户必须能读到该 config 与 `IdentityFile`。

## 备份与恢复

安装目录内需要一起备份：

- `data/tmex.db`（WAL 模式下含 `-wal` / `-shm`）
- `app.env`（尤其 `TMEX_MASTER_KEY`；库与 key 不匹配会启动失败，见 [排障](../operations/2026021200-db-key-mismatch-journald.md)）

```bash
# 示例：Linux 默认路径，先停服务再拷
systemctl --user stop tmex.service
cp -a ~/.local/share/tmex/data/tmex.db* ./backup/
cp ~/.local/share/tmex/app.env ./backup/
systemctl --user start tmex.service
```

恢复时必须同时放回对应的 `TMEX_MASTER_KEY`。不要把测试库拷进生产目录。mesh 节点身份在库内，只恢复单机库不会自动出现在其它入口，需保持各机备份一致或重新 `hub join`。

## 故障排查

### 服务起不来

```bash
# Linux
systemctl --user status tmex.service -l --no-pager
journalctl --user -u tmex.service -n 200 --no-pager
```

核对 `app.env` 里生产契约键是否齐全：`TMEX_MASTER_KEY`、`GATEWAY_PORT`、`TMEX_BIND_HOST`、`DATABASE_URL`。`run.sh` 必须能找到 `TMEX_FE_DIST_DIR` 与 `TMEX_MIGRATIONS_DIR`。

### 打不开页面

1. 默认只绑 `127.0.0.1`，远程访问需要改 `TMEX_BIND_HOST` 或走 Tunnel。
2. 防火墙 / 安全组是否放行你实际暴露的端口（本机 9883 通常不必对公网开放）。
3. 反代是否升级 WebSocket（`/ws`、`/n/:id/ws`、`/mesh/ws`、`/hub/uplink`）。

### WebSocket 立刻断开

mesh 角色下无 cookie 的 `/ws` 会以 **4401** 关闭并跳登录页，这不是 JWT 过期。见运维指南排障表。standalone 无此守卫。

### SSH 连不上

在运行 tmex 的同一用户下 `ssh -v user@host` 验证。核对密钥权限与 `SSH_AUTH_SOCK`。

### tmux 不可用

`tmux -V` 应 ≥ 3.0。服务 PATH 由 `run.sh` 补全；仍找不到时看 `install-meta.json` 的 bun / 依赖检测，或跑 `tmex doctor`。

登录、节点不可达、密钥日志分叉、直连降级等见运维指南，不要在本机生产目录里用手工改库的方式「修复」mesh 状态。

## 安全建议

1. 生产必须设置强随机 `TMEX_MASTER_KEY`，并与数据库一起备份。
2. 口令按 argon2id 成本假设可被离线爆破来选；独立第二因素用 passkey。
3. 对公网只暴露 HTTPS 反代；peer 口仅内网需要。
4. Cloudflare Tunnel 等场景打开 `TMEX_TRUST_PROXY`，且反代不要把未校验的 `X-Forwarded-*` 传给不可信客户端后再绕过。
5. 定期 `upgrade`；不要把生产 `app.env` 提交进 git。

## 参考

- [hub / node 运维指南](../hub/2026082800-hub-node-operations.md)
- [架构设计](../hub/2026082700-hub-node-architecture.md)
- [三套环境](../env/2026061301-three-tier-env.md)
- [tmux](https://github.com/tmux/tmux/wiki)
- [Bun](https://bun.sh/docs)
