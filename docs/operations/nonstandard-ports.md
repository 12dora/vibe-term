# 非标端口部署（80/443 不可用时）

本文说明把 Hub / 中继架在 443 以外端口时谁绑公网端口、内置候选端口表、地址没写端口时的探测行为与安装期选端口；面向家宽被封 80/443、云厂商拦截或端口被别的服务占用的运维。首发版本 **1.1.37**。

## 背景

VibeTerm 的数据面本来就是端口透明的：`canonicalHubUrl` / `normalizeRelayUrl` 只抹掉协议默认端口，
非默认端口原样保留；uplink 认证签名绑的是含端口的 `URL.host`；`r3.` 加入串内嵌每台中继的完整地址；
分享地址、站点地址、域名访问白名单也都按 `URL.origin` 处理。把 Hub / 中继架在 13443 这类高位端口，
协议层面不需要任何改动。

真正的缺口只在人机层：以前没有端口建议，也没有「地址没写端口时替你找」的能力——
输入 `https://relay.example.com` 只会去试 443，失败后报一句「中继不健康」。1.1.37 补上了这两件事。

## 谁绑公网端口

先分清是哪一种部署形态：改错了地方端口就是不通。

| 形态 | 谁监听公网端口 | 换高位端口要改什么 |
|---|---|---|
| 反向代理在前（nginx / Caddy / 宝塔） | 代理 | 改代理站点的 `listen` 端口；VibeTerm 仍留在回环 `GATEWAY_PORT`；保持 `VIBETERM_TRUST_PROXY=true`；把端口写进 `VIBETERM_HUB_PUBLIC_URL` / `VIBETERM_RELAY_PUBLIC_URL` / 站点地址 |
| VibeTerm 自带 HTTPS 监听器 | VibeTerm（`HttpsListener`） | 设置 → 节点 → HTTPS 改端口（默认 9443，也可 `PUT /api/tls`）；证书走 **ACME dns-01**（http-01 需要 80 端口，这里用不了）；`VIBETERM_TRUST_PROXY` 必须关 |
| 纯 HTTP 直接暴露（`VIBETERM_BIND_HOST=0.0.0.0`） | VibeTerm gateway | 改 `app.env` 的 `GATEWAY_PORT`（或 `vibeterm init --port`）。没有 TLS，只适合内网或隧道后面 |
| Cloudflare Tunnel | Cloudflare 边缘（443） | 边缘端口不可改，与本文无关；连接器只需要出站 7844 |
| Cloudflare 橙云代理自己的服务器 | 代理或 VibeTerm 的 HTTPS 监听器 | 端口**必须**是 `2053 / 2083 / 2087 / 2096 / 8443` 之一，这也是内置候选表把它们排在前面的原因 |
| Docker 节点 | 宿主的端口映射 | 改 `-p <宿主端口>:9883`，容器内仍是 9883 / 39001 |

低于 1024 的端口需要 root，Linux 用户级 systemd 服务绑不上，一律不要选。

## 内置候选端口

`packages/shared/src/net/port-candidates.ts`：

```
SUGGESTED_HIGH_PORTS = [2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443]
```

- 前五个是 Cloudflare 橙云代理 HTTPS 时放行的全部非 443 端口。选它们的好处是以后要套 CDN 不必再迁一次端口。
- 后三个 IANA 未分配，好记（`…443` 后缀），且落在 10000–32767：既高于常见扫描面，也低于 Linux 默认临时端口起点 32768，
  不会出现「重启后内核先把这个端口分给了一条出站连接」导致的偶发 `EADDRINUSE`。
- `41443` / `52443` 一类的端口刻意不收：它们落在 Linux（32768–60999）与 macOS/Windows（49152–65535）的临时端口区间内。

设置向导与 `vibeterm init` 的「建议端口」从这张表里随机取一个，并避开本机已占用的 `GATEWAY_PORT` / `VIBETERM_PEER_PORT` / TLS 监听端口。

## 探测行为

地址写了端口就只按那个端口确认一次，**绝不会被静默改到别的端口**。地址没写端口时才探测：

