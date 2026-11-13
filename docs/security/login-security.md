# 登录面安全：失败模糊化、客户端 IP、通行密钥二次验证与公网评估

本文汇总 VibeTerm 账号密码登录暴露到公网时的安全机制：登录失败模糊化、客户端 IP 解析与 bootstrap 限制、登录限制与登录历史、未登录面的资源上限、通行密钥二次验证（按 origin 生效 + 可信本地来源豁免 + TOTP/通行密钥 OR）、认证审计日志、浏览器请求入口门（Origin / Host），以及公网暴露的安全评估结论；面向运维与改动 `apps/gateway/src/mesh/auth-*.ts` 的开发者。身份与密钥模型（根钥、delegation、node-session、密钥日志）见 [多节点架构 §2](../architecture/mesh-architecture.md)。

## 1. 现有机制（比常规密码登录强）

- **密码不出浏览器**：浏览器用 argon2id（64 MiB / 3 轮 / 1 lane）把密码派生成 Ed25519 根钥，签 challenge 登录；网关只存根公钥与 KDF 参数，没有密码哈希（`apps/fe/src/auth/session-login.ts`、`packages/shared/src/auth/root-key.ts`、`apps/gateway/src/mesh/auth-routes.ts`）。
- **会话**：256-bit 随机不透明 SID，DB 记录，18 h 滑动 / 7 d 硬上限，可撤销，按节点绑定 `viaNodeId`；cookie `HttpOnly` + `SameSite=Lax`，HTTPS 下 `Secure`；WS 复用 cookie，URL 不带 token；改密/登出即失效全部会话。
- **限流**：密码登录失败走 mesh 签名的 `login-policy`（缺省预设 `standard`：同一 IP 在 15 min 内 10 次失败则锁定，账号在滚动 1 小时内超过 50 次则暂停密码登录）。计数只在内存里，重启即清。TOTP 错码另有按 uid 的 5 次 / 15 min 桶，连续窗口指数锁定（最长 8 h）；已消费验证码按 `(uid, code, sess_pk)` 缓存 90 s，防止同一码换会话钥重放。挑战与 passkey options 仍是每 IP 60 次 / 60 s。细则见 §7。
- **passkey**：严格 origin/RP 绑定；**mesh peer 端口（39001）**用节点证书 + 握手签名鉴权，与用户密码无关。
- **文件 API**：目录根限定、路径穿越与符号链接逃逸有检查；Telegram/微信为轮询，无入站 webhook。
- 跨节点静默登录使用持久化的会话钥（[架构 §2「会话钥的跨文档持久化」](../architecture/mesh-architecture.md)），不改变节点侧校验：节点 B 仍要求根钥签的 delegation + 一次性 challenge + `target/target_pk` 绑定，A 的 SID / login 不能重放到 B。持久化的私钥为 WebCrypto 不可导出 CryptoKey，风险等级与既有 HttpOnly cookie 相同，上限为 delegation 18 h。

### 1.1 账号密码强度规则

每台节点的数据库都保存根公钥与 KDF 参数，在线限流（§7）不覆盖离线场景。KDF 参数不变，在**设置或修改账号密码**时强制下列规则：

- 至少 12 位（NFKC 归一化后按 Unicode 码点计，与 KDF 的归一化一致）。
- 拒绝过于简单的密码：单一字符占 60% 以上、整串是连续序列（`123456789012`、`abcdefghijkl`、键盘行 `qwertyuiop…`）、短片段重复三次以上（`abcabcabcabc`）、包含用户名（不分大小写，用户名至少 3 位）、命中内置的少量常见长密码（`password1234` 等）。
- 规则只有一份：`packages/shared/src/auth/password-policy.ts` 的 `checkAccountPassword`，网页（设置向导、账号安全面板的修改密码）、`vibeterm user add|passwd`、`mesh reset-root`、`relay join` 建本机用户、`vibeterm settings passwd` 与设置向导的服务端（`POST /api/setup/relay`，错误码 `password_too_short` / `password_too_simple`）都调用它。
- 登录不检查强度：已有的弱密码照常可用，不强制更换，只在下次改密时受新规则约束。接入口令、单机本地口令、分享口令都由服务端在线校验，不在此规则内。
- 规则不替代随机密码：界面建议用密码管理器生成；需要更强保护时用通行密钥。
- 混合版本：规则只在设置密码的客户端执行，不产生新的协议字段。旧版本节点或旧客户端设置的弱密码照常被接受，网关不校验强度。

## 2. 登录失败模糊化

密码登录（`Delegation.method = root`）的凭证类失败统一为 `401 {code: "INVALID_CREDENTIALS"}`：

| 场景 | 响应 |
|---|---|
| `POST /api/auth/challenge` 未知 uid | 正常签发挑战（uid 存原串，登录阶段才失败） |
| `POST /api/auth/login` 未知用户 | `401 INVALID_CREDENTIALS` |
| root delegation 签名错（密码错） | `INVALID_CREDENTIALS` |
| login 会话签名错 | `INVALID_CREDENTIALS` |
| `passkey/login/options` 未知用户 | `404 NO_PASSKEY_FOR_ORIGIN`（与「本 origin 无凭证」相同） |

