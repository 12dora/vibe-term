# Hub/Node Docker 实测 Harness

本文说明 `scripts/hub-e2e/` 的两套 Docker 实测拓扑：单机 compose（hub + 两 node）与分体拓扑（远端公网 hub × 本机 NAT node），含运行方式、场景断言与限制；面向做 mesh 实测的开发者。

## 背景

把「一台公网 hub + 两台 NAT 后 node」的 mesh 装进 Docker，用脚本走完 enroll / join / 登录 / 终端 / 文件 / hub 宕机恢复，而不是只靠进程内 integration test。不调用 `vibeterm init`（容器里没有 systemd/launchd），按安装布局手铺 `/opt/vibeterm`。

本 harness 只有 `scripts/hub-e2e/`，不改应用源码。容器内 tmux 使用独立 socket（`vibeterm-hub` / `vibeterm-node-a` / `vibeterm-node-b`），不会碰到宿主机默认 socket 上的 session，也不会写本机生产安装目录。

## 拓扑

```
                     127.0.0.1:18543
                            |
                         [caddy]
                   TLS: hub.vibeterm.test
                        entry.vibeterm.test
                     /        |        \
               edge /    uplink-a    uplink-b
                   /          |          \
               [hub] ---- [node-a]     [node-b]
            hub,node        node          node
                              \            /
                               \   lan    /
                          (默认不连，场景 4 再 connect)
```

- `edge`：caddy、hub、node-a。浏览器/驱动走 HTTPS。
- `uplink-a`：hub 与 node-a。
- `uplink-b`：caddy 与 node-b。**hub 不加入 uplink-b**，避免与 node-b 共网把 peer:39001 判成 `lan`，场景 3 才能稳定看到 `reach=relay`。
- `lan`：仅 node-a ↔ node-b，脚本运行时 `docker network connect/disconnect`。
- 驱动跑在 `driver` 容器（同一 `vibeterm-e2e` 镜像，挂仓库，`NODE_EXTRA_CA_CERTS=/ca/ca.crt`）。TLS 用 harness 生成的私有 CA；Bun 1.3.14 的 `fetch`/`WebSocket` 都认该变量。不改宿主机 `/etc/hosts`。

镜像策略：上游只留 `ubuntu:24.04` 与 `caddy:2`。Bun 1.3.14、Node 22、tmux、rsync、openssl、curl、VibeTerm tarball 全部打进 `vibeterm-e2e`。目标平台 `linux/amd64`。

## 本地运行

预构建包（本 worktree `bun run build && (cd packages/app && npm pack)`）：

```bash
VIBETERM_TARBALL=/path/to/vibeterm-cli-<version>.tgz scripts/hub-e2e/run.sh
```

结束：

```bash
scripts/hub-e2e/run.sh down    # compose down -v
```

可选环境变量：`VIBETERM_E2E_USER`（默认 `alice`）、`VIBETERM_E2E_PASSWORD`。

产物在 `scripts/hub-e2e/out/`（gitignored）：`report.md`、各容器日志、cookie、enroll 日志。

保存镜像供离线机：

```bash
docker save vibeterm-e2e:latest caddy:2 -o vibeterm-e2e-images.tar
```

## 远端（无 Docker Hub）运行

目标机只需 Docker（能访问 github / bun.sh / npm / ubuntu archive 即可，不需要 Docker Hub、Node、Bun）。本机 qemu 跑 amd64 一轮 15–25 分钟，原生 x86 机器一轮约 3.5 分钟，迭代一律放远端。

1. 基础镜像只传一次：本机 `docker pull --platform linux/amd64 ubuntu:24.04 caddy:2 && docker save ubuntu:24.04 caddy:2 | gzip > base-images.tgz`，目标机 `docker load -i base-images.tgz`。
2. 仓库 rsync 到目标机（排除 `node_modules`、`.git`、`scripts/hub-e2e/{out,ca,build}`）。目标机**不需要** `node_modules`：本机 `scripts/hub-e2e/build-driver.sh` 把 `driver/*.ts` 打成单文件 `driver-dist/*.js`（`bun build --target bun`），`run.sh` 检测到 `driver-dist/` 即优先使用。
3. tarball（`bun run build && cd packages/app && npm pack`；只改 gateway 时 `bun run build:runtime && bun run build:cli && npm pack` 即可）放到目标机，然后：

