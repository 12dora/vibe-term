# tmex hub / node 多节点架构设计

状态：详细设计 v3.2（v3.1 + 二次审查 `design-review-02.md` 修正：admit 绑定本地 pending、临时钥只能登录、TOTP 判定从 delegation 导出、opaque sid + 7 天绝对上限、本机 `reset-root` 恢复、transcript 规范排序、指纹/WebAuthn/Borsh 细节）。v1 与需求方确认 §1–§5；v2 改为 mesh（任意 node 都是入口、自动发现、hub 不可达时内网直连）；v3 按"**任意点失陷（含 hub）只影响该点**"重做鉴权：hub 不再是信任根，用户身份为用户自持密钥（密码派生 Ed25519 + passkey），移除 OIDC；v3.1 吸收 codex 对 v3 的审查（用户签发的节点证书链、浏览器临时钥、DTLS 指纹绑定、SecureChannel 会话密钥、根轮换 epoch、响应头 sandbox、18 小时滑动会话）。审查记录：`design-review-00.md`、`security-review-01.md`、`design-review-01.md`（均位于 `prompt-archives/2026082701-hub-multinode-design/`）。

## 背景

现有 tmex 的"多设备"是 gateway 通过 SSH 主动连接远程主机（`DeviceType = local | ssh`），要求 gateway 能直达目标地址。用户当前以 Cloudflare Tunnel 暴露单机，一个域名只能对应一台机器，内网多台设备无法在单一入口管理。同时 gateway 没有任何应用层鉴权（依赖网络边界）。

现状代码事实（详见 `prompt-archives/2026082701-hub-multinode-design/explore-multidevice-result.md`）：

- 浏览器 ↔ gateway 只有一条 Borsh 二进制 WebSocket，按 `deviceId` 多路复用；REST 与 WS 都在 gateway 本地解析设备并调用 runtime。浏览器终端走 `TERM_OUTPUT / TERM_HISTORY / SWITCH_ACK / LIVE_RESUME` 等旧终端消息；canonical 协议（`CANONICAL_COMMAND/EVENT`）仅服务端实现，前端未采用。
- Borsh envelope 的 `seq` 是每个 socket 独立的计数器，接收端不校验连续性，不能用于跨传输去重。
- 无用户/会话/权限表；WS upgrade 只校验路径；`HELLO` 不含凭证。
- `GatewayRuntime` 暴露 `handleRequest(req, bunServer)` 与 WS 回调（`apps/gateway/src/runtime.ts:35`），构造时无条件读取站点设置、探测 tmux、启动 push/agent/watch/messaging；`/api/*` 全部被 gateway dispatch 消费（含未知路径）；`/ws` 是 gateway 协议端点。
- WS handler 对 socket 的依赖：`send()` 返回值、`getBufferedAmount()`、drain 回调、`close/terminate`、`ws.data.borshState`，且以 socket 对象身份作为多处 Map 的键（`ws/index.ts:82`、`ws/types.ts:19`、`websocket-send-guard.ts`）。
- 前端：只有 tmux 状态按 `deviceId` 分区；agent 订阅按 sessionId、文件树按 `rootId+path`。但 `createGatewayConnection` + 可注入 `ApiClient` + `createAppRuntime` + `RuntimeProvider` 已构成"每个 gateway 一套运行时"的隔离边界（`packages/stores/src/app-runtime.ts:23`、`react.tsx:17`）。文件媒体/下载 URL 由 `packages/api-client/src/file-urls.ts` 拼出未加前缀的 `/api/files/*`，部分设置页直接调用全局 `fetch('/api/...')`。
- 文件上传是 `init → 顺序 HTTP PUT 分块（8 MiB）→ commit（NDJSON）`，下载是 `prepare（NDJSON）→ HTTP 流`，依赖 `Request.signal` / 响应流取消来终止 rsync 与清理临时文件（`apps/gateway/src/api/files.ts`）。
- 打包产物是单文件 `runtime/server.js`，安装目录无 `node_modules`；tmex-cli 1.0.2 tarball 20.7 MB；安装布局（`packages/app/src/lib/install-layout.ts`）无 native 目录。

## 目标

1. 单一公网入口（hub）管理多台 NAT 后的设备；设备侧只需出站连接。
2. **任意一台已加入的机器都是完整入口**：打开任意 node 的本地 UI 即可看到并操作其余所有机器；加入 hub 后自动发现，无需手动逐台添加。
3. **任意一点失陷（普通 node、hub 机）只影响该点**：攻击者拿不到任何可用于操作其他机器的凭证，也读不到经过该点中转的内容。唯一例外是用户**正在使用**的 entry：它提供页面代码并代理流量，在会话窗口内能以用户身份行事（见 §5 安全边界），这是 web 架构固有的信任点。
4. 服务单一用户，为多用户预留（资源表带 `user_id`），不做权限目录、不做用户管理 API/UI。
5. hub 在境外、用户与设备在境内的场景下，**尽量直连**以降低延迟；复杂 NAT 下多级穿透，最终兜底 hub 中转。
6. hub 可同时作为一台设备使用（同进程双角色）。
7. hub 不可达时，设备本地仍可登录使用，且同内网的 node 之间仍可互相操作。
8. tmex-cli 包体积基本不变；hub 与 node 同一个包、同一套升级流程。
9. 未加入 hub 的 standalone 安装行为不变。

## 已确认的取舍

| 议题 | 决策 |
|---|---|
| 拓扑 | **mesh**：hub 是注册表 / 信令 / 兜底中转；node 之间经 WebRTC 互相直连 |
| 入口 | 每个 node 的本地 UI 都是完整入口（含 hub 机自身） |
| 发现 | hub 广播节点清单（只含元数据）；节点公钥只来自用户签发的证书链；无 mDNS |
| hub 不可达 | 用缓存的对端地址在内网直连（v1 只用缓存地址，IP 变化后需 hub 恢复）；登录流程与在线时完全相同（不经 hub） |
| 信任根 | **用户自持密钥**：密码派生 Ed25519（根钥）+ passkey；所有机器只存公钥；node 成员资格由用户签发的证书证明；hub 不签发任何凭证 |
| 第二因素 | TOTP 保留，密钥用密码派生钥加密存放、登录时现场解密；只防远程猜密码/旁观，不防"失陷 node + 弱口令"离线爆破；独立第二因素用 passkey |
| 会话 | 浏览器临时钥 18 小时（只能登录）；`node-session` 18 小时滑动续期，绝对上限 7 天 |
| OIDC | 移除 |
| hub 兼设备 | hub 角色**总是**与 node 角色同进程（`hub,node`），不再有纯 hub 角色 |
| hub 部署 | `npx tmex-cli init --role hub,node`，systemd/launchd + SQLite |
| WebRTC 依赖 | `node-datachannel` 的 JS 层内联进 runtime，`.node` 二进制按平台在安装期按需下载到 `<installDir>/native/` |
| 文件传输 | 直连 `bulk` 流，失败回落中转（v1 失败即整体重传） |
| UI 壳 | 不引入 EasyUI，沿用 tmex 现有 UI 体系 |
| 直连承载范围 | 直连是同一逻辑 WS 会话的第二条载体（§3），不迁移会话 |
| node 离线展示 | 每个 node 缓存清单，离线时灰显其设备 |
| 直连支持平台（v1） | macOS arm64 / x64，Linux glibc x64 / arm64；musl、Windows 不在 v1 |

