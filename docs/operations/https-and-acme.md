# HTTPS：对外有效状态、ACME dns-01 提供商与 80/443 被占场景

本文描述设置页 HTTPS 区的「对外有效 HTTPS」判定、内置 Let's Encrypt 签发的 dns-01 提供商抽象（Cloudflare / DNSPod），以及 hub 的 80/443 被别的服务占用时的配置方法；面向运维与改动 `packages/app/src/tls/` 的开发者。非标端口的整体部署形态见 [非标端口部署](./nonstandard-ports.md)。

## 1. 对外有效 HTTPS 的判定与展示

TLS 由 nginx / 宝塔 / Cloudflare Tunnel 终止时，`tls_config.mode` 为 `none` 或 `external`、内置监听器停止，只看 mode 会让用户误以为 HTTPS 没生效。为此 `GET /api/tls`（以及 `PUT /api/tls`、`POST /api/tls/renew` 的响应）带：

```ts
https: { source: 'builtin' | 'reverse-proxy' | 'none'; verified: boolean; publicUrl: string | null }
```

按请求在 `tls-routes.ts` 里计算（`TlsService.status()` 保持与请求无关、可缓存）：

1. 内置监听器在运行 → `builtin`（verified=true）。
2. 当前请求经 `publicRequestUrl(req)` 解析为 https → `reverse-proxy`，verified=true。该函数只在 `VIBETERM_TRUST_PROXY` 开启且 `via = self` 时采信 `X-Forwarded-Proto/Host`。
3. 配置的公开地址（hub 取 `hubPublicUrl ?? hubUrl`，否则 `baseUrl`）为 https → `reverse-proxy`，verified=false（仅推断）。
4. 否则 `none`。

前端「HTTPS 设置」状态块固定三行：**对外访问**（内置 / 反向代理：已通过当前请求确认 | 按公开地址推断 / 未启用）、**配置模式**（`tls_config.mode`）、**内置监听器**（仅 `selfsigned` / `acme` 显示，运行中带端口 / 已停止 / 失败带原因）。`data-testid`：`https-effective`、`https-current-mode`、`https-listener-state`。`mode = none` 但检测到反代 HTTPS 时提示切换到「外部反向代理」并开启「信任代理请求头」——否则 Cookie `Secure`、通行密钥 origin、公开地址都按 http 处理。旧节点不返回该字段时不渲染该行。

这只是显示与提示，不改变任何安全判定；Cookie / passkey 仍以 `publicRequestUrl` 为准。hub 既没配 https 公开地址又没开信任代理时显示「未启用」，是提醒运维补配置。

内置监听器运行时给出的对外地址：**配置了公网地址（`VIBETERM_HUB_PUBLIC_URL` / `VIBETERM_RELAY_PUBLIC_URL`）就原样显示它**——监听端口是本机内部的，NAT / 端口转发进来的公网端口往往并不相同。只有在完全不知道对外地址时，才用证书域名（ACME 域名或可对外解析的 SAN）加监听端口拼一个。

## 2. ACME dns-01 的 DNS 提供商抽象

dns-01 不写死 Cloudflare：国内域名大量托管在 DNSPod，且很多 hub 的 80/443 已被别的 nginx 占着，只能走 dns-01 + 非标端口监听。

### 接口

`packages/app/src/tls/dns-provider.ts`：

```ts
interface DnsProvider {
  readonly id: 'cloudflare' | 'dnspod';
  createTxt(creds, fqdn, value): Promise<{ recordId: string; zone?: string }>;
  deleteTxt(creds, ref): Promise<void>;
  getNameServers?(creds, zone): Promise<string[]>;
}
```

凭证形状：Cloudflare `{ token }`，DNSPod `{ id, token }`。Cloudflare 走 `CloudflareDnsClient` 的适配器；DNSPod 在 `dnspod-dns.ts`。签发流程里的 TXT 传播等待（DoH 查询 + 权威 NS 复核）与提供商无关。

### 凭证存储

`tls_config` 有两列（迁移 `0037_acme_dns_provider`）：`acme_dns_provider text`（CHECK：null / `cloudflare` / `dnspod`）与 `acme_dns_secret_enc text`（加密后的凭证 JSON）。读路径优先用新列；`acme_dns_secret_enc` 为空而旧列 `acme_cf_token_enc` 有值时，视为 `provider=cloudflare` + `{ token }`。写路径只写新列。没有 SQL backfill（密文没法在 SQL 里再包一层 JSON），存量 Cloudflare 用户靠读回退继续工作，下一次经 store 保存时顺带补齐。