```bash
cp <tarball> scripts/hub-e2e/build/vibeterm-cli.tgz
docker build --platform linux/amd64 -t vibeterm-e2e:latest -f scripts/hub-e2e/Dockerfile scripts/hub-e2e   # 首次约 12 分钟，之后只重做 COPY tarball 之后的层
VIBETERM_E2E_SKIP_BUILD=1 VIBETERM_TARBALL=<tarball> scripts/hub-e2e/run.sh
```

`--image-tar` 仍可用于把本机 `docker save` 的整包 `vibeterm-e2e:latest` 直接 load。目标机上生成 CA（`gen-ca.sh`）只需 openssl（容器内已有）。目标机若有别的服务占 80/443，本 harness 不受影响：只在 docker 网络内互通，宿主只绑 `127.0.0.1:18543`。

## 场景断言

| # | 断言 |
|---|---|
| 1 | hub `/healthz`；`hub user add`；`/api/auth/mode` 含 `rootEpoch` / `rootPublicKey` / `hubPublicUrl` |
| 2 | node-a、node-b join 成功；`/api/hub/nodes` 两者 `online:true` |
| 3 | hub 入口登录；mesh 列表含两 node；登录 node-b；在 node-b 建 local device + tmux；marker 回环；此时 `lan` 未连，`reach=relay` |
| 4 | `docker network connect` lan；60s 内从 node-a 看 node-b `reach=lan`；marker 仍通 |
| 5 | node-b `/e2e/marker.txt`；经 `/n/<id>/api/files/*` list + content |
| 6 | node-a 为入口且 lan 仍在，`docker stop hub`；既有 cookie 下终端 marker 与文件列表仍通；`/api/mesh/nodes` 仍列出 node-b |
| 7 | `docker start hub`；90s 内 `/api/hub/nodes` 两者 online；旧 cookie 无需重登 |
| 8 | 在 node-a 跑 `bin/vibeterm.js direct enable`，重启容器后；有 `native/node_datachannel.node` + `manifest.json` 且 `direct_capable=true` 则 PASS，npm 拉包失败则 SKIP，不判 FAIL |
| 9 | `hub user totp` 后无码登录返回 `TOTP_REQUIRED`、错码返回 `TOTP_INVALID`；`--totp-secret` 登录成功且 `/api/auth/mode` 的 `totpEnabled` 为 true；`hub user passwd`（`VIBETERM_PASSWORD_OLD` + `VIBETERM_PASSWORD`）后 TOTP 清除，新密码无码可登 |

脚本在 **停止 node 进程后** join，只要 `app.env` 已有 `VIBETERM_HUB_URL` 与 `VIBETERM_ROLES=node` 即视为成功，然后 start。Token 不重试。Enrollment 在 hub 上跑。

## 已知限制

- 不覆盖 RTC 直连中断回落。浏览器侧（密码登录、mesh 侧边栏、经 entry 打远端 node 终端、passkey 注册与登录）已由仓库内的 Playwright mesh 用例覆盖：`cd apps/fe && bun run scripts/run-e2e.ts --project mesh`（`--grep mesh` 等价），环境由 `apps/fe/tests/helpers/mesh-boot.ts` 在本机空闲端口上拉起「hub,node」+「node」两个源码实例，与本 docker 拓扑相互独立。
- `reach=lan` 含直连 WS 与 RTC，不能证明已经走 DataChannel。
- 场景 8 依赖容器内访问 npm registry；离线机预期 SKIP。
- 私有 CA，不是 Let's Encrypt；只适合封闭实测。
- 不测 macOS NAT node、IPv6 ICE、文件 bulk 直连。
- CLI 入口是 `bin/vibeterm.js`（`dist/cli-node.js` 只导出 `main`，直接运行没有任何输出且 rc=0）。认证子命令在容器里也可直接 `bun /opt/vibeterm/runtime/cli-auth.js`。
- `hub join` 在无服务管理器的容器里：旧版本写完 `app.env` 后 restart 报错非零；当前版本已改为提示后 exit 0，并支持 `--no-restart`。`writeEnvFile` 现已正确写入 symlink 指向的真实文件。

curl 走 `--cacert`（curl 不认 `NODE_EXTRA_CA_CERTS`）。

## 分体拓扑：远端 hub × 本地 NAT node

