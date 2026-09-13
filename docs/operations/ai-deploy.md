# AI 助手部署指南

本文面向 AI 助手与运维，按场景给出可直接执行的部署步骤。部署各节结构固定：适用场景 → 需要向用户确认的信息 → 步骤 → 验收 → 常见问题；末尾另有「用 CLI 调试别的节点」与排障速查。命令里的 `<...>` 是占位符，执行前必须替换成用户给的真实值。

## 通用须知

### 前置条件

- **操作系统**：macOS 或 Linux。`install.sh` 检测到其它系统直接退出；Windows 不安装服务。
- **Bun ≥ 1.3.0**：不需要用户预装，`install.sh` 检测不到或版本过低时会自动执行 `curl -fsSL https://bun.sh/install | bash`，装到 `~/.bun/bin`。
- **tmux ≥ 3.0**：本机要跑终端就必须有；`--role relay`（纯中继）跳过该检查。缺失时 `init` 会给出安装计划，非交互模式加 `--install-deps` 才会自动装。
- **curl 与 tar**：`install.sh` 硬依赖，缺失即退出。
- 出网能访问 GitHub Releases（下载 `vibeterm-cli-<版本>.tgz` 与 `SHA256SUMS`，校验不通过即中止）。

### 安装命令

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
```

`install.sh` 后面追加的参数会原样传给 `vibeterm init`，例如 `bash install.sh --role hub,node`。管道执行时脚本会尝试接管 `/dev/tty` 来提问；接不上就自动补 `--no-interactive`，此时所有必填项都得由参数给出。固定版本用 `VIBETERM_VERSION=<版本> bash install.sh`。

CLI 落在 `~/.local/bin/vibeterm`（`tmex` 为等价别名）。该目录不在 `PATH` 时脚本会打印提示，需要 `export PATH="$HOME/.local/bin:$PATH"`。

### 安装目录与 `app.env`

| 平台 | 安装目录 |
| --- | --- |
| macOS | `~/Library/Application Support/vibeterm/` |
| Linux | `~/.local/share/vibeterm/` |

配置文件是安装目录下的 `app.env`。`init` 写入这些键，`upgrade` **只追加缺失键、不覆盖已有值**：

`NODE_ENV`、`VIBETERM_BIND_HOST`、`GATEWAY_PORT`、`DATABASE_URL`、`VIBETERM_MASTER_KEY`、`VIBETERM_BASE_URL`、`VIBETERM_SITE_NAME`、`VIBETERM_DIRECT_ENABLED`、`VIBETERM_ROLES`、`VIBETERM_HUB_URL`、`VIBETERM_HUB_PUBLIC_URL`、`VIBETERM_PEER_PORT`；`relay` / `relay,node` 角色另加 `VIBETERM_RELAY_PUBLIC_URL` 与 `VIBETERM_RELAY_ADMIN_TOKEN`。

`VIBETERM_STUN_SERVERS` 自 2.2.0 起 **`init` 不再写入**：未设置即使用随发行版分发的内置列表，升级自动换新；只有 `init --stun-servers <list>`（或 `none` 禁用）才写进 `app.env`。`upgrade` 还会把历史装机时冻结的默认串删掉。语义见 [mesh 运维](./mesh-operations.md)。

`VIBETERM_TRUST_PROXY` **不会**被 `init` 写入，需要时手改 `app.env`（或在设置页的远程访问向导里拨开关，它会写回 `app.env`）。改完任何键都要重启服务才生效。

中继角色的内置 TURN 凭据自动生成并落库。监听默认：`VIBETERM_TURN_PORT=40000`、`VIBETERM_TURN_RELAY_PORT_RANGE=40001-40049`、`VIBETERM_TURN_BIND_HOST=auto`（主出站 IPv4）；`VIBETERM_TURN_EXTERNAL_IP` / `VIBETERM_TURN_HOST` 只在要改默认值时手加。`init` 按角色写入 RTC / TURN 键；跨版本 `upgrade` 把空值与旧默认（`3478` / `49160-49259` / 中继主机 `40000-40099`）改写到统一段，自定义值不动。

默认端口单一来源 `@vibeterm/shared/net`：HTTP `9883`（绑 `127.0.0.1`）、node↔node 信令 `39001/tcp`、ICE UDP 非中继 `40000-40099` / 中继主机 `40050-40099`、TURN 控制 `40000` + 分配 `40001-40049`、内置 HTTPS 监听器 `9443`。全部 UDP 落在 40000-40099。`init` 结束打印角色 `formatPortList`。

`VIBETERM_MASTER_KEY` 与数据库 `data/vibeterm.db` 必须成对备份，丢了 key 就打不开库。

### 角色

`VIBETERM_ROLES` 只能取五个值之一：`standalone`（默认，单机无登录）、`node`（已加入 Hub 或中继的设备）、`hub,node`（公网入口兼本机设备）、`relay`（纯中继，无前端）、`relay,node`（中继兼本机设备）。`hub` 与 `relay` 不能同机。

### `vibeterm doctor`

```bash
vibeterm doctor
vibeterm doctor --json
vibeterm doctor --fix
```

检查 Bun / tmux / ssh / 平台 / 安装目录 / `app.env` 必填键 / 数据库 / 端口 / 通行密钥 origin / 服务状态 / `/healthz` / 旧版布局。`--json` 输出结构化结果，适合 AI 解析；`--fix` 尝试自动修复能修的项。

### 服务重启

服务名默认 `vibeterm`。

```bash
# Linux（systemd 用户单元）
systemctl --user restart vibeterm
systemctl --user status vibeterm -l --no-pager
journalctl --user -u vibeterm -n 200 --no-pager

# macOS（launchd）
launchctl kickstart -k gui/$(id -u)/com.vibeterm.vibeterm
launchctl print gui/$(id -u)/com.vibeterm.vibeterm
```

### AI 执行时的注意事项

1. **先问清再动手**。每节的「需要向用户确认的信息」列全了，缺任何一项都不要猜默认值往下走，尤其是域名、公网端口、密码。
2. **密码类命令在非 TTY 下用环境变量**。`hub user add` / `hub user passwd` / `hub user totp` / `mesh reset-root` / `enroll` / `hub join --password` / `relay join` 读 `VIBETERM_PASSWORD`（`hub user passwd` 的旧密码读 `VIBETERM_PASSWORD_OLD`，`hub join` 的两步验证码读 `VIBETERM_TOTP`）；中继口令相关的 `relay enroll` / `relay reauth` / `relay passwd` 读 `VIBETERM_RELAY_PASSWORD`。需要二次确认的场景可另设 `<变量名>_CONFIRM`，设了就必须与主变量一致。空密码一律被拒。
   ```bash
   VIBETERM_PASSWORD='<密码>' vibeterm hub user add <用户名>
   ```
   把密码写进命令行会进 shell 历史，优先让用户自己在交互终端执行，或用只对单条命令生效的前置赋值。
3. **破坏性命令必须先取得用户确认**。`hub user passwd --full-reset`、`mesh reset-root`、`mesh reset-identity`、`tls reset`、`hub ca rotate`、`hub user reset`、`relay remove`、`relay passwd --kick`、`uninstall --purge` 都会造成不可逆后果（掉全部会话、清通行密钥与两步验证、全网断连、删数据）。交互终端要求逐字输入 `yes`，非交互必须显式加 `--yes`——**不要替用户加 `--yes`**。
4. **不要对已有安装重复 `init`**。`init` 发现安装目录非空时，交互模式会问一遍，非交互模式直接报错；`--force` 会**删掉整个安装目录**重来。既有安装要改配置就改 `app.env` 再重启，要换角色就用对应的 `hub join` / `hub leave` / `relay join` / `relay leave`。
5. **`--replace-shim` 的语义**。`init` 部署 `~/.local/bin/vibeterm` 与 `~/.bun/bin/vibeterm` 这两个 PATH 入口时，如果那里的 shim 属于另一份仍然存在的安装、或归属记录缺失，会**跳过并打印告警**，不覆盖。确认要把 PATH 入口抢过来时才加 `--replace-shim`。非 VibeTerm 托管的同名文件任何情况下都不会被覆盖。
6. **不要在验收之外操作用户的 tmux**。VibeTerm 的会话跑在 tmux 里，`kill-server` 之类的命令会连带杀掉用户正在跑的东西。

### 通用验收方法

```bash
vibeterm doctor                 # 全项体检
curl -sS http://127.0.0.1:9883/healthz   # 本机健康检查，期望 {"status":"ok"}
vibeterm hub list               # mesh 角色：列出已知 Hub 与写者
vibeterm relay list             # 已接入中继的节点：打印 mode / 租户 / 中继表
vibeterm relay status           # 中继机本地：口令状态、租户数、在线节点、流量
```

再用浏览器打开对外地址确认页面能开、能登录。跨机部署完成后，在入口的网页侧栏里应能看到新节点。

## 独立部署

### 适用场景

单机使用：只在本机或局域网里开终端，不需要公网入口，也不打算把别的机器连进来。角色 `standalone`，默认没有登录页。

### 需要向用户确认的信息

- 是否只在本机用（`127.0.0.1`），还是要局域网其它设备访问。
- 要局域网访问时：本机在局域网里的地址、是否接受「同网段任何人都能打开」，以及是否开启登录保护。
- 是否改默认端口 `9883`。

### 步骤

1. 安装（交互模式一路回车即可，角色默认 `standalone`）：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
   ```

   非交互等价写法：

   ```bash
   bash install.sh --role standalone --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true
   ```

