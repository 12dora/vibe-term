# HTTPS 设置区的「对外有效 HTTPS」

## 背景

HTTPS 设置区原本只显示 `tls_config.mode` 与内置监听器状态。TLS 由 nginx / 宝塔 / Cloudflare Tunnel 终止时，mode 为 `none` 或 `external`、内置监听器停止，页面显示「关闭 / 未监听」，用户误以为 HTTPS 没生效。

## 判定

`GET /api/tls`（以及 `PUT /api/tls`、`POST /api/tls/renew` 的响应）增加：

```ts
https: { source: 'builtin' | 'reverse-proxy' | 'none'; verified: boolean; publicUrl: string | null }
```

按请求在 `tls-routes.ts` 里计算（`TlsService.status()` 保持与请求无关、可缓存）：

1. 内置监听器在运行 → `builtin`（verified=true）。
2. 当前请求经 `publicRequestUrl(req)` 解析为 https → `reverse-proxy`，verified=true。该函数只在 `TMEX_TRUST_PROXY` 开启且 `via = self` 时采信 `X-Forwarded-Proto/Host`，不直接读转发头。
3. 配置的公开地址（hub 取 `hubPublicUrl ?? hubUrl`，否则 `baseUrl`）为 https → `reverse-proxy`，verified=false（仅推断）。
4. 否则 `none`。

## 前端

状态块（2026-09-03 起标题为「HTTPS 设置」）固定三行：**对外访问**（内置 / 反向代理：已通过当前请求确认 | 按公开地址推断 / 未启用）、**配置模式**（`tls_config.mode`）、**内置监听器**（仅 `selfsigned` / `acme` 显示，运行中带端口 / 已停止 / 失败带原因）。对应 `data-testid`：`https-effective`、`https-current-mode`、`https-listener-state`。`mode = none` 但检测到反代 HTTPS 时提示切换到「外部反向代理」并开启「信任代理请求头」——否则 Cookie `Secure`、通行密钥 origin、公开地址都按 http 处理。旧节点不返回该字段时不渲染该行。

## 注意

- 仅显示与提示，不改变任何安全判定；Cookie / passkey 仍以 `publicRequestUrl` 为准。
- hub 既没配 https 公开地址又没开信任代理时会显示「未启用」，这是提醒运维补配置，不是误报。
- dns-01 的提供商选择（Cloudflare / DNSPod）与非标端口监听见 [ACME dns-01 提供商](./2026090303-acme-dns-providers.md)。
