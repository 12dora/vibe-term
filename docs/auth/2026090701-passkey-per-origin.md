# 通行密钥二次验证改为按 origin 生效

## 背景

密码登录（`delegation.method === 'root'`）在账户注册过通行密钥后必须再过一次 WebAuthn 断言。此前
这条策略看的是「名下**任意** origin 有没有通行密钥」：

```ts
// apps/gateway/src/db/local-auth-http.ts（改前）
passkeySecondFactor: keys.length > 0 && !waived;
```

而断言本身只能在注册它的 origin 上完成——`POST /api/auth/passkey/login/options` 按**精确 origin**
过滤凭证，一把都没有就回 404 `NO_PASSKEY_FOR_ORIGIN`。

两条口径不一致，换入口地址就会锁死：用户先在中继域名下注册通行密钥，之后改用 Cloudflare 隧道
域名访问，则

- 二次验证仍然要求（名下有钥匙）；
- 当前 origin 拿不出任何凭证，仪式永远做不完；
- 本机豁免也不成立（`cf-connecting-ip` 在 `client-source.ts` 里一票否决）。

结果是密码正确、TOTP 正确，仍然 `PASSKEY_REQUIRED` / `NO_PASSKEY_FOR_ORIGIN`，只能靠 SSH 上机或
`hub user passwd --full-reset` 这类过重手段自救。

## 策略变更

判定口径统一到「**当前 origin** 拿得出凭证吗」，与 `handlePasskeyLoginOptions` 完全一致。

但 `Origin` 头是客户端自报、服务端无法验证的：**只要「这里没有凭证」就放行，等于拿到密码的人
伪造一个陌生 Origin 就能跳过二次验证**。因此密码登录按下面的顺序判定（`gatePasskeySecondFactor`）：

1. 命中本机 / 内网豁免（`waivesPasskeySecondFactor`）→ 放行。
2. 当前 origin 有凭证 → 必须带断言，且断言绑定的凭证属于这批（否则 `PASSKEY_INVALID`）。
3. 账户名下压根没有通行密钥 → 这一关不存在，放行。
4. 本次登录已过 TOTP（账户开了两步验证）→ 放行并记审计：2FA 仍然成立。
5. 请求 origin 就是服务端自己配置的入口地址 → 放行并记审计。
   入口来自 `auth-passkey-origin-entry.ts`：`VIBETERM_BASE_URL`、托管的站点 URL
   （`effective-site-url.ts` / `site-settings-link`）、已配置的 Cloudflare 隧道域名
   （`tunnel_config.hostname`，`mode==='off'` 不算）、hub 公网地址、已接入的中继地址；
   按规范化 origin（scheme + host + port）判等。
6. 其余（伪造的 / 陌生的 origin）→ `PASSKEY_REQUIRED`，登录页给
   `auth.login.passkeySecondFactorNotRegistered`，那句话里带着 CLI 逃生口。

| 位置 | 改动 |
|---|---|
| `apps/gateway/src/mesh/auth-passkey-origin.ts`（新） | `passkeyOriginScope()` 按精确 origin 分组；`gatePasskeySecondFactor()` 按上面的顺序给出 skip / reject / verify |
| `apps/gateway/src/mesh/auth-passkey-origin-entry.ts`（新） | 只读服务端配置，列出本实例对外提供的入口地址 |
| `apps/gateway/src/db/local-auth-http.ts` | `passkeySecondFactor = 本 origin 有钥匙 && !waived`；新增 `passkeysRegisteredElsewhere` |
| `apps/gateway/src/mesh/auth-routes.ts` | `checkPasskeySecondFactor` 走 gate；断言绑定的凭证必须属于本 origin，否则 `PASSKEY_INVALID` |
| `apps/fe/src/pages/LoginPage.tsx` | 别处有钥匙、这里没有时，密码表单下给一行 `auth.login.passkeyOtherOriginHint` |
| `apps/fe/src/auth/session-login.ts` | 二次验证仪式遇 `NO_PASSKEY_FOR_ORIGIN` 视为「这一步不需要做」，防 mode 快照过期 |

`handlePasskeyLoginOptions` 的精确 origin 过滤、`waivesPasskeySecondFactor` 的本机/内网豁免规则
（含 `cf-connecting-ip` 一票否决）都**未改动**。

## 取舍

放宽的只有两种情形：**本次登录已过 TOTP**，或**请求 origin 是服务端自己配置的入口**。

- 伪造 Origin 不再是绕过手段：陌生 origin 会被 `PASSKEY_REQUIRED` 拒绝，与改前的行为一致。
- 已知入口 + 没开 TOTP 时，那个入口的密码登录确实只剩密码把关——这是**用可达性换可恢复性**，
  换来的是「换了自己的域名就再也登不进去」不会发生。**多入口部署建议开启两步验证。**
- 两种放行都打审计行，`reason` 区分是哪一条：

  ```
  [auth] root login skipped passkey second factor uid=<uid> origin=<origin> keys_elsewhere=<n> reason=totp|entry
  ```

- 登录后为新地址补一把通行密钥，该地址就恢复强校验。登录页对这种情况有常驻提示。

RP ID **不会**改成配置项：WebAuthn 要求 RP ID 是当前 origin 的可注册域后缀，中继域名与隧道域名
通常没有公共后缀，配一个固定 RP ID 也换不来旧钥匙可用。多入口的正解就是每个 origin 各注册一把。

## 逃生口

认证器丢失、或某个地址的通行密钥彻底不可用时：

```
vibeterm mesh passkey remove-all [<username>]
```

- 在本机安装目录上执行，提示输入账户密码，密码不对即拒绝（比对根公钥）。
- 逐把签 `remove-passkey` 记录，只删通行密钥：**不动根钥世代、不清 TOTP、不注销密码会话**，
  比 `hub user passwd --full-reset` 窄得多。
- 但用被删凭证建立的会话会随记录效果注销（`revokeSessionsByCredential`），CLI 的成功文案照此措辞。
- `vibeterm doctor` 在「对外地址是域名、该域名上没有通行密钥、别处有」时提示这条命令，
  文案按是否开了两步验证分两句。

## 兼容

- `passkeysRegisteredElsewhere` 是加性字段，旧前端忽略即可。
- 旧节点在新前端下只是少一行提示；新节点在旧前端下 `passkeySecondFactor` 变 false，登录流程更短，
  不会出错。
- 已注册的凭证、key log 记录格式均未变化。
