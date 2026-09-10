# 隧道边缘与 STUN 的 fake-IP 绕行

本文说明本机代理（Surge / Clash / Shadowrocket 等增强模式）把主机名解析成 fake-IP（`198.18.0.0/15`）时，VibeTerm 如何绕开：Cloudflare Tunnel 边缘改走真实 IP，以及 ICE 的 STUN/TURN 主机名在交给 libdatachannel 之前解析。面向「无边缘连接」或「直连全掉中继、没有 srflx」的运维。

## 背景

典型现象：远程访问卡片长期显示「无边缘连接」，cloudflared `/ready` 报 `readyConnections: 0`；其预检把 `region1/2.v2.argotunnel.com` 解析成 `198.18.x.x`（RFC 2544 段，本机代理的 fake-IP），QUIC / TCP 7844 均失败，而直连真实边缘 IP 的 7844 是通的。代理日志（Surge）会有 `[SGUDPForwarder] Unknown VIF virtual IP: 198.18.x.x:7844, client: cloudflared`——代理自己发出的 fake-IP 在其转发表里查不到，直接丢包。即使代理规则已含 `always-real-ip = *.argotunnel.com` 与 DIRECT，问题也可能出在代理侧缓存 / 状态，不是 VibeTerm 的 bug。

## 设计

- `apps/gateway/src/tunnel/edge-resolver.ts`：`isFakeIp`（198.18.0.0/15）、`isUnusableEdgeIp`（另滤私网/环回/CGNAT）、`resolveEdgeViaDoh`（DoH JSON 查 SRV `_v2-origintunneld._tcp.argotunnel.com` → 各 target 的 A；cloudflare-dns.com 失败回落 dns.google，SRV 失败回落 region1/region2:7844；本次解析记住成功端点并跳过已超时端点；单请求 5 s / 总预算 10 s）、`resolveEdge`（系统 lookup 见 fake-IP 才走 DoH；成功 `mode: 'static'`，失败 `mode: 'system'` + `lastError`；永不抛错）。`VIBETERM_TUNNEL_EDGE_ADDRS` 可显式覆盖。
- `provider.ts`：named / quick 拉起前解析一次，static 模式在 `run` 前插入 `--edge <ip:port>`（cloudflared `StaticEdge` 跳过 SRV 发现）；结果挂到 `SpawnHandle.edge` / `supervisor.edge`。
- `manager.ts`：`status().edge` 暴露 `TunnelEdgeResolution`；0 连接时 `connector_down` 与 `connectorHint` 追加 `edge DNS resolved to fake-IP 198.18.x (local proxy); static edge override active|failed: <err>`；连续 ≥ 90 s 报 0 连接且当前 `mode: 'system'` 时重解析并**只重启一次**（连接恢复后复位标志），带代次令牌，手动停止优先；重启时把已解析结果直接传给 provider，不依赖二次解析。外部托管的 cloudflared 不动。
- 前端 `tunnel-model.ts` `edgeDiagnosis(status)` 三档：`none`（旧后端/未检测到）、`bypassed`（已改走真实边缘）、`bypassFailed`（给出代理侧修法：`always-real-ip` 加 `*.argotunnel.com`、DIRECT 规则、清代理 DNS 缓存 / 重启代理、重启隧道）。

## 注意事项

- `--dns-resolver-addrs` 是 WARP 虚拟 DNS 服务，不是边缘发现，不能用来绕过 fake-IP。
- `--edge` 关闭 SRV 发现，只在检测到 fake-IP 时启用，正常环境行为不变。
- 静态边缘模式同时钉 `--protocol http2`：真实边缘 IP 下 HTTP/2 立即注册两条连接，而 QUIC（UDP 7844）仍会被代理吞掉，cloudflared `auto` 回落太慢。
- 只查 A 不查 AAAA，IPv6-only 网络会回落 system。

## 排查法

`curl 127.0.0.1:<metrics port>/ready`；`cloudflared tunnel --origincert <cert> info <id>`；`dig @198.18.0.2 region1.v2.argotunnel.com`（fake-IP 段即命中本文场景）；Surge 日志 grep `Unknown VIF`。

## STUN / TURN 与 fake-IP

同一套 fake-IP 也会打掉 WebRTC 直连。安装默认 STUN 是 `stun:stun.l.google.com:19302` 与 `stun:stun.cloudflare.com:3478`（`VIBETERM_STUN_SERVERS` 逗号分隔，`parseStunServers` 按逗号切开）。`node-datachannel` 0.33.1（libdatachannel）自己对主机名做 `getaddrinfo`，解析到 `198.18.x.x` 后 STUN Binding 进 TUN 被丢掉 → 只有 host 候选（局域网 `10.x` / `192.168.x`、TUN `198.18.0.1`、`utun`、Tailscale `100.x`；0.33.1 没有网卡过滤 API，见 [KI-3](../known-issues.md)）→ 跨 NAT 没有候选对 → 每条 peer 链路回落 mesh 中继。

### 解析器

`apps/gateway/src/mesh/rtc/stun-resolver.ts` 在 `buildRtcIceConfigResolved`（`connectToPeer` 建 ICE 配置时）里、把 URL 交给 libdatachannel **之前**解析每个 STUN/TURN 主机名：

1. 系统 `dns.lookup`；答案已是 IP 字面量的 URL 原样通过（IPv6 带方括号）。
2. 若答案是 fake-IP（复用 `isFakeIp`）或 lookup 失败，改走 `resolveHostnameViaDoh`（与隧道边缘相同的 cloudflare-dns / dns.google JSON DoH）。
3. 把真实 IP 写回 URL，保留端口与 `?transport=`；ICE `IceServer.hostname` 写无括号的 IP。
4. 按主机名缓存 10 分钟（失败缓存 60 秒），小 LRU；整次解析预算 2 秒。失败则退回原始 URL，行为不差于改之前。

成功时每主机名 10 分钟一条 info：

```
[mesh][rtc] stun resolve host=stun.l.google.com ip=74.125.x.x via=system|doh fake_ip=true|false ms=…
```

DoH 也失败时同格式一条 warn（`ip=-`）。`stunResolveSnapshot()` 供 gather 侧拼 `[mesh][rtc] gather summary` 字段。

浏览器 ICE 仍走 hub 下发的主机名列表（`GET /api/mesh/rtc-config`）；本解析只作用于节点侧 libdatachannel。

### 如何确认

- `GET /api/mesh/rtc-config`：应看到两条默认 STUN（或你配置的列表）。这是下发给浏览器的原始 URL，**不是**节点侧替换后的 IP。
- 节点日志：上面的 `stun resolve` 行，`via=doh fake_ip=true` 表示本机 DNS 落到了 fake-IP 并已绕开。
- 另一条 gather 诊断（`[mesh][rtc] gather summary` / ICE 失败时的 `local_types`）：跨 NAT 时应出现 `srflx`（或 TURN 的 `relay`）。只有 `[host]` 且对端不在同一局域网，仍是 STUN 不可达。
- 代理侧替代方案：让 UDP 3478 / 19302 走 DIRECT（Surge 示例：`AND, (DST-PORT, 3478), (PROTOCOL, UDP)` → DIRECT，19302 同理），并把 `always-real-ip` 加上 `stun.l.google.com`、`stun.cloudflare.com`。节点侧解析器不依赖这条规则，但浏览器 ICE 仍需要本机 UDP 出得去。