结构性错误（`MALFORMED`、`CHALLENGE_*`、`*_MISMATCH`、`DELEGATION_EXPIRED` 等）、`RATE_LIMITED`、`PASSWORD_LOGIN_PAUSED`、`TOTP_*` 保持原码；passkey 直接登录失败仍是 `DELEGATION_BAD_SIGNATURE`。`TOTP_REQUIRED` / `PASSKEY_REQUIRED` 不计入限流，也不写登录历史。IP 锁定是 `429 RATE_LIMITED`（带 `retryAfterMs`）；账号暂停密码登录是 `429 PASSWORD_LOGIN_PAUSED`（仅 `method=root` 且 uid 已知）。其余失败仍保持 `INVALID_CREDENTIALS` 的不透明。登录页对这两种 429 显示剩余时间；密码登录被暂停且本 origin 有通行密钥时，提示改用通行密钥。

前端密码路径把 `INVALID_CREDENTIALS` 与旧码（`DELEGATION_BAD_SIGNATURE`、`BAD_SIGNATURE`、`UNKNOWN_USER` 等，兼容未升级节点）统一显示为「用户名或密码错误。」。`/n/:id/api/auth/{challenge,login}` 的 401 不被 forwarder 改写成 `NODE_LOGIN_REQUIRED`，目标节点的原码直达浏览器。

`GET /api/auth/mode` 只对携带有效会话的请求返回 `rootPublicKey`，未登录为 `null`：根公钥加公开的 Argon2 参数等于离线爆破密码的 oracle，而登录页只需要 `kdfParams`。

未登录的 `/api/auth/challenge`、`/api/auth/login`、`/api/auth/passkey/login/options` 只接受 ≤256 字节的 uid，超长直接 `MALFORMED`。经入口转发到目标节点的鉴权请求，按真实客户端 IP 的限速在**入口**执行；目标节点看到的是 `peer:<入口>`，对 peer 上下文不再做按 IP 的挑战限速（uid 维度的登录失败限流仍在目标节点执行）。

## 3. 客户端 IP 解析与 bootstrap 限制

经 Cloudflare Tunnel 或反向代理时，所有访客共享隧道 agent 的 socket IP：不解析转发头会让一人打满误伤全站，分布式撞库则绕过 IP 桶。

`client-ip.ts` 的 `resolveClientIp({ socketIp, headers, trustProxy, clientIpHeader })` 是全进程唯一的「客户端是谁」解析：

- `VIBETERM_TRUST_PROXY` 未开启，或套接字对端不是回环 / 内网（不是代理那一跳）：始终用 socket IP，忽略转发头。
- 已开启且对端是回环 / 内网时，**只读一个头**，由 `VIBETERM_CLIENT_IP_HEADER` 决定（`x-forwarded-for` | `x-real-ip` | `cf-connecting-ip`，缺省 `x-forwarded-for`，其它值启动即报错）。其余转发头一律不看，不存在跨头回退。
  - `x-forwarded-for` 取**最右一项**（受信代理追加的那一项；左侧由客户端自带、可伪造）。最右一项为空或不是合法字面量时不回退到更早的条目。
  - 配置的头缺失、但请求带了其它转发头，或值不合法：结果为未知（`undefined`），不退回代理自己的套接字地址。请求不带任何转发头（本机直连）时才用 socket IP。配置的头缺失而其它转发头存在时，进程对每种头组合打一行 `[client-ip]` 告警：这类访客共用 `unknown` 限流桶，应把 `VIBETERM_CLIENT_IP_HEADER` 改成代理实际发送的头。
- `VIBETERM_TRUST_PROXY` 与 `VIBETERM_CLIENT_IP_HEADER` 由同一套写入规则维护（`apps/gateway/src/tunnel/trust-proxy-env.ts` `patchTrustProxyEnv`），隧道开关与 TLS 外部模式共用：隧道打开「信任代理」时写 `VIBETERM_CLIENT_IP_HEADER=cf-connecting-ip`（Cloudflare 边缘会覆写该头）；隧道关闭信任、或切到 TLS 外部模式（本机反代）时，只在该键等于 `cf-connecting-ip` 时删掉它回到缺省，用户自己设的其它值保留。隧道状态的「需要重启」同时比较这两个键。自建 nginx / Caddy 用缺省的 `x-forwarded-for` 即可；只在代理确实覆写 `X-Real-IP` 时才配 `x-real-ip`。同一实例既走隧道又走本机反代时两者都从回环进来、无法区分，`cf-connecting-ip` 会采信反代透传的同名头，这种组合应只保留一种入口。

解析结果用于挑战限速、登录 IP 阶梯、分享登录限速、域名访问策略、审计和直连登录记录；缺失时限流桶键为 `unknown`。限流桶键统一经 `limiterIpKey`：IPv6 按 /64 归桶（同一前缀内轮换源地址不换桶），v4-mapped 还原成点分 IPv4。Cloudflare Tunnel / 反代后面**必须**打开 `VIBETERM_TRUST_PROXY`；不要在不可信跳数前开启。未开启时，登录 IP 阶梯不把经本机 / 内网反代来的访客挤进同一个套接字桶：带转发头的请求进 `proxied:<配置头里声称的地址>` 桶（可伪造，只做隔离；配置头缺失即 `proxied:unknown`）；公网套接字无论带什么头都按套接字计。写进登录记录和审计日志的仍是套接字地址。

**转发登录**：入口 `forwarder` 会丢掉 `x-forwarded-*` / `CF-Connecting-IP`。入口只按真实客户端 IP 计登录阶梯，不计账号桶。目标节点看到的是 `peer:<入口>`，登录阶梯不按 IP 计，只按规范 uid 计账号软顶（用户名与 uid 共用这只桶）。TOTP 错码桶同样只按 uid（每节点一份内存表）。登录记录用的入口 IP 头见 §8，与这里的限流桶不是同一条规则。

