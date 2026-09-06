# 中继三进程实测主管（relay-boot）

`apps/fe/tests/helpers/relay-boot.ts`（配套 `relay-boot-auth.ts` 鉴权助手、`relay-boot-state.ts`
state 组装）是中继拓扑的进程主管，与 hub 拓扑的 `mesh-boot.ts` 同形：
从源码拉起若干 VibeTerm runtime，走真实 CLI 与真实 HTTP 接口把它们并成一套 mesh，
把连接信息写进 state JSON，收到 `SIGTERM` / `SIGINT` 时回收全部子进程、tmux socket 与临时目录。

## 拓扑

| 实例 | 角色 | 说明 |
|---|---|---|
| R | `relay,node` | 公共中继 + 本机 node。`VIBETERM_RELAY_PUBLIC_URL=http://127.0.0.1:<portR>`，管理令牌由 `VIBETERM_RELAY_ADMIN_TOKEN` 写死在 `app.env` 里 |
| A | `node`（`VIBETERM_HUB_URL` 为空） | 用 `vibeterm relay enroll` 在 R 上开租户，成为该租户的主节点 |
| B | `standalone` → `node` | 用 A 生成的 `r3.` 加入码经 `vibeterm hub join --token` 并入同一租户 |

三台都绑 `127.0.0.1`，端口从 19851（gateway）与 39851（peer）起顺次探空，
tmux socket 固定为 `vibeterm-relay-e2e-r` / `-a` / `-b`，`NODE_ENV=test`，
`VIBETERM_MASTER_KEY` 取自 `env/test.env`，`VIBETERM_MIGRATIONS_DIR` 指向 `apps/gateway/drizzle`，
`VIBETERM_FE_DIST_DIR` 指向 `apps/fe/dist`（缺 `index.html` 时按 mesh-boot 的做法先构建）。

## 用法

```bash
# 中继拓扑（常驻，SIGTERM 回收）
bun apps/fe/tests/helpers/relay-boot.ts --state /tmp/vibeterm-relay-e2e.json

# hub 拓扑怎么起（只打印，不在本文件里重复实现）
bun apps/fe/tests/helpers/relay-boot.ts --mode hub
```

`--mode hub` 只是把 `mesh-boot.ts` 的用法打出来：hub 拓扑（`hub,node` + `node`）仍然用
`bun apps/fe/tests/helpers/mesh-boot.ts --state <path>`，relay-boot 不复制那套流程。

环境变量 `VIBETERM_RELAY_E2E_BUILD_FE=1` 可强制重建 `apps/fe/dist`。

## 启动序列

1. `vibeterm hub user add relayop --install-dir <R>` / `vibeterm hub user add alice --install-dir <A>`
   （`VIBETERM_PASSWORD` 走环境变量，非 TTY 时 CLI 只认它）。
2. 起 R → 等 `/healthz` 与 `GET /api/relay/health`。
3. `POST /api/relay/password`（`Authorization: Bearer <adminToken>`，body `{password, mode:'keep'}`）
   给中继设接入口令。CLI 的 `vibeterm relay passwd` 要隐藏输入两遍，非交互场景直接打管理接口更省事。
4. 起 A → 等 `/healthz`。
5. `vibeterm relay enroll http://127.0.0.1:<portR> --password <中继口令> --install-dir <A>`，
   `VIBETERM_PASSWORD` 给本机 mesh 密码。命令内部完成 proof → `POST /api/mesh/relay/enroll` →
   签 `set-relays` → 轮询直到 `mode==='relay'` 且在线。
6. 主管以密码登录 A（Argon2 seed → Ed25519 root → delegation → challenge/login），
   轮询 `GET /api/mesh/relay/status` 直到 `mode==='relay'` 且该中继 `online && attached`。
7. 生成 `r3.` 加入码（见下节），在 B 上跑
   `vibeterm hub join --token r3.<…> --name relay-node-b --no-restart --install-dir <B>`。
8. 轮询 `GET /api/mesh/relay/enrollments/:id` 到 `redeemed`，在 A 上签 `admit-node`，
   再 `POST /api/mesh/relay/meta-key/prepare {op:'admit',node_id}` 签一条换代 `meta-key`。
9. 起 B → 等 `/healthz` → 轮询 A 的 `/api/mesh/nodes` 直到 B `online`。
10. 在 A 上登录 B 的 node-session（`POST /n/<B>/api/auth/challenge` + `/login`），
    打一次 `GET /n/<B>/api/system/info` 确认转发通，再读一次节点表记录 `transport`。
11. 写 state JSON，然后常驻。

## 坑

- **`vibeterm enroll` 不支持中继**：它只走 hub 的 enrollment 路径。`r3.` 加入码目前只有网页
  「加节点向导」会生成（`apps/fe/src/node/relay-join.ts`），所以 `relay-boot-auth.ts` 按同一套
  shared 助手复刻了它：`GET /api/mesh/relay/join-material` → `createEnrollment(rootKey, …)` →
  `POST /api/mesh/relay/enrollments` → `encodeRelayJoinToken`。`admit-node` + `meta-key` 同理。
  改动这几个接口时记得同步这个文件。