2. 打开 `http://127.0.0.1:9883`。

3. **要局域网访问**时，把绑定地址放开。安装时可以直接给 `--host 0.0.0.0`；已装好的实例改 `app.env`：

   ```bash
   # Linux 路径示例，macOS 换成 ~/Library/Application Support/vibeterm/app.env
   sed -i 's/^VIBETERM_BIND_HOST=.*/VIBETERM_BIND_HOST=0.0.0.0/' ~/.local/share/vibeterm/app.env
   systemctl --user restart vibeterm
   ```

   然后放行防火墙上的 `9883`。局域网地址是明文 HTTP，只适合可信网络。

4. **开启登录保护**（放开绑定后强烈建议做）：浏览器打开 → 设置 → 远程访问 → 访问控制 → 选「账号密码」→ 填用户名与密码创建首位本机用户并打开登录开关。这一步只能在网页上做，没有对应的 CLI 子命令；必须**在本机浏览器上完成**，远端来源会被拒绝创建首个账户。

### 验收

```bash
vibeterm doctor
curl -sS http://127.0.0.1:9883/healthz
```

局域网场景另在同网段的另一台设备上打开 `http://<本机局域网 IP>:9883`；开了登录保护则应看到登录页。

### 常见问题

- **`vibeterm: command not found`**：`~/.local/bin` 不在 `PATH`，执行 `export PATH="$HOME/.local/bin:$PATH"` 并写进 shell 配置。
- **端口 9883 被占**：`vibeterm doctor` 的 `port` 检查会报出来。换端口要同时改 `app.env` 的 `GATEWAY_PORT` 与 `VIBETERM_BASE_URL`，再重启。
- **局域网打不开**：先确认 `VIBETERM_BIND_HOST` 已改且服务重启过，再查防火墙。
- **无法在局域网 IP 上注册通行密钥**：WebAuthn 不允许 IP 字面量 origin，这是协议限制，只能用域名。

## Hub：公网域名

### 适用场景

有一个能解析到这台机器的域名，要把它做成公网入口（角色 `hub,node`），其它机器作为 node 加入。分两种情况：机器的 80/443 可用，或 80/443 已被别的服务占着 / 被运营商封了。

### 需要向用户确认的信息

- 域名（例如 `vibeterm.example.com`），以及 A/AAAA 记录是否已指向这台机器。
- 80 与 443 是否可用；不可用时准备用哪个高位端口（内置建议表：`2053 / 2083 / 2087 / 2096 / 8443 / 13443 / 23443 / 31443`；低于 1024 的端口用户级服务绑不上，不要选）。
- 证书怎么来：已有的 nginx / Caddy 反代终止 TLS，还是用 VibeTerm 内置的 Let's Encrypt 签发。
- 用内置签发且要走 dns-01 时：DNS 托管在 Cloudflare 还是 DNSPod，以及对应凭证（Cloudflare 一个 API Token；DNSPod 是 ID + Token）、ACME 账户邮箱。
- 首个用户名与密码（密码不少于 8 位，建议密码管理器生成 16 位以上）。

### 步骤

#### 情况 A：80/443 可用，前面已经有（或愿意加）反向代理

1. 安装并指定角色。交互模式会追问公开地址；非交互必须给 `--hub-public-url`：

   ```bash
   bash install.sh --role hub,node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --hub-public-url https://<域名>
   ```

   公开地址必须是 https（只有回环地址允许 http），写坏了当场报错。

2. 配置反代把 `https://<域名>` 指到 `127.0.0.1:9883`，并**升级 WebSocket**（至少 `/ws`、`/n/:id/ws`、`/mesh/ws`、`/hub/uplink`）。证书由反代自己管（Caddy 自动签，nginx 用 certbot）。

3. 打开信任代理开关，否则 cookie 的 `Secure`、通行密钥 origin、客户端 IP 限流都会按本机 HTTP 计算：

   ```bash
   echo 'VIBETERM_TRUST_PROXY=true' >> ~/.local/share/vibeterm/app.env
   systemctl --user restart vibeterm
   ```

   `VIBETERM_TRUST_PROXY` 只在反代确实在本机 / 内网时才可以开。

4. 创建首个用户（在 Hub 机本机执行）：

   ```bash
   vibeterm hub user add <用户名>
   ```

   TTY 下隐藏输入并二次确认；非 TTY 用 `VIBETERM_PASSWORD`。成功后会写入用户、给本机节点自签准入（Hub 机自己不需要 `hub join`），并打印根公钥指纹。已有同名用户会被拒绝——换根钥要走 `mesh reset-root`，不要重复 `add`。

5. 生成加入码，给要加入的机器用：

   ```bash
   vibeterm enroll --ttl 10m
   ```

   输入账户密码（账户开了两步验证再给 `VIBETERM_TOTP`）。命令会打印加入串与拼好的 `vibeterm hub join` 命令，然后**留在前台等对端 redeem**，对端加入成功后自动签准入；`Ctrl-C` 可以中止等待。加入码默认 10 分钟有效，`--ttl` 支持 `30s` / `5m` / `1h` 这类写法。
   账户开了两步验证时给一次有效 TOTP 验证码即可（`VIBETERM_TOTP`）；只在本 origin 注册了通行密钥、又没开 TOTP 的账户（`GET /api/auth/mode` 的 `secondFactorPolicy` 为 `passkey`）CLI 这条路径不可用，改在网页「设置 → 多节点互联 → 节点管理 → 添加 → 生成加入码」里出码。

#### 情况 B：80/443 不可用，用内置 HTTPS 监听器 + Let's Encrypt dns-01

1. 先按情况 A 第 1 步安装，但公开地址带上高位端口。非交互用 `--public-port`（它只在 `--hub-public-url` 自己没写端口时生效）：

   ```bash
   bash install.sh --role hub,node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --hub-public-url https://<域名> --public-port <公网端口>
   ```

   交互模式会在问公开地址之前先问「公网 HTTPS 端口」，默认 443，括号里给一个避开本机已占端口的建议值。

2. 创建首个用户（同情况 A 第 4 步），登录网页。

