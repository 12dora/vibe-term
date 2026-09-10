# 2.1.0

_2026-09-11_

## English

### New

- **Command-line client.** `vibeterm` can now do everything the web UI does, from any terminal or from an AI coding agent: `vibeterm login` signs in exactly like the browser (password plus your authenticator code), then `vibeterm term attach <node>/<device>` opens a terminal on any mesh node like ssh (`~.` to detach), `vibeterm term run … "make test"` runs a command and returns its output and exit status, `vibeterm cp` copies files between this machine and nodes or between two nodes, `vibeterm port map` forwards a remote port to a local one, and `nodes`, `devices`, `tmux`, `files`, `share`, `watch` and `settings` cover the rest; `vibeterm api` reaches any endpoint. Every command has `--json`, works without a TTY, and shares the browser's security model: sessions are ordinary user sessions stored only on your machine, reach other nodes through the same entry-node forwarding, and are revoked by `vibeterm logout`. See `docs/operations/cli-usage.md`.
- **Two-step verification: authenticator or passkey.** When both an authenticator app and passkeys are set up, a valid code now satisfies the second step on its own (and so does a passkey); previously both were required. This is what makes the command line usable. Wrong codes have their own, stricter rate limit, a code cannot be replayed by another session, and the login page no longer asks for a passkey after you typed a code.
- A `POST /api/files/mkdir` endpoint (used by `vibeterm cp -r`).
- Built-in STUN self-test: the gateway probes every configured STUN server at start and every 10 minutes and logs the result (`stun probe …`); `GET /api/mesh/rtc-config` returns the probe results. The connection details popover now says "no reflexive candidate" or "STUN not configured" instead of a generic timeout.

### Improvements

- **Direct node-to-node connections work again.** Every dial used to start two WebRTC attempts per peer; the second one silently discarded the answer meant for the first, every attempt timed out, the circuit breaker counted each timeout twice and switched direct connect off for good — which is why all links ended up on the relay. Dials are now single-flight per peer, a newer offer replaces a stale one, candidates are applied only after the remote description, the breaker charges once per attempt, and ws-secure upgrades no longer wait behind a pending WebRTC attempt. Note: this takes effect once both sides of a link run 2.1.0.
- Default STUN servers now start with two China-reachable servers (Xiaomi, Bilibili) followed by Google and Cloudflare; an empty STUN list published by a hub no longer wipes a node's own configuration; STUN hostnames are resolved outside fake-IP proxies (Surge/Clash); TURN from the hub is always adopted.
- **The terminal latency badge now measures the link, not the queue.** On relayed nodes the heartbeat reply used to sit behind up to 3 MiB of buffered terminal output, so a busy terminal showed 800 ms while the network was fine. Control frames now take a priority lane end to end, in-flight output per forwarded session is bounded (`VIBETERM_LINK_STREAM_INFLIGHT_BYTES`, default 256 KiB), and relay operators' total-bandwidth limits no longer delay small frames (bounded per-tenant bypass). The gateway log now breaks `[ws-metrics] ping` down per connection kind.
- The connection details popover stays inside the screen on phones.
- The sidebar no longer shows the entry-node latency badge; the terminal badge covers the whole path.

### Fixes

- A tmux session that disappears while the details popover is open no longer leaves stale timers behind; forwarded terminal sessions no longer lose control frames when they close.
- Reading the 404 body of a node running an older version is now unambiguous (`code: route_not_found`).

---

## 中文

### 新增

- **命令行客户端。** `vibeterm` 现在能做网页界面能做的一切，无论是在终端里还是由 AI 编码助手驱动：`vibeterm login` 以与浏览器完全相同的方式登录（密码 + 验证器验证码），然后 `vibeterm term attach <节点>/<设备>` 像 ssh 一样打开任意节点的终端（`~.` 断开），`vibeterm term run … "make test"` 执行命令并带回输出与退出码，`vibeterm cp` 在本机与节点、节点与节点之间复制文件，`vibeterm port map` 把远端端口映射到本地，`nodes`、`devices`、`tmux`、`files`、`share`、`watch`、`settings` 覆盖其余功能，`vibeterm api` 可以访问任意接口。每条命令都支持 `--json`、无需 TTY，安全模型与浏览器一致：会话就是普通的用户会话，只存在你的机器上，访问其他节点走同一条入口转发，`vibeterm logout` 即撤销。见 `docs/operations/cli-usage.md`。
- **两步验证：验证器或通行密钥。** 同时设置了验证器应用与通行密钥时，输入有效验证码即可通过第二步（通行密钥同样可以）；此前两者都要。这正是命令行可用的前提。错误验证码有单独的、更严格的限流，一个验证码不能被另一个会话重放，登录页在你输入验证码后也不再要求通行密钥。
- 新增 `POST /api/files/mkdir` 接口（`vibeterm cp -r` 使用）。
- 内置 STUN 自检：网关在启动时和每 10 分钟探测每个配置的 STUN 服务器并记录结果（`stun probe …`）；`GET /api/mesh/rtc-config` 返回探测结果。连接详情浮层会明确写出「未取得反射候选」或「未配置 STUN」，而不是笼统的超时。

### 改进

- **节点之间的直连重新可用。** 此前每次拨号都会对同一节点发起两个 WebRTC 尝试，第二个把发给第一个的应答悄悄丢掉，于是每次都超时，熔断器还把每次超时记两次，最后干脆把直连关掉——这就是所有链路都落到中继上的原因。现在每个节点同一时刻只有一次拨号，新的 offer 会取代旧的，候选只在远端描述就位后才加入，熔断器每次尝试只计一次，ws-secure 升级也不再排在未完成的 WebRTC 后面。注意：链路两端都升到 2.1.0 后才生效。
- 默认 STUN 服务器改为国内可达的小米、B 站打头，Google、Cloudflare 作为冗余；hub 下发空的 STUN 列表不再抹掉节点自己的配置；STUN 域名会绕开 fake-IP 代理（Surge / Clash）解析；hub 下发的 TURN 始终采用。
- **终端延迟徽标现在量的是链路，不是队列。** 经中继的节点上，心跳应答此前会排在最多 3 MiB 的终端输出后面，终端一忙就显示 800 ms，而网络其实没问题。现在控制帧全程走优先通道，每条转发会话的在途输出有上限（`VIBETERM_LINK_STREAM_INFLIGHT_BYTES`，默认 256 KiB），中继运营者的总带宽限额也不再拖慢小帧（按租户的有界旁路）。网关日志里的 `[ws-metrics] ping` 现在按连接种类分行。
- 手机上连接详情浮层不再超出屏幕。
- 侧栏不再显示入口节点延迟徽标；终端页的徽标覆盖整条链路。

### 修复

- 浮层打开期间 tmux 会话消失不再残留定时器；转发终端会话关闭时不再丢控制帧。
- 老版本节点的 404 响应现在带 `code: route_not_found`，客户端可以准确识别。
