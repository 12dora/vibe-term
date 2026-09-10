# 登录面安全：失败模糊化、客户端 IP、通行密钥二次验证与公网评估

本文汇总 VibeTerm 账号密码登录暴露到公网时的安全机制：登录失败模糊化、客户端 IP 解析与 bootstrap 限制、未登录面的资源上限、通行密钥二次验证（按 origin 生效 + 可信本地来源豁免 + TOTP/通行密钥 OR）、以及公网暴露的安全评估结论；面向运维与改动 `apps/gateway/src/mesh/auth-*.ts` 的开发者。身份与密钥模型（根钥、delegation、node-session、密钥日志）见 [多节点架构 §2](../architecture/mesh-architecture.md)。

## 1. 现有机制（比常规密码登录强）

- **密码不出浏览器**：浏览器用 argon2id（64 MiB / 3 轮 / 1 lane）把密码派生成 Ed25519 根钥，签 challenge 登录；网关只存根公钥与 KDF 参数，没有密码哈希（`apps/fe/src/auth/session-login.ts`、`packages/shared/src/auth/root-key.ts`、`apps/gateway/src/mesh/auth-routes.ts`）。
- **会话**：256-bit 随机不透明 SID，DB 记录，18 h 滑动 / 7 d 硬上限，可撤销，按节点绑定 `viaNodeId`；cookie `HttpOnly` + `SameSite=Lax`，HTTPS 下 `Secure`；WS 复用 cookie，URL 不带 token；改密/登出即失效全部会话。
- **限流**：登录失败每 IP、每 UID 各 10 次 / 60 s（内存）。
- **passkey**：严格 origin/RP 绑定；**mesh peer 端口（39001）**用节点证书 + 握手签名鉴权，与用户密码无关。
- **文件 API**：目录根限定、路径穿越与符号链接逃逸有检查；Telegram/微信为轮询，无入站 webhook。
- 跨节点静默登录使用持久化的会话钥（[架构 §2「会话钥的跨文档持久化」](../architecture/mesh-architecture.md)），不改变节点侧校验：节点 B 仍要求根钥签的 delegation + 一次性 challenge + `target/target_pk` 绑定，A 的 SID / login 不能重放到 B。持久化的私钥为 WebCrypto 不可导出 CryptoKey，风险等级与既有 HttpOnly cookie 相同，上限为 delegation 18 h。

## 2. 登录失败模糊化

密码登录（`Delegation.method = root`）的凭证类失败统一为 `401 {code: "INVALID_CREDENTIALS"}`：

| 场景 | 响应 |
|---|---|
| `POST /api/auth/challenge` 未知 uid | 正常签发挑战（uid 存原串，登录阶段才失败） |
| `POST /api/auth/login` 未知用户 | `401 INVALID_CREDENTIALS` |
| root delegation 签名错（密码错） | `INVALID_CREDENTIALS` |
| login 会话签名错 | `INVALID_CREDENTIALS` |
| `passkey/login/options` 未知用户 | `404 NO_PASSKEY_FOR_ORIGIN`（与「本 origin 无凭证」相同） |

结构性错误（`MALFORMED`、`CHALLENGE_*`、`*_MISMATCH`、`DELEGATION_EXPIRED` 等）、`RATE_LIMITED`、`TOTP_*` 保持原码；passkey 直接登录失败仍是 `DELEGATION_BAD_SIGNATURE`。`TOTP_REQUIRED` / `PASSKEY_REQUIRED` 不计入限流失败次数。

前端密码路径把 `INVALID_CREDENTIALS` 与旧码（`DELEGATION_BAD_SIGNATURE`、`BAD_SIGNATURE`、`UNKNOWN_USER` 等，兼容未升级节点）统一显示为「用户名或密码错误。」。`/n/:id/api/auth/{challenge,login}` 的 401 不被 forwarder 改写成 `NODE_LOGIN_REQUIRED`，目标节点的原码直达浏览器。

`GET /api/auth/mode` 只对携带有效会话的请求返回 `rootPublicKey`，未登录为 `null`：根公钥加公开的 Argon2 参数等于离线爆破密码的 oracle，而登录页只需要 `kdfParams`。