**TOTP 错码与重放**（`apps/gateway/src/mesh/auth-totp-guard.ts`）：

- 校验之前先看 uid 是否已锁；`TOTP_INVALID`（含换 `sess_pk` 重放）同时记入该桶和上面的登录失败总预算。`TOTP_REQUIRED` / `PASSKEY_REQUIRED` 不计。
- 同一节点上已通过的验证码按 `(uid, code, delegation.sess_pk)` 缓存，TTL = 接受窗口（3 step × 30 s = 90 s）。同一 delegation 重试放行；换一把会话钥再用同一码 → `TOTP_INVALID`。
- 多节点登录 fan-out 时，各节点有自己的缓存：同一验证码在窗口内被不同节点各自接受，这是有意为之。

**Bootstrap loopback**：未 bootstrap 的实例若经隧道连到 `127.0.0.1`，socket IP 会被当成 loopback，远端可调用 `/api/auth/local/bootstrap` 创建首个账户。本机判定（`requestIsLoopback`）与 §4「可信本地来源」共用 `client-ip.ts` 的 `localClientClass`，并额外要求套接字是回环：

- 请求带任何经代理的迹象即视为非本机，与是否信任代理无关，也不解析头里的地址：转发头 `forwarded`、`x-forwarded-for`、`x-real-ip`、`cf-connecting-ip`，以及 `x-forwarded-proto`、`x-forwarded-host`、`via`、`true-client-ip`、`x-client-ip`（空值也算）。
- 请求 `Host` 必须是本机认得的名字：IP 字面量、`localhost` / `*.localhost`、本机 mDNS 名（`<os.hostname()>.local`）或已配置的域名（`apps/gateway/src/mesh/request-authority.ts`，与 §10 免登录单机的 Host 规则同一实现）。其它域名即使套接字是回环也不算本机。
- 否则看套接字对端：回环才算本机；`peer:` 与缺失一律否。

首次部署应先在本机完成 bootstrap，再对外暴露隧道。

**未登录面的资源上限**：

- `readJsonObjectBody` / `readJsonBody` 统一封顶 1 MiB（`JSON_BODY_MAX_BYTES`）：`Content-Length` 超限直接拒；否则流式累计，超限即取消读取并按 `MALFORMED` 处理。登录、挑战、passkey、enrollment redeem、setup 全部经此两处；分块上传走自己的 8 MiB 上限。
- 挑战存储上限 4096 条（先清过期，再按插入序淘汰最旧）。
- 登录失败限流表：空 key 即删，key 数上限 1 万，每 256 次记录做一次全表清理。
- `POST /api/auth/challenge` 与 `POST /api/auth/passkey/login/options` 按客户端 IP 限速（每 60 秒 60 次，超出 `429 RATE_LIMITED`）。

## 4. 通行密钥二次验证

### 协议

这是一次有意的 **AND → OR** 收口。旧规则是「开了 TOTP 且本 origin 有通行密钥时，密码登录必须两个都交」。CLI 和驱动它的 AI agent 做不了 WebAuthn，那条 AND 会把命令行路径锁死。用户明确决定：账户即使已登记通行密钥，**单独一次有效 TOTP 断言也足够**（反之，单独一次本 origin 通行密钥断言也足够）。passkey 直接登录（`method = passkey`）行为不变。

用户名下注册了通行密钥时，密码登录的二次验证可以是本 origin 的通行密钥断言（与 passkey 直接登录同构，不新增端点、不新增表）；若账户同时启用了 TOTP，有效验证码也可以单独满足二次验证：

- `GET /api/auth/mode` 带 `passkeySecondFactor: boolean`、`passkeySecondFactorWaived: boolean`、`passkeysRegisteredElsewhere: boolean`，以及加性字段 `secondFactorPolicy: 'either' | 'totp' | 'passkey' | 'none'`（旧客户端忽略即可）。`either` 表示本 origin 有通行密钥且 TOTP 已启用，交任一因子即可；`totp` / `passkey` 表示只启用了那一种；`none` 表示这一步不存在（含本机豁免把通行密钥免掉、且未开 TOTP）。
- 登录体可选 `passkey: { credential_id, sig }`，`sig = base64url(borsh(PasskeyAssertion))`，WebAuthn challenge 固定为 `sha256(borsh(Delegation))`（root delegation）。前端在 root 签完 delegation 后调用 `POST /api/auth/passkey/login/options {uid, delegation}` 拿本 origin 的 `allowCredentials` 做一次仪式。
- 服务端 `checkPasskeySecondFactor`：缺 `passkey` 且 TOTP 未通过 → 由外层选错误码（见下）；断言经 `makeVerifyDelegationPasskey` 校验（凭证属于该 uid 且属于本 origin、delegation 时间、注册 origin/rpId、签名、counter 单调）失败 → `401 PASSKEY_INVALID`。会话仍记为 `delegationMethod = root`。
- **OR 策略**（`verifySecondFactors`）：当账户同时启用 TOTP 与通行密钥时，有效 TOTP **或** 本 origin 断言满足其一即可。未提供任一因子时：已开 TOTP → `TOTP_REQUIRED`（含本 origin 拿得出凭证；非 WebAuthn 客户端据此提示交验证码，GUI 在该码下仍保留通行密钥按钮）；未开 TOTP 且本 origin 拿得出凭证 → `PASSKEY_REQUIRED`。登录体带了 TOTP 但校验失败 → 一律 `TOTP_INVALID` 并计入限流（专用桶 + 登录失败总预算），**不**回落到通行密钥路径。两者都带且 TOTP 通过则不再验断言；两者都失败时 `TOTP_INVALID` 优先于通行密钥错误。`GET /api/auth/mode` 的 `totpEnabled` / `secondFactorPolicy` 与 `checkTotp` 同一口径：用户行的 `totpRecordSeq` 与密钥日志 `currentState(uid).totp` 都在才算已启用。
- 可信本地来源豁免的仍只是通行密钥断言，**不**豁免 TOTP：开了 TOTP 的账户从 loopback 登录仍要交验证码。不新增其它豁免。

