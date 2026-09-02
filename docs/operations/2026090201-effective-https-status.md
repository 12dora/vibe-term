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

状态头新增「对外 HTTPS」一行：内置 / 反向代理（已通过当前请求确认 | 按公开地址推断）/ 未启用；原「监听」行改为「内置监听器：…」，与对外状态区分。`mode = none` 但检测到反代 HTTPS 时提示切换到「外部反向代理」并开启「信任代理请求头」——否则 Cookie `Secure`、通行密钥 origin、公开地址都按 http 处理。旧节点不返回该字段时不渲染该行。

## 注意

- 仅显示与提示，不改变任何安全判定；Cookie / passkey 仍以 `publicRequestUrl` 为准。
- hub 既没配 https 公开地址又没开信任代理时会显示「未启用」，这是提醒运维补配置，不是误报。
