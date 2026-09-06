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

| 位置 | 改动 |
|---|---|
| `apps/gateway/src/mesh/auth-passkey-origin.ts`（新） | `passkeyOriginScope()` 按精确 origin 分组；`gatePasskeySecondFactor()` 给出 skip / reject / verify 三态 |
| `apps/gateway/src/db/local-auth-http.ts` | `passkeySecondFactor = 本 origin 有钥匙 && !waived`；新增 `passkeysRegisteredElsewhere` |
| `apps/gateway/src/mesh/auth-routes.ts` | `checkPasskeySecondFactor` 走 gate；断言绑定的凭证必须属于本 origin，否则 `PASSKEY_INVALID` |
| `apps/fe/src/pages/LoginPage.tsx` | 别处有钥匙、这里没有时，密码表单下给一行 `auth.login.passkeyOtherOriginHint` |
| `apps/fe/src/auth/session-login.ts` | 二次验证仪式遇 `NO_PASSKEY_FOR_ORIGIN` 视为「这一步不需要做」，防 mode 快照过期 |

`handlePasskeyLoginOptions` 的精确 origin 过滤、`waivesPasskeySecondFactor` 的本机/内网豁免规则
（含 `cf-connecting-ip` 一票否决）都**未改动**。

## 取舍

放宽的是这一种情形：名下有通行密钥，但请求 origin 上没有 —— 此时密码登录被放行。

- 攻击者若能让请求带上一个从未注册过通行密钥的 Origin，就绕过了这一层。改前该请求会锁死，改后
  会放行。这是**用可达性换可恢复性**：改前的「锁死」同样落在真实用户头上，且没有逃生口。
- 缓解一：TOTP 不变。开了两步验证的账户，任何 origin 的密码登录仍然要过 TOTP（两者是串联 AND，
  见 `verifySecondFactors`）。**建议在多入口部署上开启 TOTP。**
- 缓解二：这类放行会打审计行，便于事后核查：

  ```
  [auth] root login skipped passkey second factor uid=<uid> origin=<origin> keys_elsewhere=<n>
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
- 逐把签 `remove-passkey` 记录，只删通行密钥；**不动根钥世代、不清 TOTP、不注销密码会话**，
  比 `hub user passwd --full-reset` 窄得多。
- `vibeterm doctor` 在「对外地址是域名、该域名上没有通行密钥、别处有」时提示这条命令。

## 兼容

- `passkeysRegisteredElsewhere` 是加性字段，旧前端忽略即可。
- 旧节点在新前端下只是少一行提示；新节点在旧前端下 `passkeySecondFactor` 变 false，登录流程更短，
  不会出错。
- 已注册的凭证、key log 记录格式均未变化。
