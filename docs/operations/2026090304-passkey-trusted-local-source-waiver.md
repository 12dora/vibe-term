# 可信本地来源免通行密钥二次验证

## 背景

1.1.18 的通行密钥二次验证按「用户名下任意 origin 注册了通行密钥」判定，通行密钥经密钥日志同步到全部节点，所以每个节点都强制。WebAuthn 不允许 IP 字面量 origin（`http://127.0.0.1:9883`、`http://192.168.1.5:9883`），这些地址永远无法注册通行密钥：在这类地址用密码登录会停在 `NO_PASSKEY_FOR_ORIGIN`；若入口还留着旧会话，浏览器对 hub 的静默登录（经入口 forwarder `/n/<hub>/api/auth/login`）会被 hub 以 `PASSKEY_REQUIRED` 拒绝，节点管理只显示「Hub 不可达」。

第十九轮的域名访问策略（`docs/operations/2026090302-domain-access-policy.md`）已经把「本机 / 内网 / CGNAT 源地址」定义为可信来源，本轮把同一分类用于通行密钥二次验证。

## 规则

- **判定对象是客户端源 IP，不是 Host / Origin**（这两个头由客户端控制）。
- 入口节点直达请求（`via=self`）满足以下全部条件即为可信本地来源（`apps/gateway/src/mesh/client-source.ts` `isTrustedLocalClient`）：
  - 没有 `cf-connecting-ip` 头（Cloudflare 才会加，出现即远端）；
  - `TMEX_TRUST_PROXY` 关闭时请求不带 `x-forwarded-for` / `x-real-ip`（fail-closed：反代后面不开信任代理头，就不会把所有公网客户端当成回环）；
  - 解析出的客户端 IP（信任代理时取 `cf-connecting-ip → x-real-ip → XFF 末段`）属于回环 / RFC1918 / link-local / IPv6 ULA / CGNAT 100.64/10；缺失即否。
- 可信本地来源的密码登录不要求通行密钥断言；`GET /api/auth/mode` 返回 `passkeySecondFactor=false`、`passkeySecondFactorWaived=true`。密码、TOTP、限速照旧。
- **下游传递**：入口 forwarder 转发 `/n/<id>/...` 时，若浏览器源为可信本地，则在转发头加 `x-tmex-client-source: local`；浏览器自带的该头一律丢弃。目标节点只在请求来自认证 peer 链路（`clientIp=peer:<入口>`）时认这个头，直达请求带此头无效。
- 通行密钥直接登录（`method=passkey`）不受影响。

## 安全边界

信任的是 mesh 成员身份（认证 peer 链路），不是头本身。被攻陷的成员节点可以为经它登录的浏览器免掉通行密钥——该节点本就能中转该用户的终端会话，属于既有信任面。不做签名断言：链路已经认证加密，签名不增加保护。不提供关闭开关。

## e2e

Playwright 浏览器的源地址就是回环。mesh e2e 实例以 `TMEX_TRUST_PROXY=true` 启动，严格路径用例给 context 加 `x-forwarded-for: 203.0.113.9` 模拟公网源；另有用例验证回环免二次验证且 hub 管理可达。
