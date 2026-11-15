# 分享口令登录限流

本文说明分享链接口令登录（`POST /api/share-access/:id/login`）的公平限流策略，面向改动 `apps/gateway/src/share/share-rate-limit.ts` 与入口 `ShareLoginQuota` 的开发者。账号密码登录限制见 [登录面安全 §7](./login-security.md#7-登录限制login-policy)，分享数据模型与接口见 [终端分享](../architecture/terminal-share.md)。

## 目标

口令校验走 argon2，不能让轮换来源把整条分享锁死，也不能让同一 IP 无间隔穷举。错误码保持 `SHARE_LOGIN_LOCKED`（带准确的 `retryAfterMs`）与 `SHARE_LOGIN_BUSY`，前端倒计时不用改。

## 策略

1. **(分享, 客户端 IP)**，IPv6 按 `/64` 归桶（`limiterIpKey`）。前 3 次失败不限制；之后下一次校验前指数退避 2 s、4 s、8 s …，封顶 15 min。成功清空这一桶。同一 (分享, IP) 并发验证最多 2 个，超出回 `busy`（`retryAfterMs=1000`）。
2. **分享级反轮换**：滑动 1 h 窗口内失败 ≥ 50 次后：
   - **干净来源不延迟**：(分享, IP) 桶失败次数为 0，或该 (分享, IP) 在近 24 h 内成功过。
   - **脏来源**（窗口内有过失败，或 IP 未知）整条分享每 30 s 最多一次校验。
   - 任一 IP 的成功不清其它 IP 的退避，也不清分享失败窗；分享失败只随 1 h 窗口滑出。
3. **未知 IP**（`UNKNOWN_CLIENT_KEY` / `unknown`）永远视为脏来源，不享受干净规则。
4. **进程级**：同时进行的分享口令 argon2 校验最多 4 个，超出 `busy`。这是 CPU 保护，不是猜测公平性。
5. **内存**：跟踪键上限 10 000，按 LRU 淘汰，防止来源轮换把内存撑爆。状态只在进程内，重启即清。

## 入口与节点

经 `/n/<nodeId>/api/share-access/:id/login` 转发时，目标节点看到的来源是 `peer:<入口>`，真实浏览器 IP 只在入口侧计数。入口 `Forwarder.gateShareLogin` 在转发前用同一套 `lockedFor` 规则预检：干净 IP 的正确口令不会因为其它 IP 的失败被入口 429。

入口只在上游返回 401 时记一次失败，2xx 记该 IP 成功（24 h）。节点对 `peer:*` 来源不做按来源退避与并发限制（否则经同一入口的所有访客共用一个桶，几次猜错就会牵连全部），只把失败计入分享级窗口，并保留进程级 argon2 并发上限；按来源退避完全由入口按真实 IP 执行，因此节点对转发来的错误口令始终返回 401，入口据此记账。

## 返回码

| 条件 | HTTP | code |
| --- | --- | --- |
| 口令错且当前无等待 | 401 | `SHARE_PASSWORD_INVALID` |
| 退避或分享降速未到期 | 429 | `SHARE_LOGIN_LOCKED` + `retryAfterMs` |
| 并发或进程校验上限 | 429 | `SHARE_LOGIN_BUSY` + `retryAfterMs` |