断言绑定到 delegation（含 `sess_pk` 与有效期），一份断言可随 delegation 在 18 小时内复用于所有节点的静默登录（每节点各自维护 counter），只需一次 Face ID / 指纹；前端把 `passkeyCredentialId` / `passkeySig` 与 delegation 一起持久化（它们是签名不是秘密）。「断言随信封」而非「两段式新端点」的原因：后者会让每个节点的登录都弹一次仪式，而 `ensureNodeLogin` 的静默 fan-out 无法弹窗。

**转发登录的 Origin**：入口 `apps/gateway/src/mesh/forwarder.ts` 把浏览器的 `Origin` 原样转给目标节点（缺省则用入口自己收到的请求 URL origin）。目标节点 `requestOrigin()` 取请求 `Origin`，没有则用该节点自己的公开 URL origin。因此：浏览器经 `/n/<id>/api/auth/login` 登录时，二次验证按**浏览器 Origin** 判凭证归属；CLI 不带 Origin 直连某节点时，按**该节点公开 URL origin** 分类。伪造的陌生 Origin 仍走 §4 判定顺序，不能靠「这里没有凭证」跳过二次验证。

### 判定顺序（按 origin 生效）

断言只能在注册它的 origin 上完成（`POST /api/auth/passkey/login/options` 按精确 origin 过滤凭证，一把都没有就回 404 `NO_PASSKEY_FOR_ORIGIN`），因此二次验证的判定口径统一到「**当前 origin** 拿得出凭证吗」。但 `Origin` 头是客户端自报的，「这里没有凭证就放行」等于拿到密码的人伪造一个陌生 Origin 就能跳过二次验证。密码登录按下面的顺序判定（`apps/gateway/src/mesh/auth-passkey-origin.ts` 的 `gatePasskeySecondFactor`，在 `verifySecondFactors` 已处理 TOTP 之后）：

1. 命中本机 / 内网豁免（`waivesPasskeySecondFactor`，见下节）→ 这一关放行（TOTP 若已启用且本次未校验，外层仍回 `TOTP_REQUIRED`）。
2. 名下有通行密钥、但 `Origin` 不是规范形态（浏览器发出的永远是小写 scheme+host、省略默认端口、无路径尾斜杠）→ 直接 `PASSKEY_REQUIRED`。凭证归属与入口比对都按 `canonicalOrigin()` 判等，`https://LOGIN.example` / `…:443` / `…/` 这类变体换不来任何放行。**本次已过 TOTP 也不拆这道硬拒绝**：非规范 Origin 只可能是手工构造，用来探测「变体绕开凭证归属、再撞上已知入口」。合法客户端（浏览器、不带 Origin 或带规范 Origin 的 CLI）走不到这里。缺 Origin（空串）不算非规范，TOTP 通过即接受。
3. 本次登录已过 TOTP（登录体带了校验通过的 `totp`）→ 放行并记审计，**包括当前 origin 有凭证**。这是 OR 策略的核心：本 origin 的钥匙不再强制断言。
4. 当前 origin 有凭证 → 必须带断言，且断言绑定的凭证属于这批（否则 `PASSKEY_INVALID`）。
5. 账户名下压根没有通行密钥 → 这一关本来就不存在，放行（外层若开了 TOTP 且未交码，回 `TOTP_REQUIRED`）。
6. 请求 origin 就是服务端自己配置的入口地址 → 放行并记审计。入口来自 `auth-passkey-origin-entry.ts`：`VIBETERM_BASE_URL`、生效的站点 URL（`getSiteSettings().siteUrl`）、已配置的 Cloudflare 隧道域名（`tunnel_config.hostname`，`mode==='off'` 不算）、已接入的中继公网地址（`mesh_relays.url`）；按规范化 origin 判等。不再读 Hub 公网地址。
7. 其余（伪造的 / 陌生的 origin）→ `PASSKEY_REQUIRED`；若账户开了 TOTP 且本次未交码，外层改写成 `TOTP_REQUIRED`（CLI 知道交验证码即可）。登录页给 `auth.login.passkeySecondFactorNotRegistered`，其中带 CLI 逃生口。

放宽的情形：**本次登录已过 TOTP**（规范或缺失 Origin），或**请求 origin 是服务端自己配置的入口**（未开 TOTP 时）。形态规范但服务端不认得的 Origin（如 `https://attacker.example`）在 TOTP 已校验时放行——这是既有行为，也覆盖 CLI。已知入口 + 没开 TOTP 时，那个入口的密码登录确实只剩密码把关——这是用可达性换可恢复性，避免「换了自己的域名就再也登不进去」。**多入口部署建议开启两步验证。** 两种放行都打审计行：

```
[auth] root login skipped passkey second factor uid=<uid> origin=<origin> keys_elsewhere=<n> reason=totp|entry
```

登录后为新地址补一把通行密钥，该地址就恢复强校验；登录页在「别处有钥匙、这里没有」时给一行 `auth.login.passkeyOtherOriginHint`。