3. 设置 → 节点 → HTTPS 设置：模式选 **Let's Encrypt**，域名填 `<域名>`，验证方式选 **DNS-01**，提供商选 Cloudflare 或 DNSPod 并填凭证，内置监听绑 `0.0.0.0`、端口填 `<公网端口>`（默认 9443）。dns-01 完全不碰 80。

4. 放行防火墙 / 安全组上的 `<公网端口>`（云厂商安全组、宝塔面板防火墙、`ufw` 都要单独放）。签发成功后 `https://<域名>:<公网端口>` 就是入口。

5. 此时流量不经反代，`VIBETERM_TRUST_PROXY` 应保持关闭。

6. 创建用户与生成加入码同情况 A 的第 4、5 步。

> **必须用 dns-01 的原因**：http-01 的校验请求打的是 `http://<域名>/.well-known/acme-challenge/<token>`，需要 80 端口能到达网关的 HTTP 口。用户级服务绑不了 1024 以下端口，80 又不可用，http-01 签不下来。80 可用且能把该路径转发到 `127.0.0.1:9883` 时才考虑 http-01。

### 验收

```bash
vibeterm doctor
vibeterm hub list
curl -sS http://127.0.0.1:9883/healthz
```

浏览器打开 `https://<域名>`（或带端口的地址），能看到登录页并用刚建的账号登入。设置 → 节点 → HTTPS 设置里，「对外访问」应显示「内置」或「反向代理：已通过当前请求确认」。

### 常见问题

- **改了 `app.env` 没生效**：所有 `app.env` 变更都要重启服务。
- **登录页没有通行密钥按钮**：反代场景没开 `VIBETERM_TRUST_PROXY`，服务端看到的是 `http://127.0.0.1`，`passkeyAvailable` 判为 false。
- **改了公开地址后通行密钥失效**：通行密钥按 origin 注册，换域名或换端口就是新 origin，需要在新地址上重新注册一把。
- **`hub user add` 报同名用户已存在**：不要重复 `add`，按需走 `hub user passwd` 改密或 `mesh reset-root` 重建根钥。
- **要换 Hub 公开地址**：先让新旧地址同时可用，在各节点 `vibeterm hub urls add https://<新地址>` 预置备用种子并重启，确认全部成员都能从新地址接入后再改 `VIBETERM_HUB_PUBLIC_URL` 并下线旧地址。设置页目前没有保存 Hub 公开地址的入口。

## Hub：端口转发

### 适用场景

家宽 / 办公网，没有可用域名或不想买域名，但路由器能做端口转发。对外地址是 `https://<公网 IP>:<端口>` 或一个 DDNS 域名。证书用 VibeTerm 内置的自签 CA，加入串自带 CA 指纹，加入端按指纹 pin 住，不需要系统信任链。

### 需要向用户确认的信息

- 公网 IP 是否固定；不固定就要一个 DDNS 域名。
- 路由器上打算映射的外部端口，以及内部目标（内置 HTTPS 监听端口，默认 `9443`）。
- 本机在局域网里的固定 IP（端口转发的目标）。
- 首个用户名与密码。
- 是否接受「用 IP 地址访问就用不了通行密钥」。

### 步骤

1. 安装，公开地址写成对外真正能访问到的形态。**这里填的是公网侧的地址和端口，不是内部监听端口**：

   ```bash
   bash install.sh --role hub,node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --hub-public-url https://<公网 IP 或 DDNS 域名> --public-port <路由器外部端口>
   ```

   等价于把 `VIBETERM_HUB_PUBLIC_URL` 设成 `https://<公网 IP 或 DDNS 域名>:<路由器外部端口>`。

2. 创建首个用户并在本机浏览器登录：

   ```bash
   vibeterm hub user add <用户名>
   ```

3. 设置 → 节点 → HTTPS 设置：模式选**自签名**，SAN 列表里填上公网 IP（或 DDNS 域名）与局域网 IP，内置监听绑 `0.0.0.0`、端口 `9443`。自签证书支持 IP 类型的 SAN。

4. 路由器上加端口转发：外部 `<路由器外部端口>` → 内部 `<本机局域网 IP>:9443`，协议 TCP。同时放行本机防火墙上的 `9443`。

5. 生成加入码：

   ```bash
   vibeterm enroll --ttl 10m
   ```

   Hub 是自签 HTTPS 时，加入串是 **v2 形态**：在原来的 128 字符后面接一个点和 64 位小写十六进制串，那是该 Hub CA 的 SPKI SHA-256 指纹。加入端会先用它 pin 住从 `GET /api/tls/ca.crt` 拉到的 CA，写进本机信任表，之后对这个 URL 的所有 HTTP 与 uplink 连接都带上这张 CA。指纹对不上直接 `join_failed: ca_fingerprint_mismatch`，不落库、**不降级**。

6. 需要单独核对指纹时，在 Hub 本机：

   ```bash
   vibeterm hub ca fingerprint
   ```

   输出 `SHA256 SPKI <64 位小写 hex>`。未配置 CA 时只打印 `no CA configured` 并正常退出。

### 验收

```bash
vibeterm doctor
vibeterm hub ca fingerprint
```

从外网（例如手机蜂窝网络）打开 `https://<公网 IP 或 DDNS 域名>:<路由器外部端口>`。浏览器会因为自签证书报警告，这是预期的——CLI 加入走的是指纹 pin，不依赖浏览器信任。加入一台 node 后 `vibeterm hub list` 与网页侧栏都应能看到它。

### 常见问题

- **公网 IP 变了**：`VIBETERM_HUB_PUBLIC_URL` 里的地址失效。用 DDNS 域名可以避免；已经发生时改 `app.env` 重启，并让各节点 `vibeterm hub urls add https://<新地址>`。
- **通行密钥用不了**：IP 字面量 origin 无法注册 WebAuthn 凭证，这是协议限制。想要通行密钥就得用域名。
- **CA 轮换后节点连不上**：`vibeterm hub ca rotate` 会让全网断连。轮换前确保每台成员都留有本机终端或独立 SSH 入口；轮换并重启 Hub 后，通过可信渠道把新指纹发给各节点，在各节点执行 `vibeterm hub trust refresh https://<Hub 地址> --fingerprint <64-hex>` 再重启。指纹不符时保留旧信任，不要从没核实过的页面复制指纹。
- **运营商封了家宽入站端口**：换一个高位端口再试；全封就只能走 Cloudflare Tunnel。
- **直连（WebRTC）建不起来**：内网放行 `VIBETERM_PEER_PORT`（默认 39001/tcp）；WAN 打洞另放行 ICE UDP 段（默认 40000-40099，见 `init` / `doctor` 打印的 plan）。与公网 HTTPS 端口无关。

## Hub：Cloudflare Tunnel

### 适用场景

没有公网 IP，也做不了端口转发（CGNAT、公司网络、云主机入站全封）。用 Cloudflare Tunnel 把本机 `9883` 反向暴露到一个 `https://` 域名上，连接器只需要**出站** 7844。VibeTerm 内置了 cloudflared 的下载与托管，整个流程在设置页的远程访问向导里完成。

### 需要向用户确认的信息

- 要用哪种隧道：**命名隧道**（需要一个托管在 Cloudflare 的域名，地址固定，适合长期使用）还是**临时隧道**（`trycloudflare.com` 随机地址，重建后会变，只适合临时验证）。
- 命名隧道的主机名（例如 `vibeterm.example.com`），以及用户是否能在浏览器里完成 Cloudflare 授权登录。
- 系统里是否已经有别的 cloudflared 在跑同一个域名（可以接管，不要重复创建）。
- 是否要叠加 Cloudflare Access 做邮箱 / 域名白名单。
- 首个用户名与密码。

### 步骤

