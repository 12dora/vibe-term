# ACME dns-01 的 DNS 提供商抽象（Cloudflare / DNSPod）

## 背景

内置 Let's Encrypt 签发原本把 dns-01 写死成 Cloudflare。国内域名大量托管在 DNSPod，且很多 hub 的 80/443 已被别人的 nginx（宝塔等）占着，只能走 dns-01 + 非标端口监听。本轮把 dns-01 抽象成提供商接口，先落地 Cloudflare 与 DNSPod 两家。

## 接口

`packages/app/src/tls/dns-provider.ts`：

```ts
interface DnsProvider {
  readonly id: 'cloudflare' | 'dnspod';
  createTxt(creds, fqdn, value): Promise<{ recordId: string; zone?: string }>;
  deleteTxt(creds, ref): Promise<void>;
  getNameServers?(creds, zone): Promise<string[]>;
}
```

凭证形状：Cloudflare `{ token }`，DNSPod `{ id, token }`。Cloudflare 走原 `CloudflareDnsClient` 的适配器；DNSPod 是新的 `dnspod-dns.ts`。签发流程里的 TXT 传播等待（DoH 查询 + 权威 NS 复核）与提供商无关，没有改动。

## 凭证存储与迁移

迁移 `0037_acme_dns_provider` 给 `tls_config` 加两列：

- `acme_dns_provider text`（CHECK：null / `cloudflare` / `dnspod`）
- `acme_dns_secret_enc text`：加密后的凭证 JSON

读路径优先用新列；`acme_dns_secret_enc` 为空而旧列 `acme_cf_token_enc` 有值时，视为 `provider=cloudflare` + `{ token }`。写路径只写新列。

**没有做 SQL backfill**：密文没法在 SQL 里再包一层 JSON。存量 Cloudflare 用户靠上面的读回退继续工作，下一次经 store 保存时顺带补齐新列。与 0033–0036 一致，本迁移没有 drizzle snapshot（migrator 只读 journal + SQL）。

## HTTP 契约

`GET /api/tls`（`mode === 'acme'` 时 `acme` 非 null）：

```ts
acme.hasCloudflareToken: boolean            // 兼容旧前端，等价于 dns.provider==='cloudflare' && dns.hasCredentials
acme.dns: { provider: 'cloudflare' | 'dnspod' | null; hasCredentials: boolean }
```

dns-01 表单以 `acme.dns` 为准。

`PUT /api/tls` 的 acme 分支新增：

```ts
dnsProvider?: 'cloudflare' | 'dnspod'
dnsCredentials?: { token: string } | { id: string; token: string }
cloudflareToken?: string   // 旧字段，等价于 dnsProvider='cloudflare' + { token }
```

规则：

- `challenge: 'dns-01'` 必须能确定提供商——显式 `dnsProvider`、或只传 `cloudflareToken`、或沿用已存的 `acme.dns.provider`。
- 凭证可以省略，**当且仅当**同一提供商已有凭证。换提供商必须带新凭证。
- `dnsCredentials` 必须配 `dnsProvider`，形状不对 400。
- `http-01` 不强制 DNS 字段；带了也会落库。

400 错误码：

| code | 何时 |
| --- | --- |
| `cloudflare_token_required` | 旧路径：dns-01 且没传新字段，也没有已存的 Cloudflare 凭证 |
| `dns_provider_required` | 传了 `dnsCredentials` 但没有合法 `dnsProvider` |
| `dns_credentials_required` | 指定了提供商但没带凭证，且已存凭证不是同一提供商 / 形状不匹配 |

## DNSPod 实现要点

- 端点 `https://dnsapi.cn/<Method>`，`POST` + `application/x-www-form-urlencoded`，鉴权字段 `login_token=<ID>,<Token>`（旧版 API Token），`format=json`、`lang=en`。
- `User-Agent: tmex/<version> (<email>)`——DNSPod 要求带联系邮箱，这里用 ACME 账户邮箱。
- 用到的方法：`Domain.Info`（找 zone / 取 NS）、`Domain.List`（兜底枚举）、`Record.Create`、`Record.Remove`。
- zone 推断：从 `_acme-challenge.<fqdn>` 逐级去掉左侧标签试 `Domain.Info`，全部失败再用 `Domain.List` 里已拥有的域名匹配。
- 建 TXT 记录时同时带 `record_line_id=0` 与 `record_line=默认`，`ttl=600`；部分账号只认其中一个。
- 响应 `status.code` 不是 `"1"` 一律当失败，错误信息拼成 `<code>: <message>` 抛出。

## 场景：hub 的 80/443 被别人的 nginx 占着

典型情形是宝塔面板上还跑着别的站点，443 让不出来，而域名托管在 DNSPod。配置方式：

1. 设置 → 节点 → HTTPS 设置：模式 **Let's Encrypt**，域名填 hub 的公开域名，验证方式 **DNS-01**，提供商 **DNSPod**，填 ID + Token；内置监听 `0.0.0.0`，端口 `9443`（`tls_config.tls_port` 默认值）。dns-01 完全不碰 80，不需要 nginx 配合。
2. 签发成功后 `https://<域名>:9443` 即为内置监听器直出的 HTTPS 入口。
3. 把 hub 公开地址（`TMEX_HUB_PUBLIC_URL`）改成这个带端口的地址并重启；各节点通过 hub 列表刷新到新地址。此时流量不再经反代，`TMEX_TRUST_PROXY` 应关掉。
4. 面板侧只拆该域名的 vhost / 证书目录，全局续期 cron 不动。

**通行密钥按 origin 注册**：端口变了就是新 origin。旧地址上注册过的 passkey 在新地址不可用，需要先从局域网 / localhost 登录后在新地址补注册。

## 注意

- 证书续期仍是 12 小时检查一次、提前 30 天续；续期时复用已存的提供商与凭证，不会回退到 Cloudflare。
- 再次保存同一提供商时不要把空凭证提交上去（省略键即可），否则会被判成「换提供商但没给凭证」。