## §1 总体拓扑

**核心决策：每台机器仍运行完整的 tmex gateway，并且都是完整入口。hub 不接管业务、不参与登录，只做节点注册表、清单广播、WebRTC 信令与兜底中转（只搬密文）。**

术语：mesh 中的一台机器称 **node**（一个 gateway 实例）；node 内部仍是现有 `local` / `ssh` device。用户当前打开的那个 node 称 **entry**。UI 把所有 node 的 device 拍平显示（带 node 徽标），路由 `/n/:nodeId/devices/:deviceId`；`nodeId = self` 表示 entry 自身。

```
浏览器 ──HTTPS/WSS──▶ entry(node A)                      本地流量：进程内
                         │ peer link(A↔B, DTLS)           A 操作 B：REST / WS 中转
                         ▼
                      node B ◀──WebRTC DataChannel（sess + bulk:*）── 浏览器   终端/文件直连
                         │
                      uplink(WSS 出站)
                         ▼
                        hub   ◀── uplink ── A / C / D …    注册表、广播 node.list、信令、relay(密文)
```

数据路径：

1. **本地**：浏览器访问 entry 自己的 device，与 standalone 相同（加一层登录）。
2. **entry → 目标 node（控制面）**：`/n/:id/api/*` 与 `/n/:id/ws` 由 entry 经 **peer link** 转发到目标 node；peer link 是 node↔node 的多路复用通道（§3），承载 `http` / `ws` / `ctl` 流，与 uplink 同一编解码。
3. **浏览器 → 目标 node（数据面直连）**：浏览器与目标 node 之间建 WebRTC，`sess` 通道作为该 WS 会话的第二条载体，`bulk:*` 承载文件。信令经 entry 的 `/mesh/ws` 转发（entry 再经 peer link 或 hub 送达目标）。
4. **hub 兜底**：peer link 建不起来时（跨 NAT 且穿透失败、对端无 native addon），entry 经 uplink 请求 hub 打开 `relay` 流到目标 node；relay 上跑的是 node↔node 端到端加密的 `SecureChannel`（§3），hub 只能搬字节。
5. **hub 兼 node**：同进程组合，uplink 用内存 duplex 实现同一 `LinkSession` 接口；hub 机的 node 与其他 node 完全同等。

peer link 传输选择（自动，按序）：

1. **内网 / v6 / 公网直达**：目标 node 的 **peer 监听端口**（`TMEX_PEER_PORT`，默认 39001，绑定 `0.0.0.0` / `::`）只承载 **签名信令**（明文 WS）；数据面走 node↔node WebRTC DataChannel（DTLS 加密、ICE host 候选零跳）。hub 不可达时这是唯一路径，地址来自 `peer_cache`。
2. **hub 信令 + ICE**：peer 端口不可达时，信令经 hub `ctl` 流转发，ICE 走 STUN / v6 / TURN。
3. **hub relay**：ICE 失败或任一端 `direct_capable=false`，经 hub `relay` 流中转（`SecureChannel` 加密）。

网络路径诊断（设备页徽标）对浏览器↔目标 node 与 entry↔目标 node 各显示一个：`lan / v6 / v4-p2p / turn / relay`。

### NAT 穿透策略（ICE 并行尝试，自动选优）

同内网 host 候选 → IPv6 → IPv4 STUN 打洞 → 境内 TURN → hub relay。UPnP/NAT-PMP 端口映射不进 v1。网络变化（`online`/`change` 事件或连续心跳失败）重跑 ICE，期间回到中转。

## §2 身份、鉴权与 node 注册

### 信任模型（一句话）

**用户身份 = 用户自持的密钥对；每台机器只存公钥；node 的身份由用户签发的证书证明；node 私钥只是链路身份；hub 什么凭证都签不出来。** 因此任何一台机器上的数据都不足以冒充用户操作另一台机器，hub 也不能决定"谁是 mesh 的成员"。

### 规范编码（所有签名对象共用）

- 签名对象一律用 **Borsh** 固定 schema 编码（复用 `packages/shared/src/ws-borsh` 的编解码器），字段顺序固定、字符串带长度前缀，不存在拼接歧义。每个对象第一个字段为 `domain: string`（如 `tmex/login/v1`），防跨用途重放。
- 密码：UTF-8，NFKC 归一化后再送 KDF。
- KDF：`hash-wasm` argon2id，`memorySize=65536`（KiB）、`iterations=3`、`parallelism=1`、`hashLength=32`、Argon2 v0x13，salt 随机 16 字节。输出即 `seed`。
- 密钥：Ed25519 私钥 = `seed`（32 字节）；X25519 密钥用 `@noble/curves` 独立生成；公钥一律 raw 32 字节；passkey 公钥存 COSE 原始字节。
- HKDF：HKDF-SHA-256，`salt` 与 `info` 在各处显式给出，输出 32 字节。
- 浏览器与 Bun 共用 `packages/shared/src/auth/` 实现，并以固定测试向量锁定（密码 → seed → 公钥 → 签名字节）。

### 用户密钥