1. 安装。此时还不知道最终隧道域名，可以先按域名规划填，也可以先装 `standalone` 后面再改：

   ```bash
   bash install.sh --role hub,node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --hub-public-url https://<隧道域名>
   ```

   保持 `VIBETERM_BIND_HOST=127.0.0.1`——隧道从本机连过去，网关不需要对外监听。

2. 创建首个用户并在本机浏览器登录：

   ```bash
   vibeterm hub user add <用户名>
   ```

3. 设置 → 远程访问 → 向导：

   - 连接方式选「隧道」；
   - 第一步「安装」下载 cloudflared（内置托管，不需要用户自己装）；
   - 命名隧道：先「登录 Cloudflare」完成浏览器授权，再填主机名创建隧道；系统里已有可用隧道时向导会给出「接管」选项，用它而不是再建一个；
   - 临时隧道：直接启动，Cloudflare 分配一个 `trycloudflare.com` 地址；
   - 需要时在向导里打开「信任代理请求头」，它会把 `VIBETERM_TRUST_PROXY=true` 写进 `app.env`。

4. **确认 `VIBETERM_TRUST_PROXY=true` 且服务已重启**。没开这个开关会有两个直接后果：cookie 缺 `Secure`；通行密钥的 origin 按 `http://127.0.0.1` 计算，公网域名下无法注册或登录。另外登录限流会把所有访客算成同一个 IP（隧道 agent 的地址），一个人就能打满。

   ```bash
   grep -n VIBETERM_TRUST_PROXY ~/.local/share/vibeterm/app.env
   ```

5. 把 Hub 公开地址改成隧道域名并重启：

   ```bash
   sed -i 's|^VIBETERM_HUB_PUBLIC_URL=.*|VIBETERM_HUB_PUBLIC_URL=https://<隧道域名>|' ~/.local/share/vibeterm/app.env
   systemctl --user restart vibeterm
   ```

   临时隧道的地址由 Cloudflare 分配、重建即变，**不要**写进 `VIBETERM_HUB_PUBLIC_URL`。

6. 生成加入码：`vibeterm enroll --ttl 10m`。

> 首次部署要**先在本机完成首个用户创建，再把隧道对外打开**。未创建过账户的实例经隧道连到 `127.0.0.1` 时曾可被远端创建首个账户；当前版本按 `CF-Connecting-IP` 与解析出的客户端 IP 判定为非本机并拒绝，但顺序上仍应先 bootstrap 再暴露。

### 验收

```bash
vibeterm doctor
grep -n 'VIBETERM_TRUST_PROXY\|VIBETERM_HUB_PUBLIC_URL' ~/.local/share/vibeterm/app.env
```

设置 → 远程访问里隧道状态应为已连接；`https://<隧道域名>` 能打开登录页，登录后设置 → 节点 → HTTPS 设置的「对外访问」显示「反向代理：已通过当前请求确认」。登录页应出现通行密钥按钮（说明 origin 按 https 域名计算了）。

### 常见问题

- **状态一直是「无边缘连接」**：连接器进程活着不等于边缘连通。权威信号是 cloudflared 本地 metrics 的 `/ready`（`readyConnections === 0` 即未连通，默认端口在 `20241–20245` 之间扫描）。本机装了 Surge / Clash 这类增强模式代理时，`region1/2.v2.argotunnel.com` 会被解析成 `198.18.x.x` 的 fake-IP 导致连不上；VibeTerm 会检测并自动改走真实边缘，失败时前端给出代理侧修法（`always-real-ip` 加 `*.argotunnel.com`、加 DIRECT 规则、清代理 DNS 缓存 / 重启代理、重启隧道）。详见 [隧道边缘 fake-IP 绕行](./tunnel-edge-fake-ip.md)。
- **Cloudflare Access 把节点连接拦了**：`/relay/uplink`、`/api/relay/health`、`/api/relay/enroll` 已在豁免路径里；管理面路径故意不豁免。
- **一个人打满登录限流**：没开 `VIBETERM_TRUST_PROXY` 时所有访客共用隧道 agent 的 socket IP。

## 加入 Hub

### 适用场景

已有一台跑着 `hub,node` 的入口机，要把另一台机器（NAT 后的台式机、笔记本、云主机）接进同一个 mesh。

### 需要向用户确认的信息

- Hub 的公开地址（含端口，如果不是 443）。
- 加入方式：Hub 上 `vibeterm enroll` 生成的加入码，还是直接用 mesh 账户密码加入。
- 这台机器在节点列表里显示的名字。
- 本机是否已经是别的 mesh 的成员（是的话确认要不要换）。

### 步骤

1. 在要加入的机器上安装。角色可以先是 `standalone`，也可以直接 `node`：

   ```bash
   bash install.sh --role node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true
   ```

2. 加入。用加入码：

   ```bash
   vibeterm hub join https://<Hub 地址> --token <加入串> --name <节点名>
   ```

   或用 mesh 账户密码（账户开了两步验证再加 `--totp <6 位码>`，非 TTY 用 `VIBETERM_PASSWORD` / `VIBETERM_TOTP`）：

   ```bash
   vibeterm hub join https://<Hub 地址> --password --name <节点名>
   ```

   约束：

   - 只接受 `https:`，HTTP 重定向一律拒绝；`http://127.0.0.1` / `http://localhost` 只有非 production 且加 `--insecure-local` 才行。
   - 地址没写端口时会先探 443，再并发探内置候选端口，命中会打印「已在 xxx 端口探测到…」；地址写了端口就只按那个端口确认，绝不会被静默改到别的端口。
   - 成功后自动写 `VIBETERM_HUB_URL`、把角色置为 `node`（本来是 `hub,node` 则保留）并重启服务。加 `--no-restart` 可以跳过重启。
   - 不必先 `hub leave`：从 `node` 直接 join 另一台 Hub 即可。

3. Hub 侧那条 `vibeterm enroll` 在对端 redeem 后会自动签准入并打印结果。用网页出的码时，到「设置 → 多节点互联 → 节点管理」里确认。

### 验收

在加入的机器上：

```bash
vibeterm hub list
vibeterm doctor
```

在 Hub 的网页上：侧边栏应出现这个新节点（在线且已登录时可以直接开终端；在线未登录时显示「登录此节点」）。设置 → 多节点互联 → 节点管理里该行应显示在线、版本、到达路径。

### 常见问题

- **`join_failed: ca_fingerprint_mismatch`**：加入串带的 CA 指纹与 Hub 当前 CA 不符，通常是 Hub 轮换过 CA 或加入串来源不可信。重新出码，或先 `vibeterm hub ca fingerprint` 核对。
- **HTTP 409 `node_revoked`**：这个节点身份被吊销过，同一身份不能再加入。必须换新身份：`vibeterm mesh reset-identity` 或重新 `init`。
- **HTTP 409 `node_exists`**：该 nodeId 已被另一把公钥占用。同一身份重复 join 是幂等的，不应报这个错；出现说明本机 `node_identity` 被换过。
- **加入成功但一直不在线**：看 node 日志里的 `[uplink] connect failed … reason=`：`tls` 是证书链不被信任，`dns` 解析失败，`refused` 端口未开或防火墙，`timeout` 握手超时，`auth_rejected` 证书未准入或已吊销。
- **`key log rejected` / `epoch_changed`**：出码之后 Hub 上发生过改密或根钥重建，重新出码即可。
- **退出 mesh**：`vibeterm hub leave`，它清 `VIBETERM_HUB_URL`、角色改回 `standalone` 并重启。

## 中继：公网域名

### 适用场景

要给别人（或自己的多个 mesh）提供一台只转发密文的公共中继。中继看不到终端内容、设备清单、endpoints 与密钥日志，只按节点编号搬字节，并按租户计量与限额。有域名、80/443 情况与 Hub 一节同理。

角色二选一：`relay`（纯中继，没有前端、没有本机用户，管理只能走 CLI）或 `relay,node`（中继兼本机设备，运营者界面就在设置页）。`relay` 与 `hub` 不能同机。