未登录的 `/api/auth/challenge`、`/api/auth/login`、`/api/auth/passkey/login/options` 只接受 ≤256 字节的 uid，超长直接 `MALFORMED`。经入口转发到目标节点的鉴权请求，按真实客户端 IP 的限速在**入口**执行；目标节点看到的是 `peer:<入口>`，对 peer 上下文不再做按 IP 的挑战限速（uid 维度的登录失败限流仍在目标节点执行）。

## 3. 客户端 IP 解析与 bootstrap 限制

经 Cloudflare Tunnel 或反向代理时，所有访客共享隧道 agent 的 socket IP：不解析转发头会让一人打满误伤全站，分布式撞库则绕过 IP 桶。

`resolveClientIp({ socketIp, headers, trustProxy })`：

- `VIBETERM_TRUST_PROXY` 未开启：始终用 socket IP，忽略转发头。
- 已开启时按序取第一个**合法 IPv4/IPv6 字面量**（trim；非法则跳过）：
  1. `CF-Connecting-IP`
  2. `X-Real-IP`（nginx 的 `$remote_addr`，客户端无法伪造）
  3. `X-Forwarded-For` 的**最后一个非空**条目（`proxy_add_x_forwarded_for` 把真实客户端追加在末尾；首段由客户端自带、可伪造）。末段不是合法字面量时不回退到更早的条目。
  4. 回退 socket IP

登录限流的 IP 桶使用该结果；UID 桶与阈值不变。Cloudflare Tunnel / 反代后面**必须**打开 `VIBETERM_TRUST_PROXY`；不要在不可信跳数前开启。

**Bootstrap loopback**：未 bootstrap 的实例若经隧道连到 `127.0.0.1`，socket IP 会被当成 loopback，远端可调用 `/api/auth/local/bootstrap` 创建首个账户。判定规则：

- 请求带 `CF-Connecting-IP`（Cloudflare 才会加；本机直连不会带）即视为非本机，与是否信任代理无关——信任模式下也不解析其值。
- 否则 `trustProxy=true`：用上面解析出的客户端 IP（隧道访客不是 127.0.0.1，因此不能 bootstrap）。
- 否则 `trustProxy=false`：仍用 socket IP；`X-Forwarded-For` 在未信任时忽略。

首次部署应先在本机完成 bootstrap，再对外暴露隧道。

**未登录面的资源上限**：

- `readJsonObjectBody` / `readJsonBody` 统一封顶 1 MiB（`JSON_BODY_MAX_BYTES`）：`Content-Length` 超限直接拒；否则流式累计，超限即取消读取并按 `MALFORMED` 处理。登录、挑战、passkey、enrollment redeem、setup 全部经此两处；分块上传走自己的 8 MiB 上限。
- 挑战存储上限 4096 条（先清过期，再按插入序淘汰最旧）。
- 登录失败限流表：空 key 即删，key 数上限 1 万，每 256 次记录做一次全表清理。
- `POST /api/auth/challenge` 与 `POST /api/auth/passkey/login/options` 按客户端 IP 限速（每 60 秒 60 次，超出 `429 RATE_LIMITED`）。

## 4. 通行密钥二次验证

### 协议

用户名下注册了通行密钥时，密码登录的二次验证可以是本 origin 的通行密钥断言（与 passkey 直接登录同构，不新增端点、不新增表）；若账户同时启用了 TOTP，有效验证码也可以单独满足二次验证：