- **根钥（password key）**：`sk_root = Ed25519(seed)`。私钥只在内存，不落盘，不发送。所有机器存 `users.root_public_key` 与 `root_epoch`。存公钥与存密码哈希一样可被离线爆破弱口令，argon2id 参数取高；与常规密码哈希方案等价，不更差。
- **passkey**：WebAuthn 凭证。RP ID 必须是域名（`localhost` 或 DNS 名），IP 地址 origin 不可用；每个 credential 绑定注册时的**精确 origin**（scheme+host+port）。注册仪式：entry 生成 registration options（challenge 随机 32 字节、`rpId` = 当前 host、`userHandle` = uid、要求 UV）→ `@simplewebauthn/browser` `startRegistration()` → entry 用 `@simplewebauthn/server` `verifyRegistrationResponse()`（`expectedOrigin` = 当前请求 origin，`expectedRPID` = host）→ 提取 `credentialId / publicKey(COSE) / counter / transports / backupEligible / backupState / deviceType` → 前端签 `add-passkey` 记录（payload = 上述提取结果 + `rp_id` + `origin`，由根钥签，或由**另一把已有 passkey** 对该条记录做专用 assertion）→ 广播。registration challenge 由 entry 落库、60 秒有效、原子消费。删除 passkey 同理签 `remove-passkey`。passkey 登录不需 TOTP。assertion 验证按 WebAuthn 完整流程（challenge、RP ID hash、origin、UP/UV、签名、credential 状态）；counter：记录值非零且新值不大于记录值时拒绝，记录值为零的 authenticator 不做 counter 判断。
- **浏览器临时钥（session key）**：登录时浏览器生成一把内存 Ed25519 `sk_sess`，由根钥或 passkey 签发**授权**：`delegation = {domain:'tmex/delegation/v1', uid, sess_pk, issued_at, exp = issued_at + 18h, method:'root'|'passkey', credential_id?}`；根钥直接签；passkey 路径：entry 先给出 authentication options（`challenge = sha256(borsh(delegation))`、`rpId`、`allowCredentials`、`userVerification:'required'`），浏览器 `startAuthentication({optionsJSON})`，得到的 assertion（`clientDataJSON / authenticatorData / signature`）整体作为 `delegation_sig`。之后对每台 node 的登录挑战都由 `sk_sess` 签，只需**一次**密码输入或一次 passkey 交互。**`sk_sess` 只能用于登录，不能签任何 `user_key_log` 记录**；持久变更（加/删 passkey、TOTP、admit/revoke node、改密）一律要求根钥或 passkey 对该条记录做一次专用 assertion（UI 在这些操作时再要一次密码或 passkey）。`sk_sess` 只在内存，页面关闭即失；cookie 中的 `node-session` 让刷新页面不必重新登录。
- **密钥变更日志 `user_key_log`**：记录 = Borsh 编码的 `{domain:'tmex/keylog/v1', uid, seq: u64, prev_hash: [u8;32], root_epoch: u32, type, payload, signer:'root'|'passkey', credential_id?}`，`sig` 覆盖整条编码字节；`hash = sha256(记录字节 ‖ sig)`；数据库保存**原始 Borsh 字节与 sig**（`record_bytes`、`sig`），JSON 仅作只读投影。type ∈ `add-passkey | remove-passkey | rotate-root | set-totp | clear-totp | admit-node | revoke-node`。验签规则：记录外层 `root_epoch` = 应用它时的当前 epoch；`signer = root` 用当前 `root_public_key` 验，`signer = passkey` 用 `user_keys` 中该 credential 的公钥验 assertion（challenge = sha256(记录字节)）；`rotate-root` 由当前（即将成为旧）根钥签，payload 含新 `root_public_key`、新 `kdf_params`，应用后 `root_epoch += 1` 并切换验签钥，之后到达的记录必须带新 epoch。node 只接受 `seq = 本地 head + 1 && prev_hash = 本地 head hash` 的记录；遇到同一 `seq/prev_hash` 的两个不同后继即**硬失败**并在 UI 报"密钥日志分叉"，不由 hub 选胜者。hub 存全量并在 `node.list` 里带 `key_log_head {seq, hash}`；node 落后时向 hub 或任一 peer 拉取。
- **根轮换 = 新安全 epoch**：`rotate-root` 应用后，各 node 撤销该 uid 全部 `node_sessions`，删除全部 `user_keys`（passkey 需重新注册），清空 TOTP（需重新设置）。密码改密流程在 UI 中明确提示"将注销所有设备上的 passkey 与 TOTP"。
- **不依赖旧根钥的恢复（密码在失陷 entry 上泄露、攻击者抢先 `rotate-root` 时）**：在每台机器**本地**执行 `tmex-cli mesh reset-root`（输入新密码 → 新根公钥、`root_epoch += 1`、清空 `user_keys` / TOTP / `node_sessions`、`user_key_log` 从一条本地生成的 `reset-root` 记录重新开始，并把本机证书重新自签 `admit-node`）；该命令只信任本机 root 权限（拥有机器 = 拥有该点，与威胁模型一致），不接受任何远程触发。恢复后各机器需重新 `enroll`/`join` 建立成员关系；hub 侧 `hub user reset` 清空注册表。这是灾难恢复路径，不是日常流程。
- **TOTP**：`k_totp = HKDF(seed, salt = "tmex-totp" ‖ root_epoch(u32 LE), info = uid)`；记录 `set-totp` 的 payload = `{alg:'A256GCM', nonce(12B 随机), ciphertext, tag(16B)}`，AAD = `borsh({uid, root_epoch, seq})`。密码登录时浏览器把 `k_totp` 与 6 位码随 `delegation` 一起送到**每台**目标 node，node 现场解密校验后丢弃 `k_totp`。**边界**：TOTP 防"密码被远程猜测 / 被旁观"这类不掌握任何 node 数据的攻击；对"已取得某台 node 数据 + 离线爆破出弱口令"的攻击者，同一 seed 同时给出根钥与 `k_totp`，TOTP 不构成独立第二因素——该场景的防线是口令强度与 argon2id 成本。需要独立第二因素时用 passkey。

### 表结构（hub 与 node 同库同迁移链，standalone 下空表无害）

```
users               id, username(unique), root_public_key, root_epoch, kdf_params_json, totp_record_seq(nullable),
                    key_log_head_seq, key_log_head_hash, created_at, updated_at
user_keys           id, user_id, credential_id(unique), public_key(COSE), rp_id, origin, counter, transports, name, log_seq, created_at
user_key_log        seq, user_id, prev_hash, hash, root_epoch, type, record_bytes, sig, payload_json(投影), created_at
node_sessions       sid(随机 32B), user_id, via_node_id, sess_public_key, delegation_method, credential_id(nullable),
                    issued_at, expires_at, hard_expires_at, renewed_at, revoked_at                              -- 本 node 签发的票
node_certs          node_id, user_id, admit_record_seq, certificate_bytes, cert_sig, authorization_bytes, authorization_sig,
                    revoked_log_seq(nullable)                                                                  -- 所有机器都存
nodes               id, user_id, name, status(enrolled|revoked), last_seen_at, version, direct_capable,
                    inventory_json, inventory_version, endpoints_json, created_at                          -- hub 侧注册表（不含密钥）
enrollment_tokens   id, user_id, enroll_public_key, authorization_json, authorization_sig, expires_at, used_at, node_id(nullable)  -- hub 侧
node_identity       (单行) node_id, hub_url, private_key(加密), x25519_private_key(加密), certificate_json, cert_sig
peer_cache          node_id, name, endpoints_json, inventory_json, direct_capable, last_seen_at, list_version
```

节点公钥**只**来自 `node_certs`（用户签发链），`nodes` / `peer_cache` / `node.list` 只承载名称、地址、状态等元数据。`nodes.name` 由用户在 Nodes 页设定。

### 令牌与信任矩阵

| 凭证 | 签发者 | 接受方 | 说明 |
|---|---|---|---|
| `delegation` | 根钥 / passkey | 任意 node（用 `users` / `user_keys` 验） | 授权一把浏览器临时钥，18 小时 |
| 登录签名 | 浏览器临时钥 | 目标 node（先验 `delegation` 再验签名） | 一次性，每台 node 一次 |
| `node-session` | node T | **仅 T，且仅在来自 `via` 所指 entry 的链路上** | 随机 32 字节 opaque `sid`，全部状态在 T 的 `node_sessions` 行（无签名，查库即验） |
| 节点证书 | enrollment 钥（由根钥授权） | 所有 node、hub | 证明"这台机器及其公钥是用户承认的成员" |
| node 链路身份 | node 私钥 | hub、其他 node | 只证明"我是 node X"，不能换取任何用户级访问 |

`node-session` 绑定 `via`：从别的地方拿着票来，T 不认；entry 被吊销，票随之失效。entry 访问自身时 `via = self`，只在本地 Bun socket 上接受。