单机 compose 把 hub 与 node 关在同一 Docker 引擎里；分体拓扑把 **hub 放到公网机**，**node 放在本机 Docker 的出站 NAT 网桥**，跨互联网做 enroll / join / relay / LAN / hub 宕机 / DataChannel。脚本只新增 `scripts/hub-e2e/split/`，复用同一 `Dockerfile`、`entrypoint.sh` 和 `driver/*.ts`。镜像标签 **`vibeterm-e2e:split`**，不要改写 `vibeterm-e2e:latest`（单机 harness 占用）。

远端可以是有域名 + Let's Encrypt 的公网机，也可以是无域名、私有 CA、非 root ssh 用户的机器（见下方环境变量与示例）。

### 拓扑

```
  浏览器 / Playwright（本机）
           |
           | HTTPS :${VIBETERM_E2E_HUB_PORT}   （SNI = VIBETERM_E2E_HUB_HOST）
           v
  [远端 caddy] --reverse_proxy--> [远端 hub]  角色 hub,node
       0.0.0.0:PORT:443              0.0.0.0:39001:39001
                                           ^
                                           | 出站 WSS uplink
           +-------------------------------+
           |
  [本机 node-a]  bridge nat-a（无发布端口）
  [本机 node-b]  bridge nat-b（无发布端口）
  [本机 driver]  与 node-a 同网，extra_hosts 把域名指到公网 IP
           |
           +-- 场景 C 再 docker network connect lan
```

- 远端 compose 项目 `vibeterm-split`：`caddy` + `hub`。Let's Encrypt 模式证书在 `${VIBETERM_E2E_REMOTE_DIR}/certs/{fullchain,privkey}.pem`；private-ca 模式挂 `scripts/hub-e2e/ca/{hub.crt,hub.key,ca.crt}`。`VIBETERM_HUB_PUBLIC_URL` / `VIBETERM_BASE_URL` = `https://${VIBETERM_E2E_HUB_HOST}:${VIBETERM_E2E_HUB_PORT}`，`VIBETERM_TRUST_PROXY=true`，`VIBETERM_PEER_BIND_HOST=0.0.0.0`。
- 本机 compose 项目 `vibeterm-split-local`：`node-a` / `node-b` / `driver`。所有容器 `extra_hosts: ${VIBETERM_E2E_HUB_HOST}=${VIBETERM_E2E_HUB_IP}`（本机默认解析会给出 198.18.x.x 假 IP，不能靠宿主 DNS）。Let's Encrypt 走系统 CA；private-ca 把 `ca/ca.crt` 挂到 `/ca/ca.crt` 并设 `NODE_EXTRA_CA_CERTS=/ca/ca.crt`。
- **不要**占用远端 nginx 的 80/443。脚本不做端口探测；`split/run.sh` 开头打印：需放行入站 TCP `${VIBETERM_E2E_HUB_PORT}`（必需）与 TCP 39001（可选，含云安全组 / 面板防火墙 / ufw）。
- 远端可能同时跑单机项目 `vibeterm-e2e`（`127.0.0.1:18543`），两边互不 `down`。
- 远端起了一个 coturn 容器当外部 TURN：这套 harness 的拓扑是 `hub,node`，**hub 角色没有内置 TURN**，只认
  `VIBETERM_TURN_URL` / `_USERNAME` / `_CREDENTIAL` 三元组。2.3.0 起 `relay` / `relay,node` 角色的进程自带 TURN（端口默认
  UDP 3478 + 49160-49259，凭据自动生成），要测中继拓扑就不必再起 coturn，改成放行这两段 UDP，见
  [mesh 运维](../operations/mesh-operations.md)「中继内置 TURN 与多中继」。

### 运行

凭据与路径全部由环境变量提供，脚本内不含任何密钥。未列出的项使用脚本默认值（默认指向维护者自己的测试机，见下表；换机器时按表覆盖）。