RP ID **不会**改成配置项：WebAuthn 要求 RP ID 是当前 origin 的可注册域后缀，中继域名与隧道域名通常没有公共后缀。多入口的正解就是每个 origin 各注册一把。

### 可信本地来源豁免

WebAuthn 不允许 IP 字面量 origin（`http://127.0.0.1:9883`、`http://192.168.1.5:9883`），这些地址永远无法注册通行密钥。因此与 [域名访问策略](./domain-access-policy.md) 同一套分类：**判定对象是客户端源 IP，不看 Origin**；`Host` 只用来确认请求确实是发给本机的名字。入口节点直达请求（`via=self`）满足以下全部条件即为可信本地来源（`apps/gateway/src/mesh/client-source.ts` `isTrustedLocalClient`）：

- 套接字对端地址本身是回环或本地（`isLoopbackClientIp || isLocalClientSource`），且不是 `peer:`；
- 请求不带任何经代理的迹象（§3 列出的九个头，空值也算）；
- 请求 `Host` 是本机认得的名字（§3）。

判定只看套接字，**永远不采信转发头里的地址**，与 `VIBETERM_TRUST_PROXY` 无关（`client-ip.ts` `localClientClass`，`isTrustedLocalClient`、`requestIsLoopback`、`loginIpExempt`、中继状态免密、setup 路由共用）。代价：经本机 / 局域网反代访问的浏览器不再享受豁免，需在反代域名上注册通行密钥。

可信本地来源的密码登录不要求通行密钥断言；`GET /api/auth/mode` 返回 `passkeySecondFactor=false`、`passkeySecondFactorWaived=true`，`secondFactorPolicy` 在未开 TOTP 时为 `none`、开了 TOTP 时为 `totp`。密码、TOTP、限速照旧。通行密钥直接登录不受影响。

**不跨节点传递**：每个节点只按自己的套接字判定。经入口转发到目标节点的登录，目标看到的是 `peer:<入口>`，永远不豁免；目标从 peer 入站请求里剥掉 `x-vibeterm-client-source`（及旧名 `x-tmex-client-source`），入口也不再盖这个头。目标节点不采信 peer 入站请求里声称的客户端来源。混跑期：2.14.0 入口仍会盖头，新目标剥掉不认；2.14.0 目标仍认这个头，新入口不再发、并丢弃浏览器自带的同名头，因此旧目标经新入口不再豁免。经本机入口登录远端节点、且账号策略要求通行密钥时，需要在入口 origin 上注册通行密钥（IP 字面量入口无法注册，改用域名或 `localhost`）。

e2e：Playwright 浏览器的源地址就是回环。严格路径用例给 context 加任一转发头（如 `x-forwarded-for: 203.0.113.9`）即模拟非本机源。

### 逃生口

认证器丢失、或某个地址的通行密钥彻底不可用时：

```
vibeterm mesh passkey remove-all [<username>]
```

- 在本机安装目录上执行，提示输入账户密码，密码不对即拒绝（比对根公钥）。
- 逐把签 `remove-passkey` 记录，只删通行密钥：**不动根钥世代、不清 TOTP、不注销密码会话**，比 `vibeterm user passwd --full-reset` 窄得多。
- 用被删凭证建立的会话会随记录效果注销（`revokeSessionsByCredential`）。
- `vibeterm doctor` 在「对外地址是域名、该域名上没有通行密钥、别处有」时提示这条命令。

更重的手段是本机 `vibeterm user passwd <user> --full-reset`（`rotate-root` 全量重置会移除全部通行密钥与 TOTP）。

### 滚动升级注意

- 二次验证按**节点**各自执行：未升级的节点仍只验密码，知道密码的人经 `/n/<旧节点>/api/auth/login` 可以拿到该旧节点的会话；旧入口也会把新节点的 `PASSKEY_REQUIRED` 改写成 `NODE_LOGIN_REQUIRED`。注册通行密钥前把全部节点升到最新（节点管理里可批量升级）。
- CLI 加入走 `vibeterm relay join`（`r3.` 令牌或 `--tenant` + 口令），不再有顶层 `vibeterm enroll`。`GET /api/auth/mode` 的 `secondFactorPolicy === 'passkey'`（旧节点没有该字段时回退到 `passkeySecondFactor && !totpEnabled`）时密码登录路径仍不可用（CLI 做不了 WebAuthn），会在提示输入密码前直接给出说明。`'either'` / `'totp'` 走密码 + TOTP。加入节点请在网页「设置 → 多节点互联 → 节点管理 → 添加 → 生成加入码」后使用 `vibeterm relay join`。
- `passkeysRegisteredElsewhere` / `secondFactorPolicy` 都是加性字段，旧前端忽略即可；新节点在旧前端下 `passkeySecondFactor` 变 false，登录流程更短，不会出错。旧前端若仍按 AND 同时交 TOTP 与断言，服务端照收。