有效期 **18 小时滑动**：签发时 `expires_at = now + 18h`；T 每次验票通过后若距 `renewed_at` 超过 5 分钟，则把 `expires_at` 重置为 `now + 18h`（写库节流），并在响应头 `x-tmex-session-renewed: <expires_at>` 通知 entry 刷新 cookie `Max-Age`（WS 会话在每次 Borsh 入站消息上按同一节流规则续期，cookie 由下一次 REST 响应刷新）。18 小时内未使用即过期，需重新登录。另设**绝对上限** `hard_expires_at = issued_at + 7 天`，续期不能越过它——否则失陷 entry 只要每 18 小时用一次被留存的 `sid` 就能永久保持访问；7 天后必须重新登录（需要浏览器持有的根钥 / passkey，entry 没有）。

### 登录（对每台目标 node 独立进行，hub 在线与否流程相同）

浏览器在 entry E 上，要访问目标 T（含 T = E）：

1. `POST /n/:T/api/auth/challenge {uid}` → T 生成 `challenge_id`、`nonce(32B)`，登记 `{challenge_id, nonce, uid, entry: 链路对端 node_id, exp: 60s}`，返回 `{challenge_id, nonce, nodePk: pk_T}`。浏览器校验 `pk_T` 与本地 `node_certs` 投影（来自 `/api/mesh/nodes`，entry 从自己的 `node_certs` 读）中 T 的公钥一致。
2. 浏览器构造 `login = {domain:'tmex/login/v1', challenge_id, nonce, target: T, target_pk: pk_T, uid, entry: E}`，`sig = Ed25519.sign(sk_sess, borsh(login))`；`POST /n/:T/api/auth/login {login, sig, delegation, delegation_sig, totp?:{code, k_totp}}`。
3. T 按顺序：按 `challenge_id` 取出登记并**原子消费**，登记已过期（60 s）即拒绝；核对 `login.entry` 与登记的链路对端一致、`target = self`、`target_pk = 自己的公钥`、`login.uid = delegation.uid`；验 `delegation`（`now < exp`；`method = root` 用当前 `root_public_key` 验签，`method = passkey` 用 `user_keys` 中该 credential 按 WebAuthn 完整流程验 assertion，`expectedOrigin` / `expectedRPID` 取该记录）；验 `sig`（`delegation.sess_pk`）；**是否校验 TOTP 由已验证的 `delegation.method` 决定**（`root` 且用户设了 TOTP → 解密校验；`passkey` → 不需要）→ 写入 `node_sessions{sid, via: E, sess_pk, delegation_method, credential_id}` → entry 以 `tmex_s_<T>` `Set-Cookie`（`Path=/; HttpOnly; SameSite=Lax; Max-Age=64800`；https 加 `Secure`）。
4. 签名把 `target_pk` 绑进消息：若任何人（含失陷 hub）把 T 的公钥掉包做中间人，用户签的内容对真 T 无效。

登录页体验：输入一次密码（或一次 passkey）→ 生成 `delegation` → 前端对 `/api/mesh/nodes` 中当前可达的每个 node 并行执行 1–3；`sk_sess` 留在内存供后续新出现的 node 登录；页面刷新后靠 cookie 继续，cookie 过期或新 node 出现且 `sk_sess` 已失时提示"登录此节点"。失败限速：每个 node 对同一 `uid` 或 ip 每分钟 10 次，超出 429。

登出：`POST /n/:T/api/auth/logout` 撤销 T 上该 uid 的全部 `node_sessions`；"全部登出"= 前端对所有 node fan-out。

### node 注册（enrollment）与节点证书

1. 在任意 entry 的 Nodes 页（或 `tmex-cli enroll`）：此操作要求根钥或 passkey（UI 当场要密码 / passkey）。浏览器生成一次性 **enrollment 密钥对** `(enroll_sk, enroll_pk)`，签 `authorization = {domain:'tmex/enroll/v1', uid, enroll_pk, exp: +10min, root_epoch}`（根钥签，或 passkey 专用 assertion），经 entry 的 `hub.call` 送到 hub 存 `enrollment_tokens`（单次）；页面把 `{enroll_pk, authorization}` 记为 **pending**（内存 + `sessionStorage`）。展示给用户的 join 串 = `base64url(enroll_sk(32) ‖ root_public_key(32) ‖ key_log_head_hash(32))`（共 128 字符）。**`enroll_sk` 不经过 hub。**
2. 设备执行 `tmex-cli hub join <https-url> --token <join 串> [--name]`：join 只接受系统信任链验证通过的 HTTPS。生成 Ed25519 与 X25519 密钥对，构造 `certificate = {domain:'tmex/nodecert/v1', uid, node_id(随机 16B), ed_pk, x25519_pk, enroll_pk, issued_at}`，`cert_sig = sign(enroll_sk, borsh(certificate))`；`POST /api/hub/enrollments/redeem {certificate, cert_sig, name, version}` → hub 核对 `enroll_pk` 与 `authorization` 一致、验 `cert_sig`、`authorization` 未过期未使用 → 回 `{user:{…}, user_key_log(全量), node_certs(全量)}`。node **以 join 串里的 `root_public_key` 为准**，从日志中找到 `key_log_head_hash` 对应的记录并验证整条链（历史 `rotate-root` 由上一根钥签，链从首条记录起顺序验证到头；首条记录的签名钥必须能通过链到达 join 串的根公钥），校验通过才落库；然后立即用自身链路身份连 uplink。
3. **admit**：hub 收到 redeem 后把 `{certificate, cert_sig}` 推给发起 enrollment 的 entry 页面；页面**只在** `certificate.enroll_pk` 等于本地 pending 的 `enroll_pk`、`cert_sig` 用该 `enroll_pk` 验证通过、且 `authorization` 未过期时，才签一条 `admit-node {authorization, authorization_sig, certificate, cert_sig}` 记录（根钥或 passkey 专用 assertion，同 enroll 时那次交互后的 5 分钟内免二次输入）写入 `user_key_log`，并清除 pending。不匹配的推送一律忽略并告警"收到未知节点证书"。页面已关时 Nodes 页显示"待确认"，需再次密码 / passkey。其他 node **只接受有 `admit-node` 记录且未被 `revoke-node` 的节点证书**，验证时用根钥验记录签名、用 `authorization.enroll_pk` 验 `cert_sig`；hub 塞进 `node.list` 的任何未经承认的节点一律忽略。
4. 证书链（全部内嵌在 `admit-node` 记录里，其他 node 可独立验证）：`root_public_key`（join 串 / 已钉住）→ `authorization`（根签 `enroll_pk`）→ `certificate`（`enroll_sk` 签节点公钥）→ `admit-node`（根钥 / passkey 签，覆盖前两者）。hub 全程只搬运，无法伪造任何一环；hub 失陷时能做的只是拒绝服务。
5. 重装换钥 = 重新 enroll + `revoke-node` 旧证书。

### 链路身份与握手

