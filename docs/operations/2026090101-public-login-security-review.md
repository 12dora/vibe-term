# 公网启用账号密码登录的安全评估

## 背景

tmex 可经 Cloudflare Tunnel 或直连端口暴露到公网，并启用账号密码登录（`local-auth`）。本文回答「暴露后实际风险有多大、值得改什么」，原则是只改有实际收益的点，**不做过度防御**。结论基于 2026-09-01 的源码审计（探索记录 `prompt-archives/2026090101-round11-pwa-files-auth/sub/EX4-result.md`）。

## 现有机制（比常规密码登录强）

- **密码不出浏览器**：浏览器用 argon2id（64 MiB / 3 轮 / 1 lane）把密码派生成 Ed25519 根钥，签 challenge 登录；网关只存根公钥与 KDF 参数，没有密码哈希（`apps/fe/src/auth/session-login.ts`、`packages/shared/src/auth/root-key.ts`、`apps/gateway/src/mesh/auth-routes.ts`）。
- **会话**：256-bit 随机不透明 SID，DB 记录，18 h 滑动 / 7 d 硬上限，可撤销，按节点绑定 `viaNodeId`；cookie `HttpOnly` + `SameSite=Lax`，HTTPS 下 `Secure`；WS 复用 cookie，URL 不带 token；改密/登出即失效全部会话。
- **限流**：登录失败每 IP、每 UID 各 10 次 / 60 s（内存）。
- **passkey**：严格 origin/RP 绑定；**mesh peer 端口（39001）**用节点证书 + 握手签名鉴权，与用户密码无关。
- **文件 API**：目录根限定、路径穿越与符号链接逃逸有检查；Telegram/微信为轮询，无入站 webhook。

## 发现与处置

| 级别 | 发现 | 处置 |
| --- | --- | --- |
| 高（条件） | 未 bootstrap 的新实例经隧道连 `127.0.0.1` 时，远端请求被当作 loopback，可调用 `/api/auth/local/bootstrap` 创建首个账户 | **已修**：`resolveClientIp` + `requestIsLoopback`（详见 `2026090101-public-login-hardening.md`）；运维上仍应先在本机 bootstrap 再暴露 |
| 高（条件） | 裸 `@tmex/gateway start` 入口不装会话守卫 | 不改：该入口仅开发用，打包运行时（`packages/app` 装配）才是公网形态；文档注明 |
| 高 | HTTP 直连暴露时会话可被嗅探；cookie `Secure` 依赖 HTTPS 探测 | 不改代码：公网一律走 Tunnel HTTPS 或自配 TLS，反代后开 `TMEX_TRUST_PROXY` |
| 中 | 限流 IP 桶在隧道后全员共桶（误伤为主，非绕过） | **已修**：信任代理时按 `CF-Connecting-IP`/`X-Forwarded-For`/`X-Real-IP` 分桶 |
| 中 | 密码最短 8 位、无复杂度要求；拿到 DB 可离线撞根公钥 | 不改：argon2id 已足够贵；建议用密码管理器生成 16+ 位或改用 passkey。**不加复杂度规则** |
| 中 | agent 会话 / 文件传输 API 无按用户归属检查 | 不改：tmex 每节点单用户（`findPrimaryUser`），不承诺多用户隔离 |
| 低 | 登录 404/401 可枚举用户名；无持久审计日志 | 不改：用户名不是安全边界；限流已覆盖 |
| 低 | 无通用 Origin 校验，CSRF 依赖 `SameSite=Lax` + 无 CORS 放行 | 不改：当前威胁模型足够 |
| 低 | TOTP 由同一密码派生，不是独立第二因子 | 不改；不宣传为 MFA，需要第二因子用 passkey |

## 明确不做的事（避免过度防御）

- 服务端 bcrypt/argon2 密码哈希（现有 challenge 签名设计更优）。
- 全局锁定、指数退避、密码复杂度规则（增加误锁与摩擦，UID 桶已限住单账户撞库）。
- JWT / localStorage token / WS `?token=`（比 cookie 会话更差）。
- 全站 HSTS（localhost 与自签场景会被打坏；有需要在公网边缘配）。
- 给 peer 握手再加口令层；收紧 passkey 域名绑定。

## 暴力破解的现实评估

在线：每 IP、每 UID 各 ≈ 0.17 次/秒（限流决定，argon2 在浏览器侧不构成服务端成本）；分布式源 IP 也受 UID 桶约束。离线：需先拿到 DB（根公钥 + KDF 参数），argon2id 64 MiB 单次派生成本高，随机 16+ 位密码即可忽略。

## 与跨节点静默登录的关系

round11 引入的会话钥持久化（`docs/hub/2026082700-hub-node-architecture.md` §2）不改变节点侧校验：节点 B 仍要求根钥签的 delegation + 一次性 challenge + `target/target_pk` 绑定，A 的 SID / login 不能重放到 B（集成测试已覆盖）。持久化的私钥为 WebCrypto 不可导出 CryptoKey，风险等级与既有 HttpOnly cookie 相同，上限为 delegation 18 h。
