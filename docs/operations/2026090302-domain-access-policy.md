# 按节点的「允许域名访问」开关

## 背景

节点加入 mesh 后，入口 hub 的公开域名会把流量转发到各节点；同时节点自己也可能被配置成公开域名（tunnel、反代、自签公开地址）。有些机器只希望在局域网里被人用，公网域名只用来跑 mesh 自身的服务流量。本轮给每个节点加一个开关：关掉之后，**经公开域名进来的用户流量**被拒，局域网 IP / localhost / `.local` 与 mesh 服务路由照常。

默认 `allowed = true`，不开启就没有任何行为变化。

## 数据与生效点

- 存储：`node_access_policy` 单行（迁移 `0038_node_access_policy`，`id` 恒为 1，`allow_domain_access` 默认 1）。`DomainAccessStore` 懒建行、内存缓存、支持 `onChange`。
- 拦截：`packages/app/src/runtime/assemble.ts` 的 `createHttpDispatch` 在 `guardEntryAccess(req)` 之后立即调 `guardDomainAccess(req)`。`allowed` 为真时是快路径，不做任何主机名计算。
- 判定只对 `via = self`（本机 Bun socket 直接收到的请求）生效；peer 入站（`via = <nodeId>`，即经 hub / 其它节点转发进来的请求）永远放行，`viaDomain` 恒为 `false`。

## 拦截规则

关闭后，`via=self`、路径不在服务白名单、且**客户端源地址不是本机/内网**的请求一律拒绝（判定不看 Host，Host 可被任意伪造）：

| 路径 | 响应 |
| --- | --- |
| `/api/*`、`/n/:id/api/*` | `403` JSON `{ error: { code: 'DOMAIN_ACCESS_DISABLED', message: 'Access through this domain is disabled for this node.' } }` |
| `/ws`、`/n/:id/ws`、`/mesh/ws` | 同上 JSON 403（在 upgrade 之前拒绝） |
| 其它（SPA、静态资源…） | `403` `text/plain`：`Domain access is disabled for this host.` |

**源地址豁免**（这些来源即使带着域名 Host 也照常可用）：loopback、RFC1918 私网、链路本地、CGNAT `100.64/10`（Tailscale）、IPv6 ULA / 链路本地 / loopback，以及它们的 IPv4-mapped 写法。源地址取自 `client-ip.ts`：默认是 socket 对端地址；`TMEX_TRUST_PROXY` 开启时按 `cf-connecting-ip → x-real-ip → XFF 最后一段`。解析不出源地址时按公网处理（fail closed）。**反向代理部署必须开启信任代理头**，否则判定的是代理自身的 socket 地址（通常是私网，会误放行）。

**服务白名单**（公网仍可访问）：`/hub/uplink`、`/healthz`、`/.well-known/acme-challenge/*`、`POST /api/hub/enrollments/redeem`、`GET /api/hub/status`、`GET /api/hub/enrollments/:id`。所以 uplink、健康检查、ACME 续期与加入码兑换不会被这个开关打断。peer 入站（`via=<nodeId>`）不经过这个守卫。

### `hosts` 与 `viaDomain`（仅供界面提示）

`listDomainAccessHosts()` 汇总：`TMEX_BASE_URL`（`config.baseUrl`）、数据库里的 `site_settings.site_url` 与 mesh 投影后的有效地址（两者都算）、hub 角色下的 `TMEX_HUB_PUBLIC_URL` 与本机在 `mesh_hubs` 里的 `public_url`、`tunnel_config.hostname`、运行中隧道的 `publicUrl`。**不含** `TMEX_HUB_URL`（那是远端 hub），也不读证书 SAN。规范化后小写、去尾点、剥默认端口；IP 字面量、`localhost`、`*.local` 不进集合。

`viaDomain` = 当前请求的有效 URL（`publicRequestUrl(req)`，仅在 `TMEX_TRUST_PROXY` 且 `via=self` 时采信 `X-Forwarded-Host`）命中 `hosts`。它只用来在关开关时提醒「你正经域名访问，关闭后会失联」，不参与拦截。

## API

`GET /api/system/domain-access` / `PATCH /api/system/domain-access`（body `{ allowed: boolean }`），返回同一形状：

```ts
{ allowed: boolean; viaDomain: boolean; hosts: string[] }
```

路由挂在 `/api/system/*` 兜底之前，因此 hub 可以用 `/n/<id>/api/system/domain-access` 读写**远端节点**的策略——这条是 peer 入站路径，不受本策略拦截。

`GET /api/local/status` 也带上同形状的 `domainAccess`（本机卡片用）。`/api/local/*` 不经 peer 入站，只能本机读。

`viaDomain` 只在入口节点自己的请求上有意义：它表示「你现在这个页面就是经域名进来的」。

## 界面

- **本机**：设置 → 节点 → 本机卡片底部「通用设置」行的开关。关闭前弹确认框；当前会话本身 `viaDomain` 为真时给强警告（关掉就会把自己关在门外）。
- **远端节点**：节点管理表格行「更多」→ 节点详情弹窗，里面的允许域名访问开关走 `/n/<id>/api/system/domain-access`，带 dirty 比较，只提交改动过的项。

## 把自己关在门外了怎么办

从公开域名本身关不掉（设置接口是用户流量，会 403）。恢复途径二选一：

1. 用局域网 IP / `localhost` 直接访问该机器的网关端口，打开设置页把开关打回来；
2. 从 hub 侧节点管理进该节点的详情弹窗改（走 `/n/<id>` 转发，不受拦截）。

## 已知限制

- **已建立的 WebSocket 不会被踢**：`MeshHttpRuntime` / `SessionRegistry` 不记录握手时的 Host，无法只关掉「经域名进来」的那批 socket。关闭后**新握手**立即被拒，已连着的域名会话要等它自己断开。store 的 `onChange` 目前没有被订阅来做这件事。
- 判定基于 Host，不做证书 SAN 推断；用别名域名访问且该别名没出现在上述来源里时不会被拦。