- uplink 认证：node 连 `wss://hub/hub/uplink`，hub 在 `ctl` 流发 32 字节 nonce，node 回 `{node_id, sig}`，hub 用 `node_certs` 中的 `ed_pk` 验签；`revoked` 直接断开。
- peer link 握手（双向，DataChannel 与 relay 共用）：
  1. 双方交换 `hello = {node_id, nonce(32B), eph_x25519_pk?, dtls_fingerprint?}`。DataChannel 路径：本端指纹在 `setLocalDescription()` 之后从 `localDescription().sdp` 的 `a=fingerprint` 行解析（`{algorithm, value}`，规范化为小写算法名 + 大写十六进制），对端指纹取 `remoteFingerprint()`（返回 `{value, algorithm}`）；relay 路径不带指纹但带 `eph_x25519_pk`。
  2. `transcript = borsh({domain:'tmex/peer/v1', path:'dc'|'relay', hello_lo, hello_hi})`，其中 `hello_lo / hello_hi` 按 `node_id` 字典序排列——两端得到**完全相同的字节**；各自对 transcript 签名，对方用 `node_certs` 中的 `ed_pk` 验签；DataChannel 路径再核对对方 hello 里的指纹与实际 `remoteFingerprint()` 一致——信令被失陷 hub 篡改成两条 DTLS 通道时指纹不匹配，握手失败。
  3. 密钥（仅 relay 路径）：`ss = X25519(eph_sk_self, eph_pk_peer)`，`k = HKDF-SHA-256(ss, salt = sha256(transcript), info = "tmex-sc/v1/" ‖ sender_node_id ‖ "->" ‖ receiver_node_id)`，两个方向各派生一把；AES-256-GCM，tag 16 字节，nonce = 32 位方向常量 ‖ 64 位计数器（LE），计数器接近上限即重新握手；每次握手全新密钥，重连不复用。DataChannel 路径在 DTLS 之上不再重复加密，也不做 ECDH，只做上述身份与指纹绑定。
- 证书不在 `node_certs` 或已 `revoke-node` 的一律拒绝。

### 首个用户与 hub 管理

- hub 机 `init --role hub,node` 后执行 `tmex-cli hub user add <username>`：本机提示输入密码 → 派生根钥 → 写 `users`、生成本机 enrollment 授权与节点证书并自签 `admit-node`（hub 机既是 hub 又是第一个 node，无需 join）。`hub user passwd` 生成 `rotate-root` 记录（旧钥签）；`hub user totp` 生成 `set-totp` 记录。
- hub 管理 API（`nodes` list/rename/revoke、`enrollments` create）以 hub 机的 node 为目标 `/n/<hubNodeId>/api/hub/*`，鉴权即普通 `node-session`；`revoke` 同时要求前端签 `revoke-node` 记录。非 hub 机的 entry 经 peer link / relay 转发，hub 离线时按钮禁用。

### 撤销

`revoke-node` 记录到达后各 node 删除 `peer_cache`、断开其 peer link、撤销 `via` 为该 node 的 `node_sessions`；hub 同步 `nodes.status=revoked` 并断开 uplink。`remove-passkey` 到达后撤销 `node_sessions.credential_id` 等于该 credential 的全部会话；`rotate-root` 见"根轮换 = 新安全 epoch"。
## §3 链路多路复用、载体抽象与转发边界

### 帧格式（uplink、peer link、relay 共用）

`[streamId u32][op u8][flags u8][len u32][payload]`，op ∈ `OPEN=1 / DATA=2 / END=3 / RST=4 / WINDOW=5`。stream 0 固定 `ctl`；链路发起方奇数 id，接收方偶数 id。每流初始窗口 1 MiB，接收方消费后回 `WINDOW{delta}`；单帧上限 1 MiB；单条链路未确认缓冲上限 32 MiB，超出即断开重连。编解码器位于 `packages/shared/src/link/`；`LinkSession` 接口 `openStream / onStream / close`，实现：`WebSocketLink`（uplink、peer 信令）、`DataChannelLink`（peer 数据面）、`SecureChannelLink`（relay：在 hub `relay` 流之上以 §2 握手派生的每连接方向密钥 AES-256-GCM 逐帧加密，AAD = 帧头，nonce = 32 位方向常量 ‖ 64 位计数器，计数器溢出前重新握手）、`InMemoryLink`（双角色）。

流的关闭语义：`END` 只关闭**发送方向**（half-close），每个方向各自 `END`；`http` 流请求体 `END` 后仍等待响应，响应 `END` 后流结束；`RST` 立即终止双向并传播为对端 `Request.signal` abort / 响应流 cancel；目标提前响应（未读完请求体）时目标发响应后对请求方向发 `RST`，entry 停止转发请求体。

### 流类型

- `http`：OPEN 载荷 `{method, path, query, headers, origin, auth}`。entry 侧：剥掉 `/n/:nodeId` 前缀，保留编码后的 path 与 query；**过滤 `cookie / authorization / host / connection / upgrade / proxy-* / x-forwarded-*`**；`auth` 为从 cookie `tmex_s_<T>` 取出的 `node-session`。目标侧：验 `auth`（签名、过期、`via` 与链路对端一致）→ 构造 `Request`（body `ReadableStream`，`signal` 绑定 RST）→ `GatewayRuntime.dispatchHttp(Request, {uid})`（新增的与 Bun `Server` 无关的入口；`handleRequest` 保留处理 upgrade）。响应首个 DATA 帧带 `flags.head`，内容 `{status, headers}`。`/api/auth/challenge|login` 无需 `auth`。
- `ws`：OPEN 载荷 `{auth}`；DATA 为原样 Borsh 帧。目标侧验 `auth` 后把流包装为 **carrier** 挂到新建的 `GatewaySession`。
- `relay`（仅 uplink）：OPEN 载荷 `{to: nodeId}`；hub 校验发起 node 与目标 node 同属一个 `user_id` 后向目标 uplink 开对应流并双向拷贝。其上运行 `SecureChannelLink`，内层再复用 `http / ws / ctl`。hub 看不到内层任何字段。
- `ctl`（stream 0）JSON `{t, ...}`：
  - uplink：`auth.challenge | auth.response | ping | pong | node.status | node.list | key.log | rtc.signal`。心跳 15 s，3 次无 pong 判离线。`node.status` 含版本、tmux 可用性、`direct_capable`、device 清单、`endpoints`（变更即发）。`node.list` 由 hub 在任一 node 上/下线、改名、吊销、清单变更时向**全部在线 node** 广播（`{version, key_log_head:{seq,hash}, rtc:{stun,turn}, nodes:[{id, name, online, endpoints, inventory, direct_capable, version}]}`，全量，不含密钥）。`key.log` 为 node 按需拉取的签名记录（含 `admit-node` 证书）。
  - peer link：`ping | pong | node.status | key.log | rtc.signal`（对端直接交换地址、清单与密钥日志，hub 离线时保持新鲜；peer link 存活期间地址变化即刻互相更新）。
  - `rtc.signal` 载荷 `{rtcSession, from:'browser'|'node', to: nodeId, sdp?|candidate?}`；hub / entry 转发时校验 `rtcSession` 登记的 `(浏览器会话, 目标 nodeId)`，`from:'node'` 的信令只接受来自登记目标 node 的链路。

