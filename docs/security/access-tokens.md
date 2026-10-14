# 访问令牌（机器令牌）

给 agent、CI、定时任务这类无人值守的调用方一种不必登录的凭据：按节点签发、按 scope 授权、可吊销、可审计。本文描述令牌模型、出示方式、scope 边界、管理方式与 CLI 流程，面向运维与改动 `apps/gateway/src/auth/access-token*.ts`、`token-scope.ts`、`apps/gateway/src/mesh/token-guard.ts` 的开发者。命令用法见 [CLI 使用手册](../operations/cli-usage.md)，exec 通道的鉴权细节见 [远程执行](../architecture/remote-exec.md)。

## 1. 模型

| 项 | 规则 |
| --- | --- |
| 归属 | **每个节点各自签发、各自校验**：令牌存在签发它的节点的库里，只对该节点有效；mesh 其它节点不认。归属到创建它的用户（`uid`） |
| 字段 | `name`（1..64 字符）、`scopes`（`exec` / `files` / `forward`，非空、不重复）、有效期（1..3650 天或永不过期）、创建时间、最近使用时间与来源 IP |
| secret | `vtk_` + base64url(32 字节随机数)，43 个字符。**只在创建响应里返回一次**，服务端只存 `sha256` 十六进制，比对用定时安全比较 |
| 数量 | 每个用户最多 50 个有效令牌，超出 409 `token_limit` |
| 吊销 | 保留行并写入 `revoked_at`，不参与列表与校验；吊销即时终止该令牌名下的 exec 会话 |
| 审计 | `access_token_events` 记录 `created` / `revoked` / `used`（附来源 IP）；`used` 对每个「令牌 + IP」每 10 分钟至多记一条；`last_used_at` 至多每分钟写一次 |
| 保留 | 事件与早已吊销 / 过期超过 180 天的令牌行由后台清理（启动、创建时及每 6 小时） |

校验失败的原因（未知、过期、已吊销、格式错误）只进 debug 日志，不含 secret；对外统一表现为未认证（401），作用域不足为 403 `TOKEN_SCOPE`。

## 2. 出示方式

| 场景 | 出示 |
| --- | --- |
| 直连本机网关 | `Authorization: Bearer vtk_…`，或 cookie `vibeterm_t_self=<secret>`（Bearer 优先） |
| 经入口访问节点 `<nodeId>` | CLI 发 cookie `vibeterm_t_<nodeId>=<secret>`；入口转发器把它改写成目标节点凭证 `tok:<secret>`，随 mesh 流的认证字段（HTTP / WS）或 `exec` 流的 OPEN 载荷 `credential` 到达目标节点，由目标节点校验 |

**会话优先**：请求带有效会话时令牌根本不看；只有没有有效会话才认令牌。入口转发时同理：目标节点有会话 cookie 就用会话，令牌不会遮蔽会话，也不会补充会话。CLI 对同一节点同时有有效会话和令牌时只发会话。

入口节点会看到转发途中的 `tok:<secret>`，信任面与它本来就能转发的会话 sid 相同；链路本身是 mesh 的加密认证链路。

## 3. scope

令牌调用方的作用域表由唯一执行点 `tokenScopeDenied` 判定，本机请求（含 `/n/self/...` 改写后）与 mesh 入站流都过这里；表外一律 403 `TOKEN_SCOPE`。

| scope / 范围 | 允许的请求 |
| --- | --- |
| 始终允许（只读基础面） | `GET /api/auth/mode`、`GET /api/devices`、`GET /api/mesh/nodes`，以及登录前的公开路径 |
| `exec` | `POST /api/exec`、`GET /api/exec/ws`（exec 通道升级也要求令牌含 `exec`） |
| `files` | `/api/files/*`（浏览、上传下载、`mkdir`、打包、移动、删除等）。`/api/files/roots` 的写操作会改动文件浏览根，属于节点配置，令牌只能 `GET` |
| `forward` | `/api/portmap` 与 `/api/portmap/*`（映射与放行的增删查） |

不在表内的能力令牌一概没有：tmux / 终端 WebSocket（`/ws`）、设置、Agent、分享、节点管理、node ↔ node 传输（`/api/transfer/*`）、登录与账号安全接口，以及令牌管理本身。

## 4. 管理

管理接口 `GET /api/auth/tokens`、`POST /api/auth/tokens`、`DELETE /api/auth/tokens/:id` **只认真实节点会话**：令牌调用方得到 403 `TOKEN_SCOPE`（令牌不能签发或吊销令牌，也不能借此扩大自己的 scope）；没有会话也没有用户的开放实例得到 401。列表只返回调用者自己的、未吊销的令牌，新的在前。

入口：

- 网页端「账号安全 → 访问令牌」：创建（名称、scope、有效期）、列表、撤销；secret 仅在创建后的对话框里显示一次。
- CLI `vibeterm token create|ls|rm|add`（需要登录会话；见下节）。

撤销与失效：撤销令牌立即终止它名下所有存活的 exec 会话、尚未发 HELLO 的通道连接与旧版 `POST /api/exec` 运行；过期或令牌行被删除（如退出 mesh 清库）由网关每 30 秒复核，同样终止。exec 连接在 HELLO（open / resume）时再复核一次令牌与节点会话，等待期间被撤销的凭证不能再开会话；resume 只认创建时的同一枚令牌（会话认证的则改挂当前会话）。轮换 / 重置根密钥触发的「撤销全部会话」会一并撤销该用户所有访问令牌。其余已发出的 HTTP 请求不受影响，下一次请求即被拒绝。

## 5. CLI 流程

```bash
vibeterm login && vibeterm token create office --name agent --scope exec,files --expires 90d
vibeterm exec office uptime                  # 之后不再需要会话
vibeterm token ls office
vibeterm token rm office agent               # 吊销，并终止其 exec 会话
```

- `token create` 默认把令牌存在本机 `<配置目录>/tokens.json`（目录 0700、文件 0600，group / world 可读会拒绝加载；`$VIBETERM_TOKENS_FILE` 改路径），文件里是明文 secret，须按密钥保护。
- 默认 scope 为 `exec`，有效期 90 天；`--print` 在保存后打印 secret，`--no-save` 只打印不保存。
- CI：在已登录的机器上 `token create <node> --name ci --scope exec --no-save --expires 30d`，把输出的 secret 放进 CI 的密文变量；流水线里用 `echo "$VT_TOKEN" | vibeterm token add --id <32位节点id> <别名> -` 保存（流水线没有会话，无法按名字解析节点，所以给节点 id，位置参数只作别名），之后 `vibeterm exec <别名> …` / `rsh` / `cp` 免登录可用。`add` 会先向节点验证 secret 再落盘；`VIBETERM_TOKENS_FILE` 建议指到任务的临时目录。
- `token add` 导入的令牌没有服务端 id，`token ls` 的 SAVED 为 `no`；吊销要在有会话的机器上 `token rm`，本机副本用 `token rm --local` 清。

## 6. 风险与边界

- 令牌的能力就是 scope 的能力：`exec` 令牌等同于该账号在节点上的 shell，`files` 令牌能读写该账号可见的文件根，`forward` 令牌能创建 / 删除端口映射与放行。按需要的最小 scope 签发，有效期尽量短，一个用途一个令牌。
- 泄露处置：立即在网页端或 `vibeterm token rm` 撤销；secret 不可恢复，也无法事后查看。
- 令牌不跨节点：访问另一台节点需要在那台节点上另签一个。
- 与 [KI-16](../known-issues.md)：exec 已有按 scope 收窄的令牌；仍没有按设备 / 具体命令收窄与单次使用的令牌。