- `GET /api/auth/mode` 带 `passkeySecondFactor: boolean`、`passkeySecondFactorWaived: boolean`、`passkeysRegisteredElsewhere: boolean`，以及加性字段 `secondFactorPolicy: 'either' | 'totp' | 'passkey' | 'none'`（旧客户端忽略即可）。`either` 表示本 origin 有通行密钥且 TOTP 已启用，交任一因子即可；`totp` / `passkey` 表示只启用了那一种；`none` 表示这一步不存在（含本机豁免把通行密钥免掉、且未开 TOTP）。
- 登录体可选 `passkey: { credential_id, sig }`，`sig = base64url(borsh(PasskeyAssertion))`，WebAuthn challenge 固定为 `sha256(borsh(Delegation))`（root delegation）。前端在 root 签完 delegation 后调用 `POST /api/auth/passkey/login/options {uid, delegation}` 拿本 origin 的 `allowCredentials` 做一次仪式。
- 服务端 `checkPasskeySecondFactor`：缺 `passkey` 且 TOTP 未通过 → `401 PASSKEY_REQUIRED`；断言经 `makeVerifyDelegationPasskey` 校验（凭证属于该 uid 且属于本 origin、delegation 时间、注册 origin/rpId、签名、counter 单调）失败 → `401 PASSKEY_INVALID`。会话仍记为 `delegationMethod = root`。
- **OR 策略**（`verifySecondFactors`）：命令行客户端和驱动它的 AI agent 做不了 WebAuthn。因此当账户同时启用 TOTP 与通行密钥时，有效 TOTP **或** 本 origin 断言满足其一即可。passkey 直接登录（`method = passkey`，UV 必需）本身就是强认证，不叠加二次验证，行为不变。未提供任一因子时不放宽：本 origin 拿得出凭证 → `PASSKEY_REQUIRED`；本 origin 做不出断言但开了 TOTP → `TOTP_REQUIRED`。登录体带了 TOTP 但校验失败 → 一律 `TOTP_INVALID` 并计入限流，**不**回落到通行密钥路径（错码必须记一次失败）。两者都带且 TOTP 通过则不再验断言；两者都失败时返回更具体的错误码（`TOTP_INVALID` 优先于通行密钥错误，因为错码路径根本不会进 gate）。
- 可信本地来源豁免的仍只是通行密钥断言，**不**豁免 TOTP：开了 TOTP 的账户从 loopback 登录仍要交验证码。不新增其它豁免。

断言绑定到 delegation（含 `sess_pk` 与有效期），一份断言可随 delegation 在 18 小时内复用于所有节点的静默登录（每节点各自维护 counter），只需一次 Face ID / 指纹；前端把 `passkeyCredentialId` / `passkeySig` 与 delegation 一起持久化（它们是签名不是秘密）。「断言随信封」而非「两段式新端点」的原因：后者会让每个节点的登录都弹一次仪式，而 `ensureNodeLogin` 的静默 fan-out 无法弹窗。

### 判定顺序（按 origin 生效）

断言只能在注册它的 origin 上完成（`POST /api/auth/passkey/login/options` 按精确 origin 过滤凭证，一把都没有就回 404 `NO_PASSKEY_FOR_ORIGIN`），因此二次验证的判定口径统一到「**当前 origin** 拿得出凭证吗」。但 `Origin` 头是客户端自报的，「这里没有凭证就放行」等于拿到密码的人伪造一个陌生 Origin 就能跳过二次验证。密码登录按下面的顺序判定（`apps/gateway/src/mesh/auth-passkey-origin.ts` 的 `gatePasskeySecondFactor`，在 `verifySecondFactors` 已处理 TOTP 之后）：

1. 命中本机 / 内网豁免（`waivesPasskeySecondFactor`，见下节）→ 这一关放行（TOTP 若已启用且本次未校验，外层仍回 `TOTP_REQUIRED`）。
2. 名下有通行密钥、但 `Origin` 不是规范形态（浏览器发出的永远是小写 scheme+host、省略默认端口、无路径尾斜杠）→ 直接 `PASSKEY_REQUIRED`。凭证归属与入口比对都按 `canonicalOrigin()` 判等，`https://LOGIN.example` / `…:443` / `…/` 这类变体换不来任何放行。**本次已过 TOTP 也不拆这道硬拒绝**：非规范 Origin 只可能是手工构造，用来探测「变体绕开凭证归属、再撞上已知入口」。合法客户端（浏览器、不带 Origin 或带规范 Origin 的 CLI）走不到这里。缺 Origin（空串）不算非规范，TOTP 通过即接受。
3. 本次登录已过 TOTP（登录体带了校验通过的 `totp`）→ 放行并记审计，**包括当前 origin 有凭证**。这是 OR 策略的核心：本 origin 的钥匙不再强制断言。
4. 当前 origin 有凭证 → 必须带断言，且断言绑定的凭证属于这批（否则 `PASSKEY_INVALID`）。
5. 账户名下压根没有通行密钥 → 这一关本来就不存在，放行（外层若开了 TOTP 且未交码，回 `TOTP_REQUIRED`）。
6. 请求 origin 就是服务端自己配置的入口地址 → 放行并记审计。入口来自 `auth-passkey-origin-entry.ts`：`VIBETERM_BASE_URL`、生效的站点 URL（`getSiteSettings().siteUrl`）、已配置的 Cloudflare 隧道域名（`tunnel_config.hostname`，`mode==='off'` 不算）、hub 公网地址、已接入的中继地址；按规范化 origin 判等。
7. 其余（伪造的 / 陌生的 origin）→ `PASSKEY_REQUIRED`；若账户开了 TOTP 且本次未交码，外层改写成 `TOTP_REQUIRED`（CLI 知道交验证码即可）。登录页给 `auth.login.passkeySecondFactorNotRegistered`，其中带 CLI 逃生口。

