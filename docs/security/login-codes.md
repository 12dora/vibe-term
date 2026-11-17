# 一次性登录命令

在网页端生成 `vibeterm login --code …`，交给 agent 在终端执行，即可得到与 `vibeterm login` 相同的 mesh 会话，不必在终端输入密码与验证码。面向维护登录与会话代码的开发者。

## 目标与边界

- 兑换结果与 `vibeterm login` 完全相同：每台节点一条 PoP 会话（18 小时滑动续期、硬上限 7 天），会话私钥由 CLI 在本机生成、从不上网。
- 生成时的身份校验不低于登录：每台目标节点独立跑完整的登录校验链（限流、challenge 绑定、委托签名、登录签名、第二因素），任何节点都不接受其他节点「此用户已验证」的断言。
- 命令码只在生成它的浏览器内存与命令文本里存在；节点只存各自派生码的哈希；命令 10 分钟内有效，每台节点只能兑换一次。

## 命令码

```
命令码  = "vtl1_" + base64url(secret[16] ‖ nodeId[16] × n)        n ≤ 64
节点码  = HMAC-SHA256(secret, "vibeterm/login-code/v1\0" ‖ nodeIdHex)
节点保存 sha256(节点码)
```

- `secret` 由浏览器随机生成，不发给任何服务端。
- 兑换时 CLI 只把某台节点自己的节点码发给它：拿到一台节点的码推不出其他节点的码，入口转发时同理。
- 实现：`packages/shared/src/auth/login-code.ts`；接口契约：`packages/shared/src/contracts/login-code.ts`。

## 流程

| 步骤 | 调用方 | 接口（均为登录前公开面，经 `/n/<id>/` 转发时不带凭据） |
| --- | --- | --- |
| 1. 取 challenge | 浏览器 | `POST /api/auth/challenge {uid, purpose:'login-code'}`，challenge 类型 `login-code`，与登录 challenge 互不通用 |
| 2. 登记 | 浏览器 | `POST /api/auth/login-code`：与 `/api/auth/login` 同一信封 + `code_hash`；校验通过后登记待兑换记录，不发会话 |
| 3. 兑换 | CLI | `POST /api/auth/login-code/redeem {code, sess_pk, pop}`：原子消费后按登录同一路径签发会话，`via` 为 CLI 所用入口 |
| 4. 查询 / 作废 | 浏览器 | `POST /api/auth/login-code/status`、`/revoke {code}`：持码人查询或作废自己的码 |

## 生成时的身份确认

登记在登录校验链之外再要求「新鲜」，满足其一：

- 本次请求校验通过的 TOTP 验证码在该节点从未被使用过（任何会话公钥、重放窗口内）；否则 `TOTP_ALREADY_USED`。
- 委托在 5 分钟内签发（现场输入密码或通行密钥）；否则 `STEP_UP_REQUIRED`。

浏览器按可用性提供：

| 方式 | 材料 | 条件 |
| --- | --- | --- |
| 验证码 | 当前会话的根委托与会话私钥 + 内存中的 `k_totp` + 新验证码 | 账户启用 TOTP，且本页是密码登录 |
| 通行密钥 | 临时会话密钥 + 现场签的通行密钥委托 | 本 origin 有可用通行密钥 |
| 密码 | 临时会话密钥 + 现场派生的根委托（启用 TOTP 时附验证码） | 以上两者都不可用时的回退 |

临时密钥、种子与 `k_totp` 副本用完即清零，不写入会话存储。

## 吊销与上限

- 待兑换记录只在内存（节点重启即失效），每用户每节点最多 32 条、全节点 1024 条（`LOGIN_CODE_LIMIT`）。
- 改密 / 轮换根钥（`revokeAllSessions`）、移除登记入口节点（`revoke-node`）、移除对应通行密钥、在该节点登出，都会清掉相关待兑换记录。
- 兑换得到的会话与普通登录会话同等对待，沿用现有吊销规则。
- 登录历史：兑换成功记为一次登录，二次验证列显示「登录命令」（`second = 'code'`）；兑换失败按失败行记录（节流）。

## CLI

```
vibeterm login --code <命令码|->
```

- 与 `--password-stdin`、`--totp`、`--user`、`--all-nodes`、`--node` 互斥；`-` 表示从 stdin 读。
- 入口自己在命令码里时先兑换入口，其余节点按 `--concurrency` 并发；输出、`--json` 形状与退出码与 `vibeterm login` 一致（`LOGIN_CODE_*` 拒绝为 3）。
- 远程 agent 仍需能连到某个 mesh 入口（`--entry` / `VIBETERM_ENTRY`）。

## 兼容

节点与 CLI 需 ≥ 2.17.0（`MIN_LOGIN_CODE_VERSION`）；网页端跳过离线、已暂停与版本过低的节点并在结果里列出。