| 变量 | 默认 | 作用 |
|---|---|---|
| `RSSH` | （必填） | 可执行文件，把参数当远端命令执行（如封装 `sshpass … ssh -p 10022 user@主机` 的脚本；建议内置对 255 的重试） |
| `RSYNC_SSH` | （必填） | `rsync -e` 用的 ssh 命令（同样可以是包装脚本） |
| `VIBETERM_TARBALL` | （必填，本机） | 本机构建镜像所用的 `vibeterm-cli-*.tgz` |
| `VIBETERM_E2E_SKIP_BUILD=1` | | 两侧已有 `vibeterm-e2e:split` 时跳过 build |
| `VIBETERM_E2E_STUN_SERVERS` | `stun:111.206.174.2:3478,stun:stun.miwifi.com:3478` | 下发给 mesh 的 STUN 列表（Google STUN 在境内两端均不可达） |
| `VIBETERM_E2E_HUB_HOST` | `ai.example.com` | 公网主机名 / SNI / Caddy site / extra_hosts / Playwright `--map-host` |
| `VIBETERM_E2E_HUB_IP` | `4.2.2.1` | 公网 IP；rsync/ssh 目标、extra_hosts、clock/UDP preflight、`.compose-bind.yml` 回退、`VIBETERM_E2E_TURN_EXTERNAL_IP` 默认 |
| `VIBETERM_E2E_HUB_PORT` | `18443` | 远端 Caddy 发布端口；拼进 `HUB_PUBLIC_URL` |
| `VIBETERM_HUB_PUBLIC_URL` | `https://${HOST}:${PORT}` | 覆盖拼好的公网 URL |
| `VIBETERM_E2E_REMOTE_USER` | `root` | rsync `user@ip`；非 root 时默认给远端 docker 加 `sudo` |
| `VIBETERM_E2E_REMOTE_DIR` | `/root/vibeterm-e2e` | 远端工作目录（harness、证书、远端 tarball） |
| `VIBETERM_E2E_REMOTE_SUDO` | 空；user≠root 时为 `sudo` | 加在每一条远端 `docker`/`compose` 前面 |
| `VIBETERM_E2E_REMOTE_TARBALL` | `${REMOTE_DIR}/vibeterm-cli-<version>.tgz` | 远端构建用的 tarball |
| `VIBETERM_E2E_TLS_MODE` | `letsencrypt` | `letsencrypt` 或 `private-ca` |
| `VIBETERM_E2E_TURN_EXTERNAL_IP` | `${VIBETERM_E2E_HUB_IP}` | coturn `--external-ip` |
| `VIBETERM_E2E_LAN_NETEM` | 空（不整形） | 非空则在 L 场景前对 node-a / node-b 的 `lan` 网卡执行 `tc qdisc add … netem <值>`（例：`delay 80ms rate 16mbit`），L 结束后及 EXIT 时 `tc qdisc del`。用容器在该网上的 IP 对 `ip -4 -o addr` 匹配网卡。L2 证据含 `tc qdisc show`。镜像需 `iproute2`，容器已有 `NET_ADMIN` |

```bash
RSSH=/path/to/rssh RSYNC_SSH=/path/to/ssh-wrap VIBETERM_TARBALL=/path/to/vibeterm-cli-<version>.tgz VIBETERM_E2E_SKIP_BUILD=1 \
  scripts/hub-e2e/split/run.sh

# 结束后拆掉两边（不动 vibeterm-e2e）
RSSH=… RSYNC_SSH=… VIBETERM_TARBALL=… scripts/hub-e2e/split/run.sh down
```

第二台机（无 DNS、私有 CA、`ubuntu` 用户、入站 UDP 开放）示例：

```bash
RSSH=/path/to/rssh RSYNC_SSH=/path/to/ssh-wrap VIBETERM_TARBALL=/path/to/vibeterm-cli-<version>.tgz VIBETERM_E2E_SKIP_BUILD=1 \
  VIBETERM_E2E_HUB_HOST=hub.vibeterm.test \
  VIBETERM_E2E_HUB_IP=<公网 IP> \
  VIBETERM_E2E_REMOTE_USER=ubuntu \
  VIBETERM_E2E_REMOTE_DIR=/home/ubuntu/vibeterm-e2e \
  VIBETERM_E2E_TLS_MODE=private-ca \
  scripts/hub-e2e/split/run.sh

# 可选：给 LAN DC 加 WAN 式延迟/限速，让 L4/L5/L7 走接近 TURN 的流控（两端同时整形，RTT 约为 2×delay）
VIBETERM_E2E_LAN_NETEM="delay 80ms rate 16mbit" \
  RSSH=… RSYNC_SSH=… VIBETERM_TARBALL=… scripts/hub-e2e/split/run.sh
```

`hub.vibeterm.test` 已在 `scripts/hub-e2e/ca/hub.crt` 的 SAN 里。若 `VIBETERM_E2E_HUB_HOST` 不在 SAN 中，`run.sh` 会用现有 CA 重签叶子证书。private-ca 会 rsync `ca/` 到远端，给 hub/node-a/node-b/driver 挂 `NODE_EXTRA_CA_CERTS=/ca/ca.crt`，`curl_hub` 加 `--cacert`。场景 F 在该模式下传 `--insecure-tls`（Playwright `ignoreHTTPSErrors: true`），TLS 断言弱于 Let's Encrypt。