### 需要向用户确认的信息

- 中继域名，以及 80/443 是否可用（不可用时的高位端口）。
- 角色选 `relay` 还是 `relay,node`。
- 证书方案（反代终止 TLS，还是内置 Let's Encrypt dns-01）。
- 是否设置接入口令（不设的话任何人都能注册成租户）。
- 默认配额与中继级限额：每租户最大节点数、最大并发流、带宽、单文件大小；中继总租户数、总带宽、是否开公平分配。
- `relay,node` 还要一个本机用户名与密码。

### 步骤

1. 安装。非交互必须给 `--relay-public-url`，它在落任何配置之前就按 https 规则校验（只有回环允许 http）：

   ```bash
   bash install.sh --role relay --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --relay-public-url https://<中继域名>
   ```

   要中继兼本机设备就把 `--role relay` 换成 `--role relay,node`。80/443 不可用时加 `--public-port <公网端口>`（地址自己写了端口则该参数不生效）。

2. 配置对外 HTTPS：

   - **80/443 可用**：反代 `https://<中继域名>` → `127.0.0.1:9883`，升级 WebSocket（至少 `/relay/uplink`），并在 `app.env` 加 `VIBETERM_TRUST_PROXY=true` 后重启——中继按客户端 IP 对注册做限流，不开这个开关反代后面所有人共用一个桶。
   - **80/443 不可用**：`relay,node` 可以在设置页配内置 Let's Encrypt dns-01 + 高位端口（同 Hub 情况 B）；纯 `relay` 没有前端，只能靠反代。放行防火墙上的对外端口。

   另外按 `init` 打印的端口计划放行入站口。内置 TURN 是裸 UDP、**不经反代**（用户级服务打不开防火墙）：

   ```
   UDP 40000            # 控制口，节点的可达探测打的就是它
   UDP 40001-40049     # 中继端口段，整段都要放
   UDP 40050-40099     # 仅 relay,node：本机 ICE
   ```

   云厂商安全组、面板防火墙、`ufw` 三层各放一次。端口要改就在 `app.env` 里设
   `VIBETERM_TURN_PORT` / `VIBETERM_TURN_RELAY_PORT_RANGE`（`VIBETERM_TURN_PORT=off` 关掉内置 TURN）；机器网卡上只有私网地址而
   自动解析不出公网 IP 时补 `VIBETERM_TURN_EXTERNAL_IP`。TUN 代理宿主不要把 `VIBETERM_TURN_BIND_HOST` 设回 `0.0.0.0`。`install.sh` / `vibeterm init` 结束时打印完整 plan。

3. `init` 结束时会打印管理令牌所在的 `app.env` 路径。管理令牌键名 `VIBETERM_RELAY_ADMIN_TOKEN`，缺失时首启自动生成一枚写回 `app.env`，库里只存它的 sha256。所有 `relay status` / `relay tenants` / `relay metrics` / `relay quota` / `relay limits` / `relay-admin *` 命令都在**中继机本地**执行，读这个令牌打 `http://127.0.0.1:<GATEWAY_PORT>`。`vibeterm relay metrics [--members] [--json]` 打 `GET /api/relay/metrics?members=0|1`（默认不加 `--members` 省略成员数组）。

4. 设置接入口令（强烈建议，否则任何人都能注册租户）：

   ```bash
   vibeterm relay-admin passwd
   ```

   TTY 下隐藏输入两遍；非 TTY 用 `VIBETERM_RELAY_PASSWORD`。默认 `--keep`：只推进口令世代，已接入的租户不受影响。`--kick` 会把所有旧令牌立刻作废并断链，租户需要用新口令 `vibeterm relay reauth <url>` 才能恢复（租户编号不变）。在线成员少于已准入成员时命令会拒绝并提示人数，确实要强改再加 `--force`。清除口令用 `--clear`。

5. 设默认配额与中继级限额：

   ```bash
   vibeterm relay quota default --max-nodes 16 --max-streams 64 --bandwidth 512 --max-file-mb 512
   vibeterm relay limits --max-tenants 20 --total-bandwidth-kb 8192 --fair-share on
   ```

   配额默认值：`maxNodes` 16（上限 256）、`maxStreams` 64（上限 65536）、带宽不限（上限 10 GiB/s）、单文件不限（上限 1 TiB）。限额默认：租户数不限、总带宽不限、公平分配开。`relay limits` 不带参数就是只读打印当前限额。单个租户用 `vibeterm relay quota <租户编号> ...`，`--inherit` 让它回到跟随默认。

6. 让第一个 mesh 接进来。**中继自己不产生租户**，租户是由某台节点执行 `relay enroll` 注册出来的：

   ```bash
   # 在要接入的节点上执行（relay,node 机器可以填自己的中继地址）
   vibeterm relay enroll https://<中继域名>
   ```

   该命令要本机 mesh 账户密码（`VIBETERM_PASSWORD` 或隐藏输入）派生根钥；本机还没有用户时可以用 `--username <用户名>` 让它先建一个。中继设了接入口令时会再要一次中继口令（`--password <口令>` 或 `VIBETERM_RELAY_PASSWORD`）。流程是：探 `GET <url>/api/relay/health` → 登录本机网关 → 取证明材料 → 本地签名 → 注册 → 签 `set-relays` 记录 → 轮询直到在线（最多 30 秒）。

7. 给租户打标签便于识别：

   ```bash
   vibeterm relay tenants
   vibeterm relay metrics [--members]
   vibeterm relay label <租户编号> <说明文字>
   ```

### 验收

在中继机本地：

```bash
vibeterm relay status
vibeterm relay tenants --json
curl -sS https://<中继域名>/api/relay/health
```

`relay status` 应打印 `password: set`、口令世代、默认配额、租户数、在线 / 已知节点数与累计流量，以及一行
`turn: builtin enabled listening url=turn:<公网 IP>:40000?transport=udp …`；`vibeterm doctor` 的 `turn` 检查同时给出该放行的端口。
`turn:` 行缺 `listening` 或带 `error=` 时看中继日志的 `[relay][turn]`。`/api/relay/health` 是免鉴权探针，返回 `ok: true`；反代健康检查也用它。

在租户节点上 `vibeterm relay list` 应显示 `mode` 为中继模式、租户编号与该中继在线。

### 常见问题

- **`VIBETERM_RELAY_ADMIN_TOKEN missing from app.env; this machine is not running the relay role`**：在非中继机上跑了运营者命令，或 `app.env` 里没有这个键。
- **纯 `relay` 打开网页是 404**：预期行为，`relay` 角色不提供前端，所有非 `/api/relay/*` 请求返回 `RELAY_NO_FRONTEND`。要网页管理就用 `relay,node`。
- **版本门**：中继与租户节点都必须 ≥ 1.1.23，低版本 `relay.auth` 直接被拒。
- **改口令后有租户掉线**：用了 `--kick`。让对应节点执行 `vibeterm relay reauth https://<中继域名>` 恢复；完全离线的成员用 `vibeterm relay join https://<中继域名> --tenant <租户编号> --password` 重新接入。
- **踢租户与删租户的区别**：`relay kick <租户编号>` 只作废令牌并断链，数据留着；`relay remove <租户编号>` 连注册表、加入码与密钥日志一起删（非 TTY 必须加 `--yes`）。

## 中继：端口转发

### 适用场景

在家宽或办公网架中继，没有域名或不打算备案，但路由器能端口转发。对外地址是 `https://<公网 IP>:<端口>` 或 DDNS 域名，证书用内置自签 CA。中继地址会被写进加入串并参与认证签名，所以**必须一次定对**。

### 需要向用户确认的信息