放宽的情形：**本次登录已过 TOTP**（规范或缺失 Origin），或**请求 origin 是服务端自己配置的入口**（未开 TOTP 时）。形态规范但服务端不认得的 Origin（如 `https://attacker.example`）在 TOTP 已校验时放行——这是既有行为，也覆盖 CLI。已知入口 + 没开 TOTP 时，那个入口的密码登录确实只剩密码把关——这是用可达性换可恢复性，避免「换了自己的域名就再也登不进去」。**多入口部署建议开启两步验证。** 两种放行都打审计行：

```
[auth] root login skipped passkey second factor uid=<uid> origin=<origin> keys_elsewhere=<n> reason=totp|entry
```

登录后为新地址补一把通行密钥，该地址就恢复强校验；登录页在「别处有钥匙、这里没有」时给一行 `auth.login.passkeyOtherOriginHint`。

RP ID **不会**改成配置项：WebAuthn 要求 RP ID 是当前 origin 的可注册域后缀，中继域名与隧道域名通常没有公共后缀。多入口的正解就是每个 origin 各注册一把。

### 可信本地来源豁免

WebAuthn 不允许 IP 字面量 origin（`http://127.0.0.1:9883`、`http://192.168.1.5:9883`），这些地址永远无法注册通行密钥。因此与 [域名访问策略](./domain-access-policy.md) 同一套分类：**判定对象是客户端源 IP，不是 Host / Origin**。入口节点直达请求（`via=self`）满足以下全部条件即为可信本地来源（`apps/gateway/src/mesh/client-source.ts` `isTrustedLocalClient`）：

- 套接字对端地址本身必须是回环或本地（`isLoopbackClientIp || isLocalClientSource`）。公网套接字对端一律不豁免，无论它带了什么 `x-real-ip` / `x-forwarded-for`。经反代时，反代必须在本机或局域网；
- 没有 `cf-connecting-ip` 头（出现即远端，空值也算出现）；
- `VIBETERM_TRUST_PROXY` 关闭时请求不带 `x-forwarded-for` / `x-real-ip`（fail-closed：头存在即否）；
- 解析出的客户端 IP（信任代理时取 `cf-connecting-ip → x-real-ip → XFF 末段`，否则取套接字对端）属于回环 / RFC1918 / link-local / IPv6 ULA / CGNAT 100.64/10；缺失即否。信任代理开启时，套接字对端与解析出的客户端 IP 都必须是本地。

可信本地来源的密码登录不要求通行密钥断言；`GET /api/auth/mode` 返回 `passkeySecondFactor=false`、`passkeySecondFactorWaived=true`，`secondFactorPolicy` 在未开 TOTP 时为 `none`、开了 TOTP 时为 `totp`。密码、TOTP、限速照旧。通行密钥直接登录不受影响。

**下游传递**：入口 forwarder 转发 `/n/<id>/...` 时，若浏览器源为可信本地，则在转发头加 `x-vibeterm-client-source: local`（兼容期同时发 `x-tmex-client-source`）；浏览器自带的该头一律丢弃。目标节点只在请求来自认证 peer 链路（`clientIp=peer:<入口>`）时认这个头，直达请求带此头无效。

信任的是 mesh 成员身份（认证 peer 链路），不是头本身。被攻陷的成员节点可以为经它登录的浏览器免掉通行密钥——该节点本就能中转该用户的终端会话，属于既有信任面。不做签名断言，不提供关闭开关。

e2e：Playwright 浏览器的源地址就是回环。mesh e2e 实例以 `VIBETERM_TRUST_PROXY=true` 启动，严格路径用例给 context 加 `x-forwarded-for: 203.0.113.9` 模拟公网源。

### 逃生口

认证器丢失、或某个地址的通行密钥彻底不可用时：