- **A 不能是 `standalone`**：standalone 只挂 `authSurfaceOnly` 的鉴权面
  （`packages/app/src/runtime/assemble.ts`），没有 `/api/mesh/relay/*`，`relay enroll` 会 404。
  租户主节点必须是 `node`（`VIBETERM_HUB_URL` / `VIBETERM_HUB_PUBLIC_URL` 留空，正是 `relay join` 之后的状态）。
- **`transport` 不打流就是 `null`**：`/api/mesh/nodes` 的 `transport` 取自 peer manager 当前链路，
  刚上线时还没建流。主管先打一次 `/n/<B>` 代理逼出链路再读，实测稳定拿到 `relay`
  （回环环境下 WebRTC 直连拨不通：`endpoint backoff … 192.168.31.36 / 198.18.0.1`，不会升级成 `dc`）。
- **`Cookie` 头要带两个**：`/n/<B>` 的请求同时需要 A 的 `vibeterm_s_self` 与 B 的
  `vibeterm_s_<Bid>`（`apps/gateway/src/auth/cookies.ts`）。state 里 `a.cookie` 已经把两个都拼好，
  `b.viaA.cookie` 是同一串，可以直接 `curl -H "Cookie: …"`。
- **临时实例的 tmux session 名来自 `devices.session` 的默认值**（2.0 起为 `vibeterm`，改名前建的行仍是 `tmex`），但它在专用 socket（`tmux -L vibeterm-relay-e2e-r`）里，
  与生产那台默认 socket 上的 `tmex` session 无关。任何 `kill-server` 都必须带 `-L`。
- **`bunfig` 预加载会给测试进程设 `NODE_ENV=test`**，但 `Bun.spawn` 出去的 runtime / CLI 不继承这层，
  主管显式在 `env` 里写 `NODE_ENV=test`。
- **别让 setup 流程写出 `test.env.local`**：`loadEnv()` 对它是 override，会串到其它实例上
  （见 `docs/relay/2026090501-relay-mgmt-switch-usage.md`）。本主管全程走 `app.env`，不碰它；
  若因别的实验产生了这个文件，测完必须删掉。
- 关停时 runtime 优雅退出需要几秒，`SIGTERM` 之后不要立刻断言进程已消失。

## state JSON

```jsonc
{
  "mode": "relay",
  "supervisorPid": 69126,
  "tmpDir": "/tmp/vibeterm-relay-e2e-<pid>-<ts>",
  "username": "alice",
  "password": "<A/B 共用的 mesh 密码>",
  "uid": "<用户编号>",
  "tenantId": "<中继上的租户编号>",
  "relay": {
    "role": "relay,node", "name": "relay", "port": 19851, "peerPort": 39851,
    "baseUrl": "http://127.0.0.1:19851", "publicUrl": "http://127.0.0.1:19851",
    "adminToken": "<b64url 32B>", "adminAuthHeader": "Bearer <adminToken>",
    "username": "relayop", "password": "<R 本机 mesh 密码>", "relayPassword": "<中继接入口令>",
    "nodeId": "<R 的节点编号>", "tmuxSocket": "vibeterm-relay-e2e-r",
    "installDir": "…/relay", "cookie": "vibeterm_s_self=…"
  },
  "a": {
    "role": "node", "name": "vibeterm", "port": 19852, "peerPort": 39852,
    "baseUrl": "http://127.0.0.1:19852", "nodeId": "<A 的节点编号>",
    "tmuxSocket": "vibeterm-relay-e2e-a", "installDir": "…/a",
    "cookie": "vibeterm_s_self=…; vibeterm_s_<Bid>=…"
  },
  "b": {
    "role": "node", "name": "relay-node-b", "port": 19853, "peerPort": 39853,
    "baseUrl": "http://127.0.0.1:19853", "nodeId": "<B 的节点编号>",
    "transport": "relay", "tmuxSocket": "vibeterm-relay-e2e-b", "installDir": "…/b",
    "cookie": "vibeterm_s_self=…",
    "viaA": { "url": "http://127.0.0.1:19852/n/<Bid>", "cookie": "vibeterm_s_self=…; vibeterm_s_<Bid>=…" }
  },
  "tmuxSockets": { "relay": "vibeterm-relay-e2e-r", "a": "vibeterm-relay-e2e-a", "b": "vibeterm-relay-e2e-b" }
}
```

## 验收命令

```bash
S=/tmp/vibeterm-relay-e2e.json
A=$(jq -r .a.cookie $S); AB=$(jq -r .a.baseUrl $S); BID=$(jq -r .b.nodeId $S)

curl -s -H "Cookie: $A" $AB/api/mesh/relay/status      # mode=relay，relays[0] online+attached
curl -s -H "Cookie: $A" $AB/api/mesh/nodes             # B online，transport=relay
curl -s -H "Cookie: $A" $AB/n/$BID/api/system/info     # 200，经中继转发到 B
curl -s -H "Authorization: $(jq -r .relay.adminAuthHeader $S)" \
     $(jq -r .relay.baseUrl $S)/api/relay/status       # 租户表：nodes=2 / nodesOnline=2
```