- 公网 IP 是否固定；不固定就要 DDNS 域名。
- 路由器外部端口与内部目标（内置 HTTPS 监听端口，默认 `9443`）。
- 角色 `relay` 还是 `relay,node`（要在网页上配自签证书就得选 `relay,node`）。
- 接入口令、默认配额与限额。

### 步骤

1. 安装，公开地址写成公网侧真正能访问到的形态：

   ```bash
   bash install.sh --role relay,node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --relay-public-url https://<公网 IP 或 DDNS 域名> --public-port <路由器外部端口>
   ```

   `VIBETERM_RELAY_PUBLIC_URL` 允许带非默认端口，归一化、uplink 认证签名与加入串全程保留它。

2. `relay,node` 先建本机用户并登录网页：`vibeterm hub user add <用户名>`。

3. 设置 → 节点 → HTTPS 设置：模式选**自签名**，SAN 填公网 IP（或 DDNS 域名）与局域网 IP，内置监听绑 `0.0.0.0`、端口 `9443`。

4. 路由器加端口转发：外部 `<路由器外部端口>` → 内部 `<本机局域网 IP>:9443`，TCP；放行本机防火墙。

5. 设接入口令、配额、限额（同「中继：公网域名」第 4、5 步）。**不要**开 `VIBETERM_TRUST_PROXY`——这条链路没有反代。

6. 取 CA 指纹发给要接入的人：

   ```bash
   vibeterm hub ca fingerprint
   ```

   输出 `SHA256 SPKI <64 位小写 hex>`。自签中继上，节点必须用这个指纹才能建立信任：CLI 加入时传 `--ca-fingerprint <hex>`，或者用网页出的 `r3.` 加入串（指纹作为后缀内嵌在串里）。

7. 第一台节点接入：

   ```bash
   vibeterm relay enroll https://<公网 IP 或 DDNS 域名>:<路由器外部端口>
   ```

### 验收

```bash
vibeterm relay status
curl -sSk https://<公网 IP 或 DDNS 域名>:<路由器外部端口>/api/relay/health
vibeterm hub ca fingerprint
```

从外网确认健康探针能通（自签证书需要 `-k`，节点侧走的是指纹 pin 而不是系统信任链）。

### 常见问题

- **公网 IP 变了**：`VIBETERM_RELAY_PUBLIC_URL` 里的地址与 uplink 签名绑定的 host 一起失效，所有租户都连不上。用 DDNS 域名规避。
- **`relay enroll` 报「不健康」**：地址、端口、防火墙、端口转发四项逐个查；地址没写端口时命令会自动探候选端口并打印探过哪些。
- **指纹不符**：中继的 CA 换过。加入侧指纹不符**不做 failover**，直接中止——这是安全信号，重新通过可信渠道拿指纹。
- **不要用 IP 地址当长期入口**：通行密钥无法在 IP origin 上注册。

## 中继：Cloudflare Tunnel

### 适用场景

中继机没有公网 IP、也做不了端口转发。用 Cloudflare Tunnel 把 `9883` 暴露到一个固定域名上。**只用命名隧道**——中继地址被写进加入串并参与认证签名，临时隧道地址会变，一变全部租户失联。

### 需要向用户确认的信息

- 命名隧道的主机名（托管在 Cloudflare 的域名）。
- 角色 `relay` 还是 `relay,node`（隧道向导在设置页，纯 `relay` 没有前端，必须选 `relay,node` 才能用向导；纯 `relay` 只能外部自行托管 cloudflared）。
- 接入口令、默认配额与限额。

### 步骤

1. 安装，公开地址直接写隧道域名：

   ```bash
   bash install.sh --role relay,node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true \
     --relay-public-url https://<隧道域名>
   ```

   保持 `VIBETERM_BIND_HOST=127.0.0.1`。

2. `vibeterm hub user add <用户名>` 建本机用户并在本机浏览器登录。

3. 设置 → 远程访问 → 向导：安装 cloudflared → 登录 Cloudflare → 创建命名隧道（主机名填 `<隧道域名>`），或接管系统里已有的同名隧道。

4. **打开信任代理**并重启：

   ```bash
   grep -n VIBETERM_TRUST_PROXY ~/.local/share/vibeterm/app.env || \
     echo 'VIBETERM_TRUST_PROXY=true' >> ~/.local/share/vibeterm/app.env
   systemctl --user restart vibeterm
   ```

   中继按客户端 IP 对注册限流，不开这个开关所有租户共用隧道 agent 的一个桶。

5. 设接入口令、配额、限额（同「中继：公网域名」第 4、5 步）。

6. 第一台节点接入：`vibeterm relay enroll https://<隧道域名>`。

7. 若额外套了 Cloudflare Access：`/relay/uplink`、`/api/relay/health`、`/api/relay/enroll` 已在豁免路径里；`/api/relay/tenants/` 前缀只豁免 origin 守卫、不建 Access bypass 应用；管理面 `/api/relay/status|password|config|tenants/:id` **不豁免**，本来就该走浏览器会话或管理令牌。

### 验收

```bash
vibeterm relay status
curl -sS https://<隧道域名>/api/relay/health
```

设置 → 远程访问里隧道状态应为已连接。在另一台节点上 `vibeterm relay enroll https://<隧道域名>` 能成功注册并在 `relay list` 里显示在线。

### 常见问题

- **「无边缘连接」**：同「Hub：Cloudflare Tunnel」的排查——看 cloudflared 本地 metrics 的 `/ready`，本机代理 fake-IP 场景见 [隧道边缘 fake-IP 绕行](./tunnel-edge-fake-ip.md)。
- **用了临时隧道**：地址重建即变，租户全掉。改成命名隧道后需要把 `VIBETERM_RELAY_PUBLIC_URL` 改成新域名并重启，已接入的租户要重新 enroll。
- **Access 把 uplink 拦了**：确认没有给豁免路径额外加策略。

## 加入中继

### 适用场景

把一台机器接到已有的中继上。两种身份：

- **租户的第一台机器**：执行 `vibeterm relay enroll <url>`，会在中继上注册出一个新租户（见「中继：公网域名」第 6 步）。
- **同一租户的后续机器**：用下面的 `vibeterm relay join`（密码加入），或用第一台机器在网页上生成的 `r3.` 加入码。

### 需要向用户确认的信息

- 中继地址（含端口，如果不是 443）。
- 租户编号（32 位十六进制；在已接入的节点上 `vibeterm relay list` 可看到，中继运营者用 `vibeterm relay tenants` 也能看到）。
- mesh 账户密码（**不是**中继接入口令；密码加入解的是根种子）。
- 中继用自签证书时的 CA 指纹（64 位十六进制）。
- 这台机器在节点列表里的名字。

### 步骤

1. 在要加入的机器上安装（角色 `standalone` 或 `node` 都行）：

   ```bash
   bash install.sh --role node --no-interactive \
     --install-dir "$HOME/.local/share/vibeterm" \
     --host 127.0.0.1 --port 9883 \
     --db-path "$HOME/.local/share/vibeterm/data/vibeterm.db" \
     --autostart true
   ```

2. **密码加入**（推荐，不需要提前出码）：

   ```bash
   vibeterm relay join https://<中继地址> --tenant <租户编号> --password --name <节点名>
   ```

   非 TTY 用 `VIBETERM_PASSWORD` 提供 mesh 账户密码。中继用自签证书时必须带指纹：

   ```bash
   vibeterm relay join https://<中继地址> --tenant <租户编号> --password \
     --ca-fingerprint <64 位十六进制> --name <节点名>
   ```

   `--ca-fingerprint` 用来 pin 住中继的 CA；不给就走系统信任库，**绝不静默降级 TLS**。成功后写角色（`node`，本机已跑中继则 `relay,node`）、清空 Hub 相关键并重启；`--no-restart` 可跳过重启。

   前提：本机还没有 mesh 用户、也没有绑定过节点身份，否则报 `local_user_exists`。