```
vibeterm mesh passkey remove-all [<username>]
```

- 在本机安装目录上执行，提示输入账户密码，密码不对即拒绝（比对根公钥）。
- 逐把签 `remove-passkey` 记录，只删通行密钥：**不动根钥世代、不清 TOTP、不注销密码会话**，比 `hub user passwd --full-reset` 窄得多。
- 用被删凭证建立的会话会随记录效果注销（`revokeSessionsByCredential`）。
- `vibeterm doctor` 在「对外地址是域名、该域名上没有通行密钥、别处有」时提示这条命令。

更重的手段是主 hub 上 `vibeterm hub user passwd <user> --full-reset`（`rotate-root` 全量重置会移除全部通行密钥与 TOTP）。

### 滚动升级注意

- 二次验证按**节点**各自执行：未升级的节点仍只验密码，知道密码的人经 `/n/<旧节点>/api/auth/login` 可以拿到该旧节点的会话；旧入口也会把新节点的 `PASSKEY_REQUIRED` 改写成 `NODE_LOGIN_REQUIRED`。注册通行密钥前把全部节点升到最新（节点管理里可批量升级）。
- CLI `vibeterm enroll` 用密码登录 hub 后再创建 enrollment。账号只启用通行密钥、未开 TOTP 时该路径仍不可用（CLI 做不了 WebAuthn），会在提示输入密码前直接给出说明。同时开了 TOTP 时，CLI 用密码 + TOTP 即可过二次验证。加入节点请在网页「设置 → 多节点互联 → 节点管理 → 添加 → 生成加入码」后使用加入命令。
- `passkeysRegisteredElsewhere` / `secondFactorPolicy` 都是加性字段，旧前端忽略即可；新节点在旧前端下 `passkeySecondFactor` 变 false，登录流程更短，不会出错。旧前端若仍按 AND 同时交 TOTP 与断言，服务端照收。

## 5. 公网暴露的安全评估

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| 高（条件） | 未 bootstrap 的新实例经隧道连 `127.0.0.1` 时可远程创建首个账户 | 已修（§3）；运维上仍应先在本机 bootstrap 再暴露 |
| 高（条件） | 裸 `@vibeterm/gateway start` 入口不装会话守卫 | 不改：该入口仅开发用，打包运行时（`packages/app` 装配）才是公网形态 |
| 高 | HTTP 直连暴露时会话可被嗅探；cookie `Secure` 依赖 HTTPS 探测 | 不改代码：公网一律走 Tunnel HTTPS 或自配 TLS，反代后开 `VIBETERM_TRUST_PROXY` |
| 中 | 限流 IP 桶在隧道后全员共桶 | 已修（§3） |
| 中 | 密码最短 8 位、无复杂度要求；拿到 DB 可离线撞根公钥 | 不改：argon2id 已足够贵；建议用密码管理器生成 16+ 位或改用 passkey。**不加复杂度规则** |
| 中 | agent 会话 / 文件传输 API 无按用户归属检查 | 不改：VibeTerm 每节点单用户（`findPrimaryUser`），不承诺多用户隔离 |
| 低 | 登录可枚举用户名；无持久审计日志 | 用户名枚举已由失败模糊化收口（§2）；用户名不是安全边界 |
| 低 | 无通用 Origin 校验，CSRF 依赖 `SameSite=Lax` + 无 CORS 放行 | 不改：当前威胁模型足够 |
| 低 | TOTP 由同一密码派生，不是独立第二因子 | 不改；不宣传为 MFA，需要第二因子用 passkey |

**明确不做的事（避免过度防御）**：服务端 bcrypt/argon2 密码哈希（现有 challenge 签名设计更优）；全局锁定、指数退避、密码复杂度规则；JWT / localStorage token / WS `?token=`；全站 HSTS（localhost 与自签场景会被打坏，有需要在公网边缘配）；给 peer 握手再加口令层；收紧 passkey 域名绑定。

**暴力破解的现实评估**：在线每 IP、每 UID 各 ≈ 0.17 次/秒（限流决定，argon2 在浏览器侧不构成服务端成本）；分布式源 IP 也受 UID 桶约束。离线需先拿到 DB（根公钥 + KDF 参数），argon2id 64 MiB 单次派生成本高，随机 16+ 位密码即可忽略。