### HTTP 契约

`GET /api/tls`（`mode === 'acme'` 时 `acme` 非 null）：

```ts
acme.hasCloudflareToken: boolean            // 兼容旧前端，等价于 dns.provider==='cloudflare' && dns.hasCredentials
acme.dns: { provider: 'cloudflare' | 'dnspod' | null; hasCredentials: boolean }
```

`PUT /api/tls` 的 acme 分支：

```ts
dnsProvider?: 'cloudflare' | 'dnspod'
dnsCredentials?: { token: string } | { id: string; token: string }
cloudflareToken?: string   // 旧字段，等价于 dnsProvider='cloudflare' + { token }
```

规则：

- `challenge: 'dns-01'` 必须能确定提供商——显式 `dnsProvider`、或只传 `cloudflareToken`、或沿用已存的 `acme.dns.provider`。
- 凭证可以省略，**当且仅当**同一提供商已有凭证。换提供商必须带新凭证。再次保存同一提供商时不要把空凭证提交上去（省略键即可），否则会被判成「换提供商但没给凭证」。
- `dnsCredentials` 必须配 `dnsProvider`，形状不对 400。
- `http-01` 不强制 DNS 字段；带了也会落库。

400 错误码：

| code | 何时 |
| --- | --- |
| `cloudflare_token_required` | 旧路径：dns-01 且没传新字段，也没有已存的 Cloudflare 凭证 |
| `dns_provider_required` | 传了 `dnsCredentials` 但没有合法 `dnsProvider` |
| `dns_credentials_required` | 指定了提供商但没带凭证，且已存凭证不是同一提供商 / 形状不匹配 |

### DNSPod 实现要点

- 端点 `https://dnsapi.cn/<Method>`，`POST` + `application/x-www-form-urlencoded`，鉴权字段 `login_token=<ID>,<Token>`，`format=json`、`lang=en`。
- `User-Agent: vibeterm/<version> (<email>)`——DNSPod 要求带联系邮箱，用 ACME 账户邮箱。
- 用到的方法：`Domain.Info`（找 zone / 取 NS）、`Domain.List`（兜底枚举）、`Record.Create`、`Record.Remove`。
- zone 推断：从 `_acme-challenge.<fqdn>` 逐级去掉左侧标签试 `Domain.Info`，全部失败再用 `Domain.List` 里已拥有的域名匹配。
- 建 TXT 记录时同时带 `record_line_id=0` 与 `record_line=默认`，`ttl=600`；部分账号只认其中一个。
- 响应 `status.code` 不是 `"1"` 一律当失败，错误信息拼成 `<code>: <message>` 抛出。

证书续期仍是 12 小时检查一次、提前 30 天续；续期时复用已存的提供商与凭证，不会回退到 Cloudflare。

## 3. 场景：hub 的 80/443 被别人的 nginx 占着

典型情形是宝塔面板上还跑着别的站点，443 让不出来，而域名托管在 DNSPod：

1. 设置 → 节点 → HTTPS 设置：模式 **Let's Encrypt**，域名填 hub 的公开域名，验证方式 **DNS-01**，提供商 **DNSPod**，填 ID + Token；内置监听 `0.0.0.0`，端口 `9443`（`tls_config.tls_port` 默认值）。dns-01 完全不碰 80，不需要 nginx 配合。
2. 签发成功后 `https://<域名>:9443` 即为内置监听器直出的 HTTPS 入口。
3. 把 hub 公开地址（`VIBETERM_HUB_PUBLIC_URL`）改成这个带端口的地址并重启；各节点通过 hub 列表刷新到新地址。此时流量不再经反代，`VIBETERM_TRUST_PROXY` 应关掉。
4. 面板侧只拆该域名的 vhost / 证书目录，全局续期 cron 不动。

**通行密钥按 origin 注册**：端口变了就是新 origin。旧地址上注册过的 passkey 在新地址不可用，需要先从局域网 / localhost 登录后在新地址补注册（见 [登录面安全](../security/login-security.md)）。
