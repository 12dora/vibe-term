# 公网登录面：客户端 IP 与首次 bootstrap 本机判定

## 背景

登录失败限流（每 IP / 每 UID 各 10 次 / 60 秒）原先只取 `Bun.Server.requestIP()`。经 Cloudflare Tunnel 或反向代理时，所有访客共享隧道 agent 的 socket IP：一人打满会误伤全站，分布式撞库则绕过 IP 桶。

未 bootstrap 的实例若经隧道连到 `127.0.0.1`，socket IP 会被当成 loopback，远端可调用 `/api/auth/local/bootstrap` 创建首个账户。

## 客户端 IP 解析

`resolveClientIp({ socketIp, headers, trustProxy })`：

- `TMEX_TRUST_PROXY` 未开启：始终用 socket IP，忽略转发头。
- 已开启时按序取第一个**合法 IPv4/IPv6 字面量**（trim；非法则跳过）：
  1. `CF-Connecting-IP`
  2. `X-Real-IP`（nginx 的 `$remote_addr`，客户端无法伪造）
  3. `X-Forwarded-For` 的**最后一个非空**条目（`proxy_add_x_forwarded_for` 把真实客户端追加在末尾；首段由客户端自带、可伪造，取首段会让限流被随机 XFF 绕过）。末段不是合法字面量时不回退到更早的条目。
  4. 回退 socket IP

（2026-09-02 起顺序如上；此前是 XFF 首段优先。）

登录限流的 IP 桶使用该结果；UID 桶与阈值不变。

## 部署

Cloudflare Tunnel / 反代后面**必须**打开 `TMEX_TRUST_PROXY`（隧道管理器也可写入 host env）。未打开时转发头一律不信，限流仍按 socket IP。不要在不可信跳数前开启。

## Bootstrap loopback

`/api/auth/local/bootstrap`（及其他本机预会话路径）的 loopback 判定：

- 请求带 `CF-Connecting-IP`（Cloudflare 才会加；本机直连不会带）即视为非本机，与是否信任代理无关——信任模式下也不解析其值，避免代理保留的 `127.0.0.1` / 非法值重新打开 bootstrap。
- 否则 `trustProxy=true`：用上面解析出的客户端 IP（隧道访客不是 127.0.0.1，因此不能 bootstrap）。
- 否则 `trustProxy=false`：仍用 socket IP；`X-Forwarded-For` 在未信任时忽略，行为与原先一致。

首次部署应先在本机完成 bootstrap，再对外暴露隧道。

## 未登录面的资源上限（2026-09-02）

- `readJsonObjectBody` / `readJsonBody` 统一封顶 1 MiB（`JSON_BODY_MAX_BYTES`）：`Content-Length` 超限直接拒；否则流式累计，超限即取消读取并按 `MALFORMED` 处理。登录、挑战、passkey、enrollment redeem、setup 全部经此两处；分块上传走自己的 8 MiB 上限，不受影响。
- 挑战存储上限 4096 条（先清过期，再按插入序淘汰最旧）。
- 登录失败限流表：空 key 即删，key 数上限 1 万，每 256 次记录做一次全表清理。
- `POST /api/auth/challenge` 与 `POST /api/auth/passkey/login/options` 按客户端 IP 限速（每 60 秒 60 次，超出 `429 RATE_LIMITED`）。