## 5. 公网暴露的安全评估

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| 高（条件） | 未 bootstrap 的新实例经隧道连 `127.0.0.1` 时可远程创建首个账户 | 已修（§3）；运维上仍应先在本机 bootstrap 再暴露 |
| 高（条件） | 裸 `@vibeterm/gateway start` 入口不装会话守卫 | 不改：该入口仅开发用，打包运行时（`packages/app` 装配）才是公网形态 |
| 高 | HTTP 直连暴露时会话可被嗅探；cookie `Secure` 依赖 HTTPS 探测 | 不改代码：公网一律走 Tunnel HTTPS 或自配 TLS，反代后开 `VIBETERM_TRUST_PROXY` |
| 中 | 限流 IP 桶在隧道后全员共桶 | 已修（§3、§7）：反代后开 `VIBETERM_TRUST_PROXY` 并按代理选 `VIBETERM_CLIENT_IP_HEADER`；未开时按配置头声称地址拆桶，记录仍是套接字地址 |
| 中 | 账号密码强度 | 设置 / 修改账号密码时强制 12 位下限与弱密码规则（§1.1）；KDF 参数不变，已有密码不强制更换；建议用密码管理器生成 16+ 位或改用 passkey |
| 中 | agent 会话 / 文件传输 API 无按用户归属检查 | 不改：VibeTerm 每节点单用户（`findPrimaryUser`），不承诺多用户隔离 |
| 低 | 登录可枚举用户名 | 用户名枚举已由失败模糊化收口（§2）；用户名不是安全边界 |
| 中 | 浏览器请求的 Origin / Host 校验 | 分发入口统一校验 Origin / `Sec-Fetch-Site`，免登录单机另校验 Host（§10） |
| 低 | TOTP 由同一密码派生，不是独立第二因子 | 不改；不宣传为 MFA，需要第二因子用 passkey |
| 低 | 未登录 `GET /api/auth/nodes` 的返回范围 | 匿名只回当前节点 `{id}`；完整 `{id,name,online}` 仅有效会话。登录页实际只打 `/api/auth/mode`，不依赖这份名册 |

**明确不做的事（避免过度防御）**：服务端 bcrypt/argon2 密码哈希（现有 challenge 签名设计更优）；全站锁定；JWT / localStorage token / WS `?token=`；给 peer 握手再加口令层；收紧 passkey 域名绑定。IP 阶梯与账号暂停见 §7，不再把「不做指数退避」当成结论。

下面几项评估过、这一版不加：

| 项 | 原因 |
|---|---|
| 对已登录会话隐藏 `GET /api/auth/nodes` | 名册是 fan-out 与节点管理的输入；匿名面已收成当前节点 id，会话门后面仍给完整 `{id,name,online}` |
| 收掉中继 `healthz` 的字段 | 拨号与自动优选用这份探测；不在登录面收口 |
| 加长分享口令最短长度 | 分享口令规则保持现状 |
| 把登录各分支的耗时对齐 | challenge 签名路径不做密码哈希比较，不另加填充 |
| HSTS、CSRF token | HSTS 会打坏 localhost 与自签。CSRF 由 §10 的 Origin 门挡住，不另发 token |

**暴力破解的现实评估**：在线速率由 §7 的策略决定（缺省同一 IP 15 min 内 10 次失败即锁定，账号每小时超过 50 次则暂停密码登录）。argon2 在浏览器侧，不构成服务端成本。分布式源 IP 仍受账号软顶约束；通行密钥直接登录不受这道暂停影响。离线需先拿到 DB（根公钥 + KDF 参数），argon2id 64 MiB 单次派生成本高，随机 16+ 位密码即可忽略；账号密码的最低要求见 §1.1。重启会清掉内存里的锁定，这是有意的。

## 6. 审计日志

网关对每次认证尝试打一条 info 日志（不限流；不含密码、TOTP 码、会话 id、密钥或完整 cookie；客户端 IP 按 IPv4 `/24` 或 IPv6 `/48` 脱敏，peer 记为 `peer`）。失败码在日志里保留内部精确值，对客户端的模糊化不变。TOTP 锁定只在进入锁定时打一行，锁定期间的拒绝仍走 `login failed`。密钥日志若产生撤销会话效果，额外打 `session revoked`。

```
[auth] login ok uid=<uid> via=self|<nodeId> method=root|passkey second=totp|passkey|waived|none ip=<masked> origin=<origin>
[auth] login failed uid=<uid> code=<CODE> ip=<masked>
[auth] login locked uid=<uid> until=<ISO-8601> reason=totp_failures
[auth] logout uid=<uid> sessions=<N>
[auth] session revoked uid=<uid> reason=revokeAllSessions|revokeSessionsByCredential|revokeSessionsVia
```

## 7. 登录限制（`login-policy`）

全网一份策略，记在密钥日志类型 `login-policy` 上，签名者 `root` / `passkey`，最低节点版本 `2.10.0`（`MIN_LOGIN_POLICY_RECORD_VERSION`）。任一未吊销节点版本未知或低于该版本时，写入 fail-closed，与 `notification-sink` 同一套。没有任何记录的节点用预设 `standard`。策略在检查当时读当前投影；历史行解不开则忽略，回落 `standard`。

`exemptLocal` 在三档预设里缺省都是 true，命名预设也允许单独改它。非 `custom` 时数值必须与预设一致。`custom` 范围：`ipFailThreshold` 3–100；`ipLockBaseMs` 1 min–24 h；`ipLockMaxMs` 从 base 到 7 d；`accountFailPerHour` 10–1000；`accountLockMs` 1 min–24 h。网关、网页和 CLI 共用 `validateLoginPolicy()`。

| 预设 | IP 失败阈值 | 首次锁定 | 阶梯上限 | 账号每小时 | 账号暂停 |
|---|---|---|---|---|---|
| `relaxed` | 20 | 5 min | 1 h | 100 | 5 min |
| `standard`（缺省） | 10 | 15 min | 24 h | 50 | 15 min |
| `strict` | 5 | 30 min | 7 d | 20 | 1 h |

