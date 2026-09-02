# 1.1.18

_2026-09-02_

## English

### Security

- Sign-in failures no longer reveal why they failed: an unknown user, a wrong password and a bad session signature all return the same `INVALID_CREDENTIALS` and the same neutral message. Requesting a challenge for an unknown user no longer returns 404.
- Passkeys now act as a mandatory second factor: once an account has at least one passkey registered, password sign-in also asks for the passkey (one prompt per sign-in; the same proof is reused for every node for the session lifetime). Removing every passkey turns the check off again. Passkey-only sign-in is unchanged.
- `/api/auth/mode` returns the root public key only to signed-in callers, so the public KDF parameters can no longer be combined with it for offline password cracking.
- Challenge and passkey-option requests are rate-limited per client IP; unauthenticated JSON bodies are capped at 1 MiB; the challenge store and the sign-in rate-limit table are bounded.
- Behind a reverse proxy with `TMEX_TRUST_PROXY`, the client IP is now taken from `CF-Connecting-IP`, then `X-Real-IP`, then the last `X-Forwarded-For` entry (the first entry is attacker-controlled and could bypass rate limiting).

### Fixes

- The HTTPS section now shows the effective public HTTPS state ("served by reverse proxy", confirmed by the current request or inferred from the public address) instead of only reporting tmex's built-in listener as "off" behind nginx, Baota or a Cloudflare Tunnel, and suggests switching to the external reverse-proxy mode when TLS is terminated in front of tmex.
- Full-screen TUIs (Claude Code, vim, htop) no longer overflow on phones when the same pane is also open on a desktop: the shared tmux window now follows the narrowest visible client instead of the largest one.

---

## 中文

### 安全

- 登录失败不再区分原因：用户不存在、密码错误、会话签名错误统一返回 `INVALID_CREDENTIALS` 与同一句提示；为未知用户申请挑战也不再返回 404。
- 通行密钥成为强制二次验证：账号注册了至少一把通行密钥后，密码登录也需要通过通行密钥验证（每次登录只弹一次，同一份验证在会话期内复用于所有节点）；移除全部通行密钥即关闭。仅用通行密钥登录不受影响。
- `/api/auth/mode` 只对已登录请求返回根公钥，公开的 KDF 参数无法再与之组合做离线密码爆破。
- 挑战与通行密钥选项请求按客户端 IP 限速；未登录的 JSON 请求体封顶 1 MiB；挑战存储与登录限流表设上限。
- 反向代理后开启 `TMEX_TRUST_PROXY` 时，客户端 IP 依次取 `CF-Connecting-IP`、`X-Real-IP`、`X-Forwarded-For` 的最后一段（首段由客户端自带、可伪造绕过限流）。

### 修复

- HTTPS 设置区显示对外有效的 HTTPS 状态（「由反向代理提供」，并注明是经当前请求确认还是按公开地址推断），不再在 nginx、宝塔或 Cloudflare Tunnel 终止 TLS 时只显示内置监听器「关闭」；TLS 在 tmex 之前终止时会提示切换到外部反向代理模式。
- 同一个 pane 同时在桌面和手机上打开时，全屏 TUI（Claude Code、vim、htop）不再在手机上溢出：共享的 tmux 窗口尺寸改为跟随最窄的可见客户端，而不是最大的。