### 响应头策略（entry 转发 `/n/:id/*` 响应）

目标 node 的响应体在 **entry origin** 下呈现，失陷 node 可返回 HTML/SVG 造成同源 XSS。entry 对所有 `/n/:id/*` 响应采用**响应头 allowlist**（只透传 `content-type / content-length / content-range / accept-ranges / cache-control / etag / last-modified / content-disposition / x-tmex-*`，其余一律丢弃），并强制：`Content-Security-Policy: sandbox; default-src 'none'; base-uri 'none'; form-action 'none'`（导航打开时在 opaque origin 渲染，脚本无法触及 entry origin 的 cookie 与 API）、`X-Content-Type-Options: nosniff`；`Content-Type` 采用精确 allowlist：`image/png image/jpeg image/gif image/webp image/avif video/mp4 video/webm audio/mpeg audio/ogg audio/wav text/plain application/json application/x-ndjson application/pdf application/octet-stream`，不在其中（含 `image/svg+xml`、任何 `*/xml`、`text/html`）的一律**覆盖**为 `application/octet-stream` + `Content-Disposition: attachment`。PDF 预览在 sandbox 下仍可 iframe 内联。

### 直连授权（浏览器 ↔ 目标 node 的 `sess` 通道）

浏览器创建 `RTCPeerConnection`、`createOffer()` + `setLocalDescription()` 后从 `localDescription.sdp` 解析自己的 DTLS 指纹 `fp_browser`，`POST /n/:T/api/rtc/authorize {rtcSession, fp_browser}`（带 `node-session`，经 entry 的认证链路送达 T）→ T 生成 32 字节随机 `nonce`，登记 `{nonce, uid, rtcSession, fp_browser, exp=2 分钟}`，返回 `{nonce, fp_node}`（T 在 `setLocalDescription` 后从自身 SDP 解析的指纹）→ 浏览器核对远端 SDP 的 `a=fingerprint` 等于 `fp_node`，否则放弃直连 → `sess` 首帧发 `{nonce}` → T 核对 `remoteFingerprint()` 等于登记的 `fp_browser` 后挂载载体；`bulk:*` 复用同一 PeerConnection，不再鉴权。该绑定挡住**失陷 hub** 改写信令做 DTLS 中间人；它**不**挡失陷 entry（authorize 请求、响应与信令都经 entry），这属于"正在使用的 entry"这一已接受的信任点（§5 安全边界）。

### 载体抽象（node 侧唯一的结构性改动）

拆 `GatewaySession`（会话身份与状态，替代所有以 socket 为键的 Map）与 `Carrier` 接口（`send(bytes): 'sent'|'backpressure'|'closed'`、`bufferedAmount()`、`onDrain(cb)`、`close(code, reason)`、`terminate()`）；实现 `BunSocketCarrier`（现状）、`LinkStreamCarrier`（`ws` 流）、`DataChannelCarrier`。一个会话持有 `primary` 与可选 `direct` 载体，任一时刻只有一条活跃；`websocket-send-guard` 改为面向 `Carrier`。

### 载体切换屏障

1. 直连 `sess` 通道鉴权通过后，node 向浏览器在**当前活跃载体**发送 Borsh 新 kind `CARRIER_SWITCH{epoch, to:'direct'}`，之后 node 的所有出站帧改走直连。
2. 浏览器收到前把直连上到达的帧缓冲；收到后先排空缓冲，再把直连设为活跃接收源，并向 node 在**旧载体**发送 `CARRIER_SWITCH_ACK{epoch}`，之后浏览器出站帧改走直连；node 收到 ACK 前把直连上到达的入站帧缓冲。
3. 直连断开：node 立即切回 primary 并发送 `CARRIER_SWITCH{epoch+1, to:'primary'}`；node→浏览器方向未送达帧由现有 `LIVE_RESUME` / `TERM_HISTORY` 补齐——浏览器收到切回通知时对已订阅 pane 触发一次 resume。浏览器→node 方向在断开瞬间已写入直连但未送达的帧**可能丢失**（与现状 WS 断线重连语义相同），不引入会话级 ACK；浏览器在切回时提示"直连已断开，最近输入可能未送达"。
4. primary 断开则会话整体结束，直连随之关闭。

### entry 侧路由

- `/api/auth/*`、`/api/mesh/*`、`/mesh/ws` **先于** gateway 路由；hub 角色再加 `/api/hub/*`、`/hub/uplink`。
- `/n/self/*` 或旧路由 → 本地 gateway（`auth` 为 `tmex_s_self`，`via = self`）；`/n/:id/api/*`、`/n/:id/ws` → `PeerManager.getLink(id)`（已有 peer link → 复用；否则按 §1 顺序建链，失败回 hub `relay`；全部失败 503 `NODE_UNREACHABLE`）→ 开流。目标返回 401 时 entry 原样透传并附 `{code:'NODE_LOGIN_REQUIRED', nodeId}`。
- `/api/mesh/nodes`：合并 `node_certs`（公钥）、`peer_cache`（元数据）与实时链路状态：`id, name, publicKey, online, reach, version, direct_capable, inventory, loggedIn`；未 admit 的节点不出现。
- `/api/mesh/rtc-config`：从 `peer_cache` 最近的 `node.list` 读 STUN/TURN，离线可用。
- `/mesh/ws`（需 `tmex_s_self`）：Borsh 新 kind `NODE_EVENT{nodeId, status, reach, inventory?}`、`RTC_SIGNAL`。

### node 侧

- `UplinkClient`：指数退避 1 s → 60 s 带抖动；连接后先 `auth.*`，再上报 `node.status`；收到 `node.list` 落 `peer_cache`（仅元数据）、`key_log_head` 落后时拉 `key.log` 逐条验签应用（含 `admit-node` → `node_certs`）。
- `PeerManager`：维护到每个 peer 的 `LinkSession`（懒建、空闲 5 分钟关闭）；peer 监听端口只接受签名信令与 `ctl`，证书不在 `node_certs` 或验签失败即关，按源 ip 限速；数据面 `DataChannelLink`（握手绑定 DTLS 指纹）；建不起来时经 hub `relay` 起 `SecureChannelLink`。hub 不可达时依次尝试 `peer_cache.endpoints_json` 中的全部缓存地址。
- `RtcPeerManager`：浏览器↔node 与 node↔node 共用 `node-datachannel` 装载与 ICE 配置（来自 `node.list`，开启 IPv6）；浏览器为 offerer；node↔node 由 nodeId 字典序小者 offer。Bun 侧适配器使用 `bufferedAmount() / setBufferedAmountLowThreshold() / onBufferedAmountLow() / maxMessageSize() / remoteFingerprint()`，浏览器侧用对应属性与事件，两套实现同一 `Carrier` 语义。装载方式：`build-runtime` 内联 node-datachannel 的 JS 层（含 `detect-libc` 逻辑）并把原生绑定改为按绝对路径 `require('<installDir>/native/node_datachannel.node')`，manifest 记录 tarball 内 addon 路径与 N-API 版本，启动时探测失败即 `direct_capable=false`。
- 默认 `TMEX_BIND_HOST=127.0.0.1`（本地 UI），peer 端口独立绑定。
- 双角色：`InMemoryLink` 实现 `LinkSession`，hub 侧无差别对待。