**IP 阶梯**（`LoginPolicyLimiter`）：按客户端 IP 计凭证失败。窗口长度是 `ipLockBaseMs`。窗口内次数达到 `ipFailThreshold` 时锁定该 IP，时长 `ipLockBaseMs × 2^n`，封顶 `ipLockMaxMs`。`n` 是该 IP 在最近 24 h 内已经发生过的锁次数。该 IP 登录成功只清失败计数，不清阶梯历史。锁定期间再失败不追加计数。

**账号软顶**：该 uid 在滚动 60 min 内的失败次数超过 `accountFailPerHour` 时，暂停 `method=root` 的密码登录 `accountLockMs`。通行密钥直接登录（`method=passkey`）不停。暂停开始时清空该 uid 的失败窗口，暂停期间的失败不入窗口；到期后要重新累计超过 `accountFailPerHour` 次失败才会再次暂停，单次请求不能把账号重新打回暂停。`TOTP_REQUIRED` / `PASSKEY_REQUIRED` 不计。TOTP 自己的桶不变。

**`exemptLocal`**：同时跳过 IP 阶梯和账号软顶。判定就是 §4 的可信本地来源（`isTrustedLocalClient`）：策略打开、入口直达且不是 peer 入站、请求没有经代理的迹象、`Host` 是本机认得的名字、套接字是回环或局域网。这些失败仍写入登录历史，但不进两道限流的窗口，所以本机失败既不会锁自己，也不能用来暂停公网的密码登录。反代后面要让真实客户端 IP 进阶梯，打开 `VIBETERM_TRUST_PROXY`；不开则走 §3 的 `proxied:` 桶，豁免也不会命中。

入口转发的登录只计 IP。目标节点只计规范 uid。账号桶不会因为经过入口而记两次。

IP 表与 uid 表各自硬顶 1 万条，超出时按最久未触碰淘汰空闲条目；全是活跃锁时，淘汰最早到期的锁。状态只在进程内，重启即清。

**已知限制**：

- 「本机」指本机任意 uid 与整个局域网，不区分用户。多用户主机（共享开发机、跳板机）应关闭 `exemptLocal`，并用通行密钥或 TOTP 作为强因素。
- 落到回环 / 局域网的 TCP 层转发（`frp`、`ssh -R`、socat、LXD `proxy` 设备不带 `nat=true` 等）不加 HTTP 头，在 HTTP 层与本机客户端无法区分。这类部署应关闭 `exemptLocal`，并先在本机完成初始化再暴露端口；能改成 HTTP 反代（带转发头）的优先改。
- 反代后未开 `VIBETERM_TRUST_PROXY` 时，按配置头的声称值分别计失败行配额（见 §8），总量仍受 2 万行上限约束。

`GET /api/auth/login-policy`（要会话，本节点）：`{ policy, source: 'default'|'keylog', writable, blockers }`。`blockers` 是未吊销且低于最低版本的节点。写入与 TOTP 相同：客户端签 `login-policy`，`POST /api/auth/keylog`，服务端用 `validateLoginPolicy` 验载荷。`source === 'keylog'` 时，低于 2.10.0 的节点放不回这条记录；接纳或重新接纳之前应先升级。接口不因此拒绝接纳。网页在「账号安全 → 登录限制」里改预设或自定义字段，保存时走与 TOTP 相同的凭据签名；`writable=false` 时列出阻挡节点。CLI 见 [命令行使用手册](../operations/cli-usage.md)。

## 8. 登录历史

每台节点只存自己处理过的登录，没有全网一张表。表 `login_records`：`id`、`at`（毫秒）、`outcome`（`success`|`failed`）、`uid`、`username`、`method`（`root`|`passkey`）、`second`（`totp`|`passkey`|`waived`|`none`）、`client`（`web`|`cli`|`unknown`）、`kind`（`interactive`|`background`）、`via_node_id`、`target_node_id`、`ip`（完整，不脱敏）、`user_agent`（截断 512）、`origin`、`code`（成功为 null）。

`kind`：这次登录的入口就是本节点 → `interactive`；经别的入口 fan-out 过来 → `background`。`client` 来自 `x-vibeterm-client: web|cli`，其它或缺失为 `unknown`。网页和 CLI 的 challenge / login / passkey options 都带这个头。入口转发 `/n/:id/api/auth/*` 时原样带上，并写入 `x-vibeterm-entry-client-ip`（入口看到的真实 IP）和 `user-agent`。

目标节点只在 peer 入站、且该入口在节点表和 `peer_cache` 里**每一份**已知版本都 ≥ 2.10.0 时，才把这条 IP 写入记录。缺一份、或任一份更低，IP 记 null（fail-closed）。直连请求删掉同名头，改用 `resolveClientIp`。分享配额不读这个头（[KI-8](../known-issues.md)）。

写入点：`handleLogin` 成功；凭证类失败（`INVALID_CREDENTIALS` 及其同类、`TOTP_INVALID`、`PASSKEY_INVALID`、锁定 / 暂停 429、畸形与 challenge 错误）。不写 `TOTP_REQUIRED` / `PASSKEY_REQUIRED`。入口侧 429 由入口记一行，`target_node_id` 指向目标，`kind=interactive`；只记这一次，不在目标上再记一笔。凭证类失败按限流键（`proxied:` 声称值或解析出的 IP，再加 uid）每分钟最多 6 行；锁定或暂停生效期间的 `RATE_LIMITED` / `PASSWORD_LOGIN_PAUSED` 同一把钥匙最多每 60 s 一行。成功不限。写入失败只打日志，不拖慢、不打断登录。