要点：

- 本机镜像按**原生架构**构建（Apple Silicon → `linux/arm64`，不走 qemu；qemu 下 bun 偶发卡死导致假失败），`VIBETERM_E2E_PLATFORM` 可覆盖。`Dockerfile` 优先使用 `build/bun-linux-<arch>.zip`（本机预下载，目标机访问 github 不稳定）。
- 远端时钟：hub 校验 delegation 的 `issued_at` 容差 60s；脚本只检查本机↔远端时差并提示，不改远端时钟。远端应启用 NTP（`timedatectl set-ntp true`，境内可配 `ntp.aliyun.com`）。
- Let's Encrypt 由 webroot HTTP-01 签发：未知 host 会落到 aaPanel 默认站点根目录 `/www/server/nginx/html`，把 challenge 文件放进去即可，不改 nginx 配置。
- node-a / node-b 加了 `cap_add: [NET_ADMIN]`，供场景 H/I 与 LAN 变体 L4–L8 在容器内丢 UDP（只打断 ICE/DataChannel，TCP/WSS uplink 仍在）。镜像 apt 列表不含 `iptables`/`nftables`：脚本先探测 `iptables`，再 `nft`，再尝试运行时 `apt-get install iptables`，都没有则 `docker network disconnect/connect` node-a 的 `nat-a` 网桥（会连 uplink 一起抖一下，H2/L5 可能因此出现缺口）。可选 `VIBETERM_E2E_LAN_NETEM` 在 L 期间对 `lan` 网卡做 `tc netem` 整形（镜像 apt 含 `iproute2` 提供 `ip`/`tc`）；L1 会重启容器，脚本在重启后重新下发 qdisc。
- 文件 **bulk DataChannel**（label `bulk:<transferId>`，浏览器 `BulkClient`）不能用普通 `fetch` 打开；场景 I / L7–L8 只断言 `/n/<id>/api/files/raw` 的正确性与 UDP 丢包后的 REST 回落。REST 走 mesh 转发（dc/relay 载波），响应里没有「是否走了 bulk DC」的头。
- Caddyfile 是带 `__HUB_HOST__` / `__HUB_PORT__` 的模板；`setup-remote.sh` 渲染为 `Caddyfile.runtime` 再挂进 caddy。证书在容器内始终是 `/certs/fullchain.pem` + `/certs/privkey.pem`（compose 把 Let's Encrypt 或 `hub.crt`/`hub.key` 映射过去）。

`run.sh` 会 rsync `scripts/hub-e2e/` 到 `${VIBETERM_E2E_REMOTE_DIR}/repo/scripts/hub-e2e/`（排除 `out/` `build/`；Let's Encrypt 还排除 `ca/`，private-ca 会带上）。远端 `setup-remote.sh` 起 hub + caddy，本机 `setup-local.sh` 起 node-a / node-b / driver。enrollment 在远端 hub 容器里 `cli-auth.js enroll`（nohup），join 在本机 node 容器里 `hub join ${HUB_PUBLIC_URL} --no-restart`，然后重启容器。非 root 用户时远端 docker 命令带 `sudo`。

产物：`scripts/hub-e2e/split/out/report.md`、cookie、日志、Playwright 截图。

### 场景

执行顺序：A → B → C → E → **L（LAN DC）** → **D/H/I（hub WAN DC）** → F → G。E 放在任何 `direct enable` 之前，避免 native 安装污染重启断言。LAN 从 C 起一直连着，所以 L 紧跟 E。

