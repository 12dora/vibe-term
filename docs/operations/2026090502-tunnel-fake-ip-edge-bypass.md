# 隧道边缘 fake-IP 绕行（1.1.31）

## 背景

本机（macOS + Surge 增强模式）远程访问卡片长期显示「无边缘连接」。只读排查：cloudflared `/ready` 报 `readyConnections: 0`；其预检把 `region1/2.v2.argotunnel.com` 解析成 `198.18.91.209 / 198.18.92.12`（RFC 2544 段，Surge fake-IP），QUIC / TCP 7844 均失败；直连真实边缘 `198.41.192.7:7844` 通。Surge 日志自网络切换后持续报 `[SGUDPForwarder] Unknown VIF virtual IP: 198.18.91.209:7844, client: cloudflared`——代理自己发出的 fake-IP 在其转发表里查不到，直接丢包。用户配置已含 `always-real-ip = *.argotunnel.com` 与 DIRECT 规则，问题出在代理侧缓存/状态，不是规则缺失，也不是 tmex 代码 bug。

## 设计

- `apps/gateway/src/tunnel/edge-resolver.ts`：`isFakeIp`（198.18.0.0/15）、`isUnusableEdgeIp`（另滤私网/环回/CGNAT）、`resolveEdgeViaDoh`（DoH JSON 查 SRV `_v2-origintunneld._tcp.argotunnel.com` → 各 target 的 A；cloudflare-dns.com 失败回落 dns.google，SRV 失败回落 region1/region2:7844；本次解析记住成功端点并跳过已超时端点；单请求 5 s / 总预算 10 s）、`resolveEdge`（系统 lookup 见 fake-IP 才走 DoH；成功 `mode: 'static'`，失败 `mode: 'system'` + `lastError`；永不抛错）。`TMEX_TUNNEL_EDGE_ADDRS` 可显式覆盖。
- `provider.ts`：named / quick 拉起前解析一次，static 模式在 `run` 前插入 `--edge <ip:port>`（cloudflared `StaticEdge` 跳过 SRV 发现）；结果挂到 `SpawnHandle.edge` / `supervisor.edge`。
- `manager.ts`：`status().edge` 暴露 `TunnelEdgeResolution`；0 连接时 `connector_down` 与 `connectorHint` 追加 `edge DNS resolved to fake-IP 198.18.x (local proxy); static edge override active|failed: <err>`；连续 ≥ 90 s 报 0 连接且当前 `mode: 'system'` 时重解析并**只重启一次**（连接恢复后复位标志），带代次令牌，手动停止优先；重启时把已解析结果直接传给 provider，不依赖二次解析。外部托管的 cloudflared 不动。
- 前端 `tunnel-model.ts` `edgeDiagnosis(status)` 三档：`none`（旧后端/未检测到）、`bypassed`（已改走真实边缘）、`bypassFailed`（给出代理侧修法：`always-real-ip` 加 `*.argotunnel.com`、DIRECT 规则、清代理 DNS 缓存 / 重启代理、重启隧道）。

## 注意事项

- `--dns-resolver-addrs` 是 WARP 虚拟 DNS 服务，不是边缘发现，不能用来绕过 fake-IP。
- `--edge` 关闭 SRV 发现，只在检测到 fake-IP 时启用，正常环境行为不变。
- 只查 A 不查 AAAA，IPv6-only 网络会回落 system。

## 排查法

`curl 127.0.0.1:<metrics port>/ready`；`cloudflared tunnel --origincert <cert> info <id>`；`dig @198.18.0.2 region1.v2.argotunnel.com`（fake-IP 段即命中本文场景）；Surge 日志 grep `Unknown VIF`。