### DataChannel 消息尺寸与背压 / bulk 协议

`sess`：Borsh 帧 ≤ 1 MiB；DataChannel 层按 **64 KiB** 分片（`[frameId u32][idx u16][total u16]` 头），接收端重组。发送队列高水位 4 MiB 暂停（返回 `backpressure`），`bufferedAmountLowThreshold` = 1 MiB 恢复。

bulk（与现有 REST 分块协议独立）：上传 REST `init`（经 entry 转发）→ 开 `bulk:<transferId>` → `{op:'put', transferId, size}` → 64 KiB 数据帧 → `{op:'done'}` → node 校验字节数回 `{ok}` → REST `commit`；node 侧写入与现有 PUT 分块相同的临时文件路径，`commit` 复用。下载 REST `prepare` → `{op:'get'}` → 64 KiB 帧 → `{op:'eof'}`。`{op:'abort'}` 或通道关闭即清理；失败后整体改走 REST 重传。

## §4 前端改造

### 身份与入口

- 登录页（用户名 + 密码/TOTP；passkey 按钮；"注册本入口的 passkey"入口）所有 node 共用，由 `GET /api/auth/mode → {mode:'none'|'mesh', nodeId, username, kdfParams, passkeysForThisOrigin: bool, passkeyAvailable: bool}` 驱动；standalone 不渲染。密码派生、`delegation`、登录签名在 `packages/shared/src/auth/`（浏览器与 Bun 共用，`hash-wasm` + `@noble/curves`）。`passkeyAvailable` = `isSecureContext && host 为域名或 localhost`。
- 401 统一拦截：`api-client` 收到 401 → 跳 `/login?next=`；WS 关闭码 4401 同理；`NODE_LOGIN_REQUIRED` 不跳全局登录页，在该 node 行显示"登录此节点"（`sk_sess` 仍在内存时自动完成）。
- **Nodes 管理页** `/nodes`（任意 entry 可用）：列表（在线/离线、到达路径、版本、心跳、直连能力、登录状态、公钥指纹）、生成 enrollment（生成 enroll 密钥对、签授权、展示 join 串与可复制的 `npx tmex-cli hub join …` 命令；join 完成后自动签 `admit-node`，页面已关则显示"待确认"）、重命名、吊销（签 `revoke-node`）；**账号安全**区：修改密码（提示将注销所有 passkey 与 TOTP）、设置 TOTP、注册/移除 passkey（均生成签名记录）；hub 离线时管理动作禁用。

### 每 node 一套运行时

- `NodeConnectionManager`：`get(nodeId)` 懒建 `{ connection, apiClient, appRuntime }`——`createGatewayConnection`（WS 地址 `/n/:id/ws`，`self` 为 `/ws`）、带 `/n/:id` 前缀的 `ApiClient`、`createAppRuntime`（storage 前缀带 nodeId）。引用计数归零 30 s 后释放。standalone 下只有 `self`。
- 路由 `/n/:nodeId/devices/:deviceId[/windows/:windowId/panes/:paneId]`；旧路由等价于 `self`。
- `resolveNodeUrl(nodeId, path)`：`file-urls.ts`、`FilePage` 的媒体 `src` / 下载 `href`、所有直接 `fetch('/api/...')` 调用点统一迁到该解析器。
- 侧边栏聚合视图：`/api/mesh/nodes` + `NODE_EVENT` 投影出拍平列表；设备行带 node 徽标（名称来自 `nodes.name`），离线灰显，未登录显示按钮。

### 连接层

- `ws-client` 新增 `DirectCarrierController`：`RTCPeerConnection` 生命周期（信令走 `/mesh/ws` 的 `RTC_SIGNAL`）、DTLS 指纹交换与核对、`sess` 首帧 nonce、64 KiB 分片重组、`CARRIER_SWITCH` 屏障、断开回退与退避重试。`GatewayConnection` 只暴露 `activeCarrier` 与路径诊断。
- 文件传输：`bulk` 可用时走 bulk，否则走 REST（经 entry 转发）。

### 可见性

- 设备页头部两枚徽标：浏览器↔node 路径与 RTT；entry↔node 路径（`self` 时不显示）。点击展开 ICE 诊断。

## §5 打包、CLI 与兼容

### 角色与启动矩阵

`TMEX_ROLES`：`standalone`（默认）| `node` | `hub,node`。

| 角色 | 构造 | 前端 | 迁移 | tmux 检查 | supervisors |
|---|---|---|---|---|---|
| standalone | `GatewayRuntime` | 是 | gateway | 是 | 是 |
| node | `GatewayRuntime` + `MeshRuntime`（`UplinkClient` + `PeerManager` + `RtcPeerManager`） | 是 | gateway | 是 | 是 |
| hub,node | `HubRuntime` + `GatewayRuntime` + `MeshRuntime`（`InMemoryLink`） | 是 | 一次 | 是 | 是 |

`packages/app/src/runtime/server.ts` 按角色组装：请求先经 `HubRuntime.handleRequest`（`/api/hub/enrollments/redeem`、`/hub/uplink`），再 `MeshRuntime.handleRequest`（`/api/auth/*`、`/api/mesh/*`、`/mesh/ws`、`/n/*`），未命中再交 `GatewayRuntime.handleRequest`，最后静态资源 / SPA。关停顺序：peer links → uplink → hub → gateway。

### 配置

- hub：`TMEX_HUB_PUBLIC_URL`、`TMEX_STUN_SERVERS`（逗号分隔）、`TMEX_TURN_URL / USERNAME / CREDENTIAL`。hub 链路签名私钥首次启动生成，用 `TMEX_MASTER_KEY` 加密落库。
- node：`TMEX_HUB_URL`、`TMEX_PEER_PORT`（默认 39001）；`node_identity` 私钥加密落库。passkey 的 RP ID / origin 取自注册时的实际请求（同一 node 可从多个域名 origin 各注册一个 credential），不需要额外配置。
- STUN/TURN：hub 配置 → `node.list` 下发 → 浏览器 `GET /api/mesh/rtc-config`。

### CLI 新命令（`packages/app/src/commands/`）

- `hub user add|passwd|totp <username>`（本机交互输入密码，派生根钥；产生签名记录；`passwd` 提示将注销所有 passkey 与 TOTP）
- `mesh reset-root`（任意机器本地，灾难恢复，见 §2）/ `hub user reset`（hub 机本地）
- `enroll [--ttl 10m]`（任意 node，输入密码）：生成 enroll 密钥对与授权，打印 join 串与完整 join 命令，并等待 join 完成后自动签 `admit-node`（Ctrl-C 退出则由 Nodes 页确认）。
- `hub join <https-url> --token <join 串> [--name <n>]`（仅接受系统信任链验证的 HTTPS）/ `hub leave`
- `direct enable|disable`：按 `platform / arch / libc` 查 pinned manifest（`packages/app/src/lib/native-manifest.ts`：包名、addon 文件名、`integrity`、N-API 版本），从 npm registry 下载单平台 tarball，校验后解出 `.node` 到 `<installDir>/native/`（`install-layout` 新增 `nativeDir`）。缺失则 `direct_capable=false`。`init --role node|hub,node` 默认执行，失败不阻断。
- `init --role <roles>`；`upgrade` manifest 变化时重下。
- `hub join` 提示放行 `TMEX_PEER_PORT`（仅内网直连需要）。