3. **加入码方式**：在同租户已接入的任一节点网页上「设置 → 多节点互联 → 节点管理 → 添加 → 生成加入码」，得到 `r3.` 开头的串，然后在新机器上：

   ```bash
   vibeterm hub join --token r3.<加入串>
   ```

   `r3.` 串里内嵌了每台中继的地址、租户编号与各自的令牌（最多 16 台），所以不需要再给 URL；显式给 URL 只是把那台中继提到 failover 队首。串尾带 CA 指纹时会先 pin 再发任何带令牌的请求，指纹不符**不 failover**、直接中止。

4. 中继运营者侧不需要做任何操作——成员判定在租户自己的节点上完成，中继的注册表只是链路准入缓存。

### 验收

在加入的机器上：

```bash
vibeterm relay list
vibeterm doctor
```

`relay list` 应显示 `mode` 为中继模式、租户编号、元数据密钥世代、经中继可见的节点数，以及中继表里对应那行在线。

在同租户的其它节点网页上，侧边栏应出现这台新节点。

中继运营者可以在中继机本地用 `vibeterm relay status` / `vibeterm relay tenants` 确认该租户的节点计数涨了一个（中继是盲中继，看不到节点名）。

### 常见问题

- **`local_user_exists`**：这台机器已经是别的 mesh 的成员。要换就先处理原有归属（`vibeterm hub leave` / `vibeterm relay leave`），或重新 `init`。
- **404 `RELAY_TENANT_NOT_FOUND`**：租户编号写错，或该租户还没上传过密封包（根钥轮换后会清空，需要持有根种子的节点重新 `relay enroll` / `relay reauth` 刷新，或 `vibeterm relay pack upload`）。
- **401 `RELAY_TENANT_KICKED`**：该租户被运营者踢了。让持有根种子的节点用新口令 `vibeterm relay reauth <url>` 恢复。
- **加入报「该中继不在根签名的中继列表里」**：用户输入的地址不在该租户已授权的中继表中，核对地址与端口是否与 `relay list` 里的完全一致。
- **加了一半失败、中继上留下 pending 节点**：让运营者在成员表里撤销那个 pending 节点后重试。
- **退出中继**：`vibeterm relay leave`（要账户密码，它签一条空的中继列表记录）。
- **令牌换发**：`vibeterm relay resend-token` 让中继重发当前令牌；`vibeterm relay pack upload` 单独刷新密封包。

## 用 CLI 调试别的节点

面向「AI 助手跑在 A 机器上，要去看 B、C 机器上的终端」的场景。这一节用的是**客户端命令**（`login|logout|whoami|api|nodes|devices|tmux|term|files|cp|port|share|watch|agent|settings`），只经 HTTP / WebSocket 访问入口，权限与一个浏览器会话完全等价，因此也能装在没有部署服务的机器上；和上面各节的本机运维命令（`init` / `doctor` / `hub` / `relay` 等）边界完全不同。完整手册见[命令行使用手册](./cli-usage.md)。

### 先登录一次

```bash
VIBETERM_PASSWORD='<密码>' VIBETERM_TOTP='<6 位码>' \
  vibeterm login --entry https://<入口地址> --user <用户名>
```

- 默认把入口后面**每个节点**都登一遍，之后访问任意节点都不用再登。落盘的只有会话 sid 与到期时刻（`~/.config/vibeterm/session.json`，`0600`）；密码、根种子、会话私钥都不落盘。
- 账户开了两步验证时，**一次有效 TOTP 验证码就够**（通行密钥同样满足二次验证，但 CLI 做不了 WebAuthn）。只在本 origin 注册了通行密钥、又没开 TOTP 的账户，CLI 登不上，退出码 3 并提示去网页端开 TOTP。
- 之后**每条命令都带 `--json`**：stdout 只有结构化结果，提示与进度走 stderr，便于解析。
- 收工或换机器时 `vibeterm logout`：撤销的是**服务端**会话，等同于网页端退出登录。

### 定位目标

```bash
vibeterm nodes ls --json                    # 有哪些节点、是否在线
vibeterm devices ls --node <节点> --json    # 那个节点上的设备
vibeterm tmux ls <节点>/<设备> --json       # session → window → pane 三层
```

目标语法统一是 `[<节点>/]<设备>[:<窗口>[.<窗格>]]`，不写节点就是入口自己。

### 跑命令、看画面、发按键

```bash
vibeterm term run prod-1/app "systemctl --user status vibeterm" --marker --json
vibeterm term capture prod-1/app --strip-ansi
vibeterm term send prod-1/app "tail -f /var/log/app.log" Enter
vibeterm term send prod-1/app C-c
```

这三条是给非交互场景用的（`term attach` 需要 TTY，脚本里跑会以退出码 2 退出）。必须知道的限制，否则容易把半截输出当结论：

- `run` 把命令打进窗格后按**静默**判定结束：`--idle` 毫秒（默认 800）内没有新输出就收尾，最长等到 `--timeout`。命令必须是**一行**。
- `--marker` 会在静默之后另起一行打哨兵 `(echo __VT_DONE_<随机串>_$?)`，据此确认命令真跑完并拿到 `exitCode`。只对 POSIX shell（bash / zsh / sh）成立，fish 用的是 `$status`；`cat`、交互式安装器这类主动读 stdin 的命令会把哨兵吃掉，那类命令别用 `run`。
- 输出上限 **8 MiB**，收满即停并把 `reason` 标成 `truncated`。
- **退出码分两层**：远端命令自己的成败看 JSON 里的 `exitCode`；输出没收全（`reason` 是 `timeout` 或 `truncated`）时 CLI 自己退出 **1**，除非显式加 `--allow-timeout`。
- 窗格是**共享的交互终端**，不是干净的 `ssh host cmd`：输出里可能混进提示符、别人同时敲进去的字，或者被终端宽度折行打断的回显。
- 长跑的流式命令（`tail -f`、`npm run dev`）不要用 `run`，它只会一直等到超时；改用 `send` + `capture`，收尾记得再 `send C-c`。
- `capture --strip-ansi` 的洗白是简化实现（不执行绝对行定位），全屏 TUI（vim、top）的纯文本结果会有出入；这种时候直接看 `--json` 里 `screen` 的原始字节。

### 搬运产物与打开远端端口

```bash
vibeterm cp ./patch.diff prod-1:home/tmp/patch.diff          # 本机 → 节点
vibeterm cp prod-1:home/app/dist ./dist -r                   # 节点 → 本机（目录加 -r）
vibeterm cp prod-1:home/build.log air:home/tmp/build.log     # 节点 → 节点
vibeterm port map 8080 prod-1:127.0.0.1:8080                 # 远端服务映射到本机 localhost:8080
vibeterm port ls --json
vibeterm port rm <映射 id>
```

- `cp` 的每一侧是 `[<节点>:]<根 id 或根名>/<路径>` 或本机路径；本机 → 节点会按需先 `POST /api/files/mkdir` 建目录，旧版本节点没有这个接口，递归复制会在开头直接失败。
- `--on-conflict overwrite|skip|rename` 决定同名处理，默认 `skip`；有任何一项出错就以非零退出，想让「跳过」也算失败加 `--fail-on-skip`。
- 要给远端送密钥、配置、补丁一律走 `cp`，**不要当按键发**。
- 端口映射是常驻监听，用完记得 `port rm`。

### 不要做的事