保留：`retentionDays` ∈ {7, 30, 90, 180, 0}，0 为永久，缺省 90，存在该节点的 `gateway_kv`。每小时扫一次。成功与失败各自硬顶 20 000 行，超出删最旧的。进程重启后，60 s 节流重新计。

`GET /api/auth/login-records`（要会话；远端经 `/n/<id>/…`）：查询 `outcome=success|failed`、`kind=interactive|all`（只过滤成功；失败始终含两种 kind）、`limit` 1–500（缺省 200）、`before` + `beforeId`。响应 `{ records, nextBefore: { at, id } | null }`，按 `at` 降序，同一毫秒再按 `id` 降序。`DELETE /api/auth/login-records` → `{ deleted }`。`GET` / `PUT /api/auth/login-records/settings` 的体是 `{ retentionDays }`，非法 400。节点低于 2.10.0 时这些路由是 405。

网页：设置 → 多节点互联 → 本机卡片菜单「登录历史」。对在线、已登录、版本达标的节点 fan-out；离线、需升级、需登录以状态芯片标出。成功页缺省只看 `interactive`，可打开「显示后台登录」。保留时间与清空作用到所有可达节点，跳过的节点会说明。账号安全面板的「登录限制」即 §7。

## 9. 登录后跳转、初始化与嵌入

登录页的 `next` 只接受本站路径：以单个 `/` 开头，不含 `//`、反斜杠、方案和控制字符，否则落到 `/`。

`/api/setup/*`（含 `precheck`）：已经有用户，或本机认证已生效时，要求与其它 `/api/*` 相同的有效会话，否则 `UNAUTHORIZED`。在那之前只允许回环套接字且不带代理头，否则 `403 LOOPBACK_REQUIRED`。设置向导把这两个码显示成「请先登录。」与「请在本机完成初始化。」

装配运行时的 HTML 响应带 `Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`（`packages/app/src/runtime/serve-frontend.ts` `SPA_CSP`）：只允许同源脚本文件与 ghostty 的 WebAssembly 编译，不允许内联脚本与 `eval` / `new Function`。前端构建产物不含内联脚本；mermaid 依赖里 d3-dsv 的 `new Function` 只在解析 CSV 时调用，图表渲染用不到。没有 HSTS。

## 10. 浏览器请求入口门（Origin / Host）

`packages/app/src/runtime/assemble-routes.ts` `createHttpDispatch` 在所有处理器（含各类 WebSocket 升级）之前调用 `guardBrowserRequest`（`apps/gateway/src/mesh/browser-request-guard.ts`），只看本机直连请求（`via=self`），节点间转发进来的流不受影响。exec 通道原先各自做的 Origin 检查已并入这里。不经装配分发的独立入口（裸 dev gateway `apps/gateway/src/index.ts`、managed 二进制 `managed-entry.ts`）在 `guardedGatewayFetch`（`apps/gateway/src/tunnel/gateway-fetch.ts`）里调用同一个门，并按免登录单机处理（这两个运行时本身没有登录门）。peer 端口不是浏览器入口，不经这道门。

| 请求 | 规则 | 拒绝 |
| --- | --- | --- |
| 每个 WebSocket 升级（`/ws`、`/n/:id/ws`、`/api/exec/ws`、`/n/:id/api/exec/ws`、分享 WS、`/relay/uplink` 等）与每个 `POST` / `PUT` / `PATCH` / `DELETE` | `Sec-Fetch-Site: cross-site` 直接拒；带 `Origin` 时必须与请求同源（按 `publicRequestUrl` 的 scheme + host + port；页面 https、本机看到 http 的同主机也算同源），或是本实例自己的入口地址（`VIBETERM_BASE_URL`、站点 URL、隧道域名、本机担任中继时的 `VIBETERM_RELAY_PUBLIC_URL`、分享默认地址；不含已接入的其它中继——经中继访问的请求在本节点是 peer 入站，不经这道门）。`Origin: null` 与非 http(s) origin 一律视为外来 | `403 FOREIGN_ORIGIN`（`/api/*`、`/n/:id/api/*` 回 JSON `{error:{code}}`，其余回 text/plain） |
| 不带 `Origin` 的请求（CLI、curl、节点拨中继、同源 GET） | 放行 | — |
| 免登录单机（standalone 且本机登录门未生效）的所有请求 | `Host`（信任代理时连同 `X-Forwarded-Host`）必须是 IP 字面量、`localhost` / `*.localhost`、本机 mDNS 名 `<os.hostname()>.local`，或已配置的域名（`listDomainAccessHosts` 与上面的入口地址）；其它 `.local` 名不算 | `421 MISDIRECTED_HOST` |

要点：

- 已登录模式不回 421，但同一 Host 规则用在 §3 / §4 的本机判定里：`Host` 不是本机认得的名字时，回环 / 局域网套接字也不享受通行密钥豁免、`exemptLocal`、setup 与本机 bootstrap。
- 用自定义域名访问免登录单机时，先把它写进站点 URL 或 `VIBETERM_BASE_URL`，否则 421。
- 反代改写了 `Host` 却没开 `VIBETERM_TRUST_PROXY` 时，浏览器的 `Origin` 只能靠「已配置入口地址」放行；站点 URL 留空会导致 403。
- CLI 带 `Origin` = 入口 URL，与请求同源，不受影响。
- 裸开发入口经 vite 代理时，`/api` 代理保留浏览器的 `Host`（不改写为 gateway 地址），与 `Origin` 同源。
- 混跑：只影响本节点的浏览器入口，不改任何节点间协议；2.14.0 入口仍按旧行为放行，它转发到新目标的请求在目标侧是 peer 入站，不重复校验。