| # | 断言 |
|---|---|
| A | 两 node 经公网 join；`/api/hub/nodes` online；hub 入口登录；node-a 终端经 hub relay 回环；node-b 文件 list/read 经 hub |
| B | node-a 作入口（`http://node-a:9883`）登录远端 hub 行（`isHub:true`）；在 hub 容器建 local device + tmux；终端 node-a → hub；记录 `reach`（relay 或经 39001 的 lan） |
| C | connect `lan`；90s 内 node-a 看 node-b `reach=lan`；LAN marker；远端 `docker stop hub` 后 node-a 仍达 node-b（终端 + 文件），`/api/mesh/nodes` 仍列出；`docker start hub` 后 120s 内两者 online，旧 cookie 有效 |
| E | `docker restart node-a` 重新 uplink、key/certs 仍在、能达 hub；远端 hub restart 后两 node 重连、无幽灵行 |
| L | **LAN DataChannel（node-a ↔ node-b）**，与 D/H/I 同一套断言，行号 L1–L8。L1 两端 `direct enable`（含 node-b）重启后 `direct_capable=true`；L2 `wait-transport dc`（若设置了 `VIBETERM_E2E_LAN_NETEM`，证据含两端 `tc qdisc show`）；L3 marker；L4–L6 丢 UDP 回落 relay、SEQ 连续、恢复 dc；L7–L8 在 node-b 上 8MiB sha256（dc 与 UDP drop REST 回落）。**计入 FAIL**。LAN 变体存在的原因：本环境里 node-a↔hub 的 DC 经常建不起来（hub VPS 过滤入站 UDP、node-a 在对称 NAT 后、libjuice 不支持 TURN over TCP），D2/D3 失败后 H/I 会被 SKIP，中断与 bulk 逻辑得不到验证。node-a 与 node-b 从 C 起共 `lan` 网，host ICE 走 UDP 直连，DC 可建；node-a 上 `OUTPUT -p udp DROP` 能切断 DC 而保住 TCP/WSS uplink。可选 `VIBETERM_E2E_LAN_NETEM`（如 `delay 80ms rate 16mbit`）在两端 lan 网卡上整形，让 L4/L5 中断与 L7 bulk 接近真实 TURN 路径的延迟/带宽 |
| D | **WAN DataChannel（node-a ↔ hub）**。D1 两端 `direct enable` 重启后 `direct_capable=true`；D2 从入口 node-a `wait-transport --transport dc`（90s，停在 relay 判 **FAIL** 不是 SKIP，证据含 `[mesh][rtc]` 摘录）；D3 在 `transport=dc` 后做 node-a→hub marker 回环，并把 `transport` 写入 `out/direct-path.json` |
| F | 本机 Playwright（`--map-host/--map-ip` 默认 `ai.example.com` / `4.2.2.1`）。Let's Encrypt：**不** `ignoreHTTPSErrors`。private-ca：传 `--insecure-tls`（F 的 TLS 断言更弱）。打开 `/login`，密码登录，侧栏见 node-a/node-b，node-a 终端打 marker；账号安全页虚拟 authenticator 注册 passkey，登出后再用 passkey 登录 |
| G | 根钥签 `revoke-node` 走 `POST /api/auth/keylog?hub=sync`；之后 node-b uplink 被拒、从入口不可达。做不到则 SKIP 并写原因 |
| H | 在 node-a↔hub `transport=dc` 时开终端流并跑 `SEQ_1..400`；中途只丢 UDP 打断 DataChannel。H1 30s 内回落 `relay`；H2 入口侧 WS 流 SEQ 连续无缺口；H3 清规则后 90s 内回到 `dc`。依赖 D2 |
| I | `transport=dc` 时在远端 hub 建 8MiB 随机文件，经入口 `/n/<hubId>/api/files/raw` 读回 sha256；再丢 UDP 后重读仍成功且哈希一致（REST 回落）。bulk DC 仅浏览器可用，见上文运行 notes。依赖 D2/H3 |

A–C、E、**L** 必须按各自规则计分：L1–L8 的 FAIL 计入总失败。D2 未达 `dc` 判 FAIL（不再因 relay SKIP）；H/I 依赖 D2，达不到则 SKIP。Hub 侧 D/H/I 在 UDP 被环境挡住时仍 FAIL 并留证据。F/G 允许 FAIL/SKIP，但要留证据。

### 清理

```bash
scripts/hub-e2e/split/run.sh down
# 等价于：
#   docker compose -p vibeterm-split-local -f scripts/hub-e2e/split/docker-compose.local.yml down -v
#   ssh 远端：${VIBETERM_E2E_REMOTE_SUDO} docker compose -p vibeterm-split -f ${VIBETERM_E2E_REMOTE_DIR}/repo/scripts/hub-e2e/split/docker-compose.remote.yml down -v
```

不删除 `vibeterm-e2e:split` 镜像（下次可 `VIBETERM_E2E_SKIP_BUILD=1`）。不碰本机生产 VibeTerm、不碰宿主机默认 socket 上的 tmux session。
