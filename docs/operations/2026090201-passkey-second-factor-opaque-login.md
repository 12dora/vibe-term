# 登录失败模糊化与通行密钥二次验证

## 背景

tmex 准备暴露到公网。此前登录失败会区分「用户不存在」（404）与「密码不正确」（`DELEGATION_BAD_SIGNATURE`），`/api/auth/mode` 对未登录请求返回根公钥，注册了通行密钥的账号仍可仅凭密码登录。本轮把这三处补齐，同时避免过度防御。

## 登录失败模糊化

密码登录（`Delegation.method = root`）的凭证类失败统一为 `401 {code: "INVALID_CREDENTIALS"}`：

| 场景 | 旧 | 新 |
|---|---|---|
| `POST /api/auth/challenge` 未知 uid | `404 UNKNOWN_USER` | 正常签发挑战（uid 存原串，登录阶段才失败） |
| `POST /api/auth/login` 未知用户 | `404 UNKNOWN_USER` | `401 INVALID_CREDENTIALS` |
| root delegation 签名错（密码错） | `DELEGATION_BAD_SIGNATURE` | `INVALID_CREDENTIALS` |
| login 会话签名错 | `BAD_SIGNATURE` | `INVALID_CREDENTIALS` |
| `passkey/login/options` 未知用户 | `404 UNKNOWN_USER` | `404 NO_PASSKEY_FOR_ORIGIN`（与「本 origin 无凭证」相同） |

结构性错误（`MALFORMED`、`CHALLENGE_*`、`*_MISMATCH`、`DELEGATION_EXPIRED` 等）、`RATE_LIMITED`、`TOTP_*` 保持原码；passkey 直接登录失败仍是 `DELEGATION_BAD_SIGNATURE`（前端显示「通行密钥校验失败」）。`TOTP_REQUIRED` / `PASSKEY_REQUIRED` 不再计入限流失败次数。

前端密码路径把 `INVALID_CREDENTIALS` 与旧码（`DELEGATION_BAD_SIGNATURE`、`BAD_SIGNATURE`、`UNKNOWN_USER` 等，兼容未升级节点）统一显示为「用户名或密码错误。」。`/n/:id/api/auth/{challenge,login}` 的 401 不再被 forwarder 改写成 `NODE_LOGIN_REQUIRED`，目标节点的原码直达浏览器。

`GET /api/auth/mode` 只对携带有效会话的请求返回 `rootPublicKey`，未登录为 `null`：根公钥加公开的 Argon2 参数等于离线爆破密码的 oracle，而登录页只需要 `kdfParams`；账号安全面板、节点接入面板、CLI `hub-client` 等消费方都已登录或只读 `uid`/`kdfParams`。

## 通行密钥二次验证

**策略**：用户名下任意 origin 注册了 ≥1 把通行密钥，则密码登录必须附带一次通行密钥断言；移除全部通行密钥即自动关闭。判定依据是「任意 origin」而非「当前 origin」——`Origin` 头由客户端控制，按 origin 判定会被伪造头绕过。TOTP 与通行密钥相互独立，都启用则都要（顺序 TOTP 先）。passkey 直接登录（`method = passkey`，UV 必需）本身就是强认证，不叠加二次验证。

**协议**（与 passkey 直接登录同构，不新增端点、不新增表）：

- `GET /api/auth/mode` 增加 `passkeySecondFactor: boolean`。
- 登录体增加可选 `passkey: { credential_id, sig }`，`sig = base64url(borsh(PasskeyAssertion))`，WebAuthn challenge 固定为 `sha256(borsh(Delegation))`（root delegation）。前端在 root 签完 delegation 后调用现有 `POST /api/auth/passkey/login/options {uid, delegation}` 拿本 origin 的 `allowCredentials` 做一次仪式。
- 服务端 `checkPasskeySecondFactor`：`method ≠ root` 或用户无通行密钥 → 通过；缺 `passkey` → `401 PASSKEY_REQUIRED`；断言经现有 `makeVerifyDelegationPasskey` 校验（凭证属于该 uid、delegation 时间、注册 origin/rpId、签名、counter 单调）失败 → `401 PASSKEY_INVALID`。会话仍记为 `delegationMethod = root`。

断言绑定到 delegation（含 `sess_pk` 与有效期），一份断言可随 delegation 在 18 小时内复用于所有节点的静默登录（每节点各自维护 counter），只需一次 Face ID / 指纹；前端把 `passkeyCredentialId` / `passkeySig` 与 delegation 一起持久化（它们是签名不是秘密）。这正是采用「断言随信封」而非「两段式新端点」的原因：后者会让每个节点的登录都弹一次仪式，而 `ensureNodeLogin` 的静默 fan-out 无法弹窗。

**前端行为**：`mode.passkeySecondFactor` 为真时在提交密码后进入「请完成通行密钥验证…」阶段；本 origin 无凭证（`NO_PASSKEY_FOR_ORIGIN`）提示到已注册的地址登录后为本地址添加通行密钥；服务端回 `PASSKEY_REQUIRED`（mode 快照过期）则当场补仪式并换新挑战重试一次；`PASSKEY_INVALID` 视为凭证失败，丢会话钥回登录页（同一份断言重发不会变对）。账号安全面板通行密钥区说明该规则。

## 风险与恢复

- 只在一个 origin 注册了通行密钥，又必须从另一个 origin（如局域网 IP）登录：会被 `PASSKEY_REQUIRED` 挡住。恢复路径：在已注册地址登录后为新地址添加通行密钥；或在主 hub 上 `tmex hub user passwd <user> --full-reset`（`rotate-root` 全量重置会移除全部通行密钥）。
- 滚动升级期间旧节点仍返回 `UNKNOWN_USER` / `DELEGATION_BAD_SIGNATURE`，前端已兼容映射；旧节点不认识 `passkey` 字段会忽略它，不会拒登。