1. 先发 443，给约 800 ms 的先手窗口——绝大多数部署在这一步就结束了；
2. 443 还没答话，就按约 150 ms 的间隔逐个发出八个候选端口，443 仍在跑，晚到也算数；
3. 谁先答话谁赢，其余请求立即中止；每次请求各带 4 s 超时，`redirect: 'error'`；
4. 中继探 `GET /api/relay/health`（要求 `ok === true`），Hub 探 `GET /healthz`（要求 `status === 'ok'`），两条路径都免鉴权、也不受域名访问白名单与 Cloudflare Access 拦截；判据必须与目标形态一致，否则会「探到」一台不是中继的机器；
5. 一个都不答话时报「443 及内置候选端口均无响应」，并列出探过的端口。

回环地址（`localhost` / `127.0.0.1` / `[::1]`）与 http 地址不参与候选扫描，只确认本身那个端口。
显式端口按**用户原始输入**判断：`canonicalHubUrl` 会抹掉 `:443`，先归一化再判就会把明确写下的 443
当成「没写端口」，从而静默改接到别的端口——CLI 与服务端都在归一化之前取这个判断。

`relay,node` 机器上填自己中继的主机名且没写端口时不做候选扫描：回环 gateway 什么端口都答话，
443 必然抢先胜出，而随后的 enroll 按精确 host（含端口）比对并不会走回环，会打到错误的公网端口。
这种情况地址是已知的（就是 `VIBETERM_RELAY_PUBLIC_URL`），只在回环上确认一次。

浏览器**不做**跨域探测：网页表单调本机 gateway 的接口，由 Bun 进程去探。相关接口：

- `POST /api/setup/precheck`（接入向导）：返回值多了 `resolvedUrl` / `triedPorts` / `probed`；
  请求可带 `kind: 'hub' | 'relay'`（缺省 `hub`），决定探测与确认用哪套健康判据——
  加入中继的表单必须带 `kind: 'relay'`，否则 443 被封时可能选中一台恰好占着候选端口的 Hub；
- `POST /api/mesh/relay/resolve`（中继接入 / 追加 / 迁移，node-session 鉴权）：`{ url }` → `{ url, port, explicit, triedPorts }`。
  必须在 `POST /api/mesh/relay/enroll/proof-material` **之前**调用——enroll proof 签的是含端口的 host，端口定晚了签名直接作废。

CLI 同样行为：`vibeterm relay enroll <url>`、`vibeterm relay join <url> --tenant …`、`vibeterm hub join <url>` 在地址没写端口时探测，
命中打印「已在 13443 端口探测到中继，使用 https://relay.example.com:13443」。`--insecure-local` 与回环地址跳过探测。

HTTPS 卡片上对外地址的显示规则见 [HTTPS 与 ACME](./https-and-acme.md)。

## 安装时选端口

`vibeterm init` 在问公网地址之前多问一句「公网 HTTPS 端口」，默认 443，括号里给一个避开本机端口的建议值。
选了非 443 且随后填的地址没带端口时，自动补成 `https://<host>:<port>` 再做校验。
非交互用 `--public-port <n>`：它只在 `--hub-public-url` / `--relay-public-url` 自己没写端口时生效。

Hub 公网地址这一轮起与中继同规则：必须是 https（回环允许 http），否则当场重问，不再放行写坏的地址。

## 防火墙与证书

- 云厂商安全组 / 宝塔面板防火墙 / `ufw` 都要显式放行选定的 TCP 端口；只改 VibeTerm 配置不改防火墙是最常见的失败原因。
- 直连（WebRTC）另需放行 `VIBETERM_PEER_PORT`（默认 39001），它与公网 HTTPS 端口无关。
- 用 VibeTerm 自带 HTTPS 监听器时，证书必须走 ACME **dns-01**（Cloudflare / DNSPod，见
  [HTTPS 与 ACME](./https-and-acme.md)）：http-01 需要 80 端口可达，封了 80 就签不下来。
- 端口映射功能不会占用 TLS 监听端口（保留端口集合含 `GATEWAY_PORT`、`VIBETERM_PEER_PORT` 与当前 `tls_port`）。