- **不要把口令 / 令牌放进 argv**：命令行会进 shell 历史与进程列表。密码走 `VIBETERM_PASSWORD`、验证码走 `VIBETERM_TOTP`、分享口令走 `--password-stdin` / `--password-file` / `VIBETERM_SHARE_PASSWORD`。
- **不要把密码当按键发**：`term send` / `term run` 打进去的字符和真人敲的没有区别，会被同一窗格的其他观看者看到，也会进远端 shell 历史。
- **不要默认加 `--insecure`**：它整个关掉 TLS 证书校验（命令会打警告）。自签场景用 `--ca <pem 文件>` 显式信任那张证书。
- **不要替用户跑破坏性命令**：`nodes revoke`、`nodes uninstall`、`share revoke`、`devices rm` 之类都要用户先确认，`--yes` 由用户给。
- **权限就是那个账号的权限**：CLI 能碰到的节点 = 登录账号能碰到的节点。要收紧就给 agent 单独建账号，不要共用管理员会话。

## 排障速查

| 症状 | 检查命令 | 处理 |
| --- | --- | --- |
| 装完 `vibeterm` 找不到 | `ls ~/.local/bin/vibeterm; echo $PATH` | `export PATH="$HOME/.local/bin:$PATH"` 并写进 shell 配置 |
| `init` 打印跳过 shim 的告警 | `ls -l ~/.local/bin/vibeterm ~/.bun/bin/vibeterm` | PATH 入口属于另一份仍存在的安装。确认要抢过来再 `init --replace-shim`；非 VibeTerm 托管的同名文件不会被覆盖 |
| 服务起不来 | `systemctl --user status vibeterm -l --no-pager` / `journalctl --user -u vibeterm -n 200 --no-pager`；macOS `launchctl print gui/$(id -u)/com.vibeterm.vibeterm` | 核对 `app.env` 的 `VIBETERM_MASTER_KEY`、`GATEWAY_PORT`、`VIBETERM_BIND_HOST`、`DATABASE_URL` 是否齐全；跑 `vibeterm doctor --fix` |
| `/healthz` 返回 `degraded: master_key_mismatch` | `curl -sS http://127.0.0.1:9883/healthz` | 库与 `VIBETERM_MASTER_KEY` 不配。优先从 `backups/app.env.*` 恢复配套的 key；实在恢复不了才停服务后 `vibeterm mesh reset-identity`（需用户确认） |
| HTTP 口 9883 被占 | `vibeterm doctor`（`port` 检查）；`lsof -nP -iTCP:9883 -sTCP:LISTEN` | 停掉占用进程，或改 `app.env` 的 `GATEWAY_PORT` 与 `VIBETERM_BASE_URL` 后重启 |
| peer 口 39001 被占 / 直连建不起来 | `lsof -nP -iTCP:39001 -sTCP:LISTEN`；`grep VIBETERM_PEER_PORT <安装目录>/app.env` | 改 `VIBETERM_PEER_PORT` 并重启，同时放行内网防火墙上的新端口。它只承载签名信令，公网不需要开 |
| 内置 HTTPS 端口 9443 被占 | `lsof -nP -iTCP:9443 -sTCP:LISTEN` | 设置 → 节点 → HTTPS 设置里换端口（建议表：2053 / 2083 / 2087 / 2096 / 8443 / 13443 / 23443 / 31443），并同步改公开地址里的端口 |
| ACME 签发失败 | 设置 → 节点 → HTTPS 设置里的错误信息 | http-01 需要 80 能到达网关 HTTP 口；80 不可用就改 dns-01（Cloudflare 或 DNSPod），并确认凭证与 ACME 邮箱正确。换提供商必须同时给新凭证 |
| 证书有效但节点报 `reason=tls` | 节点日志 `[uplink] connect failed … reason=tls` | 自签场景要 pin CA：`vibeterm hub ca fingerprint` 取指纹，节点上 `vibeterm hub trust refresh https://<Hub 地址> --fingerprint <hex>` 后重启 |
| `hub join` 失败：非 https / `--insecure-local` | 看命令输出 | 换成 https 地址；回环地址只有非 production 且加 `--insecure-local` 才允许 |
| `hub join` 失败：`ca_fingerprint_mismatch` | `vibeterm hub ca fingerprint`（Hub 本机） | 加入串里的指纹与 Hub 当前 CA 不符。重新 `vibeterm enroll` 出码；不要从没核实的页面复制指纹 |
| `hub join` 失败：409 `node_revoked` | 命令输出 | 该身份已被吊销，必须换新身份：`vibeterm mesh reset-identity` 或重新 `init` |
| `hub join` 失败：`key log rejected` / `epoch_changed` | 命令输出 | 出码之后 Hub 上改过密或重建过根钥，重新 `vibeterm enroll` |
| 加入成功但节点一直离线 | 节点日志 `[uplink] connect failed … reason=` | `dns` 解析失败；`refused` 端口未开或防火墙；`timeout` 握手超时（查反代是否支持 WebSocket）；`auth_rejected` 证书未准入或已吊销（对照 Hub 日志 `[hub][uplink] auth rejected … reason=`） |
| 网页 WS 立刻以 4401 断开 | 浏览器控制台 | 没有会话或会话过期，跳登录页；这不是证书或 JWT 问题 |
| 登录页没有通行密钥按钮 | `grep VIBETERM_TRUST_PROXY <安装目录>/app.env` | 反代 / 隧道场景必须 `VIBETERM_TRUST_PROXY=true` 并重启；纯 IP 地址入口无法注册通行密钥 |
| 隧道显示「无边缘连接」 | `curl -sS http://127.0.0.1:<metrics 端口>/ready`（默认在 20241–20245 之间） | `readyConnections === 0` 即未连通。本机代理把 `*.argotunnel.com` 解析成 `198.18.x.x` 时按 [隧道边缘 fake-IP 绕行](./tunnel-edge-fake-ip.md) 处理：加 `always-real-ip`、DIRECT 规则、清代理 DNS 缓存、重启隧道 |
| `relay enroll` 报中继不健康 | `curl -sS https://<中继地址>/api/relay/health` | 期望 `ok: true`。不通就查地址、端口、防火墙、端口转发；地址没写端口时命令会打印探过哪些端口 |
| 运营者命令报缺 `VIBETERM_RELAY_ADMIN_TOKEN` | `grep VIBETERM_RELAY_ADMIN_TOKEN <安装目录>/app.env` | 这台机器不是中继角色，或跑错了机器。运营者命令只能在中继机本地执行 |
| 改中继口令被 409 `relay_members_offline` 拒绝 | `vibeterm relay status` | 有成员离线，强改会让他们再也接不回来。可达节点先 `relay reauth`，离线成员改用 `relay join --tenant --password`；确实要强改再加 `--force`（需用户确认） |
| 租户加入报 404 `RELAY_TENANT_NOT_FOUND` | `vibeterm relay tenants`（中继本地） | 租户编号写错，或密封包被根钥轮换清空。持有根种子的节点执行 `vibeterm relay pack upload` 或 `relay reauth` 刷新 |
| 云上放行了端口仍不通 | 云厂商安全组 / 宝塔防火墙 / `ufw status` | 三层防火墙都要显式放行选定的 TCP 端口，这是最常见的失败原因 |
| 中继在跑但节点拿不到 TURN | 中继机 `vibeterm relay status` 的 `turn:` 行、`vibeterm doctor`；节点侧日志 `[mesh][rtc] turn gate … reachable=0` | 本机监听正常而节点探测不通 = UDP 端口没放行：控制口（默认 40000）与**整段**中继端口（默认 40001-40049）都要放，三层防火墙各放一次 |

## 参考

- [部署指南（安装 / 服务 / SSH 设备 / 备份）](./production-install.md)
- [mesh 运维手册](./mesh-operations.md)
- [公共中继角色](../architecture/relay.md)
- [非标端口部署](./nonstandard-ports.md)
- [HTTPS 与 ACME](./https-and-acme.md)
- [隧道边缘 fake-IP 绕行](./tunnel-edge-fake-ip.md)
- [命令行使用手册](./cli-usage.md)
- [登录面安全](../security/login-security.md)
- [多 hub 主 / 备](./multi-hub-standby.md)