### 兼容与迁移

- 存量单机用户升级后不变（`standalone`，无鉴权，旧路由可用）。
- 迁移到 hub：VPS `init --role hub,node` → `hub user add` → `enroll` → 各内网机 `hub join`。加入后各机自动出现在所有入口的侧边栏。
- Cloudflare Tunnel / Access 可继续放在 hub 或任一 node 前。

### 安全边界（各点失陷的实际影响）

| 失陷点 | 攻击者得到 | 能否波及其他机器 |
|---|---|---|
| 普通 node（用户未在其上登录） | 该机 tmux；用户公钥、passkey 公钥、TOTP 密文；节点证书与内网地址；该 node 自己签的 `node-session` | **否**：没有任何其他 node 接受的凭证；node 私钥只能证明"我是这台机"。弱口令可被离线爆破（此时 TOTP 一并失效），防线是口令强度与 argon2id 成本 |
| hub 机（= 该机的 node 失陷） | 同上 + 节点目录；可断链、隐藏节点、拒绝服务、篡改 `node.list` 元数据（名称/地址） | **否**：relay 是密文；签不出任何用户凭证或节点证书；未 admit 的节点被所有 node 忽略；篡改信令做 DTLS 中间人被指纹绑定识破；掉包公钥骗不过绑定 `target_pk` 的签名 |
| 用户**正在使用**的 entry | 在其 `node-session` 有效窗口内（最后一次使用起 18 小时滑动，绝对上限 7 天）以用户身份操作各已登录 node，并可读取/篡改经它的流量（含直连信令）——它是流量代理并持有 cookie，任何 web 架构都挡不住；密码登录时键入的密码 | 窗口内是；密码泄露后到 `passwd`（新 epoch）前是，攻击者若抢先 `rotate-root` 则走本机 `mesh reset-root` 恢复。passkey 登录只泄露该窗口：临时钥签不了任何持久记录 |
| hub 离线 | 无变化：登录不经 hub；内网 peer 用缓存直连 | — |

另：目标 node 响应经 entry 的响应头策略隔离，失陷 node 不能在 entry origin 执行脚本；所有 `/n/:id/*`、`relay` 校验 `user_id` 与凭证 `uid` 一致（单用户 v1 下即常量校验，多用户时不改结构）。

## 测试策略

- 单测：link 编解码、流控与 half-close、`SecureChannelLink`（每连接密钥、nonce 不重用）（`packages/shared`）；根钥派生向量（浏览器与 Bun 结果一致）、`delegation` 与登录签名的 Borsh 编码/验签、challenge 一次性消费、`node-session` 的 `via` 绑定与 18 小时滑动续期、`user_key_log` 链（seq/prev_hash/epoch、分叉硬失败、`rotate-root` 清空 passkey/TOTP/会话）、TOTP 加解密（nonce/AAD）；enrollment 与证书链（join 串根钥不一致、`enroll_pk` 不匹配、未 admit 均失败）；peer link 双向握手与 DTLS 指纹绑定；`Carrier` 三实现与 send-guard；`CARRIER_SWITCH` 屏障；bulk 状态机；响应头 allowlist 与 MIME 覆盖。
- 集成：同一进程内起 `HubRuntime` + 两个 `GatewayRuntime + MeshRuntime`（`InMemoryLink` 模拟 uplink 与 peer link），验证登录 fan-out、`/n/:id/api/*`、`/n/:id/ws` 透传、`relay`、`node.list` 广播、吊销后 peer link 断开与会话失效、**失陷模拟**（只持 node A 私钥与数据库的客户端对 B 的所有请求被拒；持 hub 全部数据的客户端签不出 B 接受的任何凭证，也无法让 A 接受一个未 admit 的节点；hub 掉包 B 公钥/篡改信令后登录与直连均被拒绝）。
- WebRTC：node-datachannel 回环（浏览器↔node、node↔node）+ `DataChannelCarrier` 分片/背压，`*.integration.ts`，CI 默认不跑。
- e2e：登录（密码 + TOTP；passkey 用 Playwright virtual authenticator）→ Nodes 页生成 token → 模拟 node join → 侧边栏自动出现新 node → 打开其终端；standalone 基线不退化。

## 验收标准

1. 两台无公网地址的机器 `hub join` 后，在 hub 入口与**任一 node 的本地 UI** 都能同时打开各自终端、agent、文件面板，无需手动添加。
2. 同内网两台 node：entry↔node 与浏览器↔node 徽标均 `lan`，终端 RTT < 10 ms；`direct disable` 后自动回落 `relay` 且功能不变；直连中途断开终端不丢内容。
3. hub 停机：在 node A 本地 UI 用密码登录，仍能操作同内网的 node B（B 的缓存地址仍有效）；hub 恢复后无需重新登录。
4. 失陷模拟（集成测试）：仅持 node A 或 hub 的全部私钥与数据库、无用户密钥的客户端，对其他 node 的所有 `http/ws/relay` 请求被拒绝，且无法向任何 node 注入新成员；relay 抓包不含明文 Borsh 帧。
5. 存量 standalone 安装升级后无登录页、旧路由可用、e2e 基线不退化。
6. tmex-cli tarball 增量 < 1 MB（`hash-wasm` 的 argon2 wasm 与 `@noble/curves` 计入）。

## 风险与待验证项

- node-datachannel 0.33.1 + Bun 1.3.14 回环 PoC 已通过（macOS arm64 / Linux arm64 / Linux amd64）；node↔node 同时发起由 nodeId 字典序规避，集成测试覆盖。IPv6 候选未实测。
- argon2id 64 MiB 在低端手机浏览器约 1–3 s，登录只算一次可接受；`hash-wasm` 在 Bun 与主流浏览器的结果一致性需用测试向量锁定。
- WebAuthn 要求 RP ID 为域名：`http://<内网 IP>` 与 `https://<IP>` 均不可用，passkey 只在域名 https 或 localhost 的 entry 上提供；`hash-wasm` 未正式声明支持 Bun，测试向量必须覆盖。
- hub 不可达期间若 node 的 IP 变化，缓存地址失效，v1 不做本地发现（签名 UDP 信标留作后续）；peer link 存活期间地址变化会即时互相更新。
- 载体切回时浏览器→node 方向可能丢失最近输入（与现状 WS 断线一致），UI 提示而不做会话级 ACK。
- `GatewaySession` / `Carrier` 拆分是最大的一块重构，须先于 link / 直连落地并保持现有测试全绿。
- 存量文档 `docs/2026021000-tmex-bootstrap/deployment.md` 中 JWT / 登录内容已过时，实现后重写。

## §6 任务拆分

见 `prompt-archives/2026082701-hub-multinode-design/plan-00.md`。
