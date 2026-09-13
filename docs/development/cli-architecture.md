# 客户端 CLI 架构（packages/cli）

`vibeterm login|api|term|…` 这些**客户端命令**的模块契约，面向要新增命令组的开发者。命令组作者读完本文即可动手；只想用 CLI 的看 `vibeterm --help` 与各组的 `--help`。

## 背景

`packages/app`（发布名 `vibeterm-cli`）里原有的命令都是**本机运维**命令：`init` / `upgrade` / `hub …` / `relay …`，它们直接读本机安装目录、库与主密钥。`packages/cli`（`@vibeterm/cli`）是另一类东西——**只经 HTTP / WebSocket 访问网关的客户端**，安全边界与网页端逐条对齐，因此可以指向任意 entry，也可以在没有本机安装的机器上用。

两者的分界：

| | packages/app（原有） | packages/cli（本文） |
| --- | --- | --- |
| 命令 | `init` `doctor` `upgrade` `uninstall` `hub` `relay` `mesh` `tls` `enroll` `direct` | `login` `logout` `whoami` `api` `nodes` `devices` `tmux` `term` `files` `cp` `port` `share` `watch` `agent` `settings`（十五个组） |
| 依赖 | 本机安装目录、SQLite、主密钥；`hub`/`relay` 那组还要 bun 运行时 | 只有 `fetch` 与 WebSocket |
| 运行时 | Node（`init` 等）+ bun（`cli-auth-entry.ts`） | Node ≥ 20（bundle 也能在 bun 下跑） |
| 权限 | 本机 root 级配置 | 与一个浏览器会话完全等价 |

## 安全边界（不可退让）

1. 登录流程与浏览器逐步一致：`GET /api/auth/mode` → `POST /api/auth/challenge` → argon2id 派生根种子 → 生成临时会话密钥对 → 签 `Delegation(method='root')` + `Login` → `POST /api/auth/login`（可带 TOTP）。服务端没有为「本机 CLI」新开任何信任面；`client-source.ts` 的回环 / 内网通行密钥豁免照旧生效。
2. **CLI 从不使用本机节点的 mesh 身份、数据库、主密钥或 `app.env` 里的密钥**去访问别的 node。访问别的 node 一律经 entry 的 `/n/<nodeId>/…` 转发，并携带**那个 node 自己的**会话 cookie（`vibeterm_s_<nodeId>`），该 cookie 由 `/n/<id>/api/auth/login` 换来——与网页端的 `loginToNode` 完全相同。
3. 根种子与根钥私钥只在内存里活到 delegation 签完，随即清零（`core/auth.ts` 的 `buildSessionMaterial`）。**落盘的只有会话 sid 与到期时刻**，密码、种子、会话私钥一概不写盘。
4. 两步验证由 TOTP 满足（`--totp` / `VIBETERM_TOTP` / TTY 提示）。服务端 `/api/auth/mode.secondFactorPolicy` 为 `either` 时，一个有效 TOTP 码即可通过通行密钥这一关；为 `passkey`（账号没开 TOTP、但本 origin 注册了通行密钥）时 CLI 做不了断言，退出码 3 并说明补救办法。CLI 不实现 WebAuthn。
   `k_totp`（TOTP 密文的解密钥）在签完 delegation、清零种子**之前无条件派生**：旧版本入口的 `/api/auth/mode` 不下发 `totpEnabled` / `secondFactorPolicy`，要等它回 `TOTP_REQUIRED` 才知道要交码，那时种子已经没了。所以只要用户给了码就一定带得上，不会出现「反复重试直到撞限流」。
5. 登录 entry 之后照浏览器的 `verifySelfPublicKey` 再核一道：challenge 里 entry 当场出示的 `nodePk`，必须与 `/api/mesh/nodes` 里它自己那行的 `publicKey` 逐字节一致。对不上就地删掉刚拿到的会话并以 `NODE_PK_MISMATCH`（退出码 3）中止——入口可能被掉包或配置错乱。名册里没有自己那行（standalone / 旧网关 / 成员表未同步）时跳过。
6. fan-out 里某台 node 失败，会像 entry 一样给出完整解释（`PASSKEY_REQUIRED` 也不例外），并且**绝不重发**——重发只会再被拒一次、多记一次失败。失败全是鉴权类时退出码 3，混了别的原因才退 1。

## 目录与模块

```
packages/cli/src/
  main.ts                入口：找命令、拆全局旗标、建 ctx、翻译退出码
  registry.ts            命令注册表（十五个已落地组）
  version.ts             自报版本（网关的 canonical v1.1 版本门要用）
  commands/
    types.ts             Command 契约
    login.ts logout.ts whoami.ts api.ts
    agent.ts agent-format.ts
    nodes.ts nodes-hub-role.ts nodes-relay.ts nodes-ports.ts nodes-ops.ts
    settings.ts settings-http.ts settings-site.ts settings-local.ts
    settings-llm.ts settings-shortcuts.ts
    settings-security.ts settings-messaging.ts
    tmux.ts tmux-layout.ts
    devices.ts files.ts …
  core/
    args.ts              轻量参数解析 + 全局旗标拆分
    config.ts            配置目录与默认 entry 的优先级
    session-store.ts     session.json（0600）
    http.ts              cookie 罐、Origin、会话续期、JSON/NDJSON/字节、错误翻译
    auth.ts              登录流程（浏览器版去掉 WebAuthn）
    account-security.ts  改密 / TOTP / 删 passkey 的 key-log 签名
    settings-body.ts     LLM models/default/search、tunnel Access 旗标
    settings-tls-body.ts TLS PUT body（对齐 GUI tls-form）
    watch-body.ts        watch 规则旗标（含 extract/LLM）
    resolve.ts           node / device 解析与目标文法
    ws.ts                ws → WebSocketLike 适配、openGatewaySocket
    output.ts            表格 / JSON 打印、诊断日志改道
    prompt.ts            隐藏密码输入、读 stdin
    test-fakes.ts        单测用的假网关（不进 bundle）
```

打包：`bun build src/main.ts --target node --format esm --outfile dist/cli.js`（`bun run --filter @vibeterm/cli build`）。

**bundle 必须能在纯 Node 下跑**：不要 import Bun-only 的模块（`packages/shared/src/link/websocket-link.ts`、`packages/transfer/src/node/source.ts` 之类），需要 shared / api-client 里的东西就 import 更窄的子路径（如 `@vibeterm/shared/auth`、`@vibeterm/api-client/node-url`），别拉浏览器侧的主 barrel。改完跑一次 `node packages/cli/dist/cli.js --help` 验证。

## 新增一个命令组

1. 写 `src/commands/<group>.ts`，导出 `command: Command`：

```ts
export const command: Command = {
  name: 'devices',
  summary: '一行说明，进 vibeterm --help 的列表',
  usage: '多行用法，进 vibeterm devices --help',
  flags: { long: 'boolean', name: 'string' }, // 本组自己的旗标；全局旗标不要重复声明
  async run(ctx, argv) {
    const { flags, positionals } = parseArgv(argv, FLAGS);
    // …
    return 0; // 返回值即退出码；返回 undefined 视为 0
  },
};
```

2. 在 `src/registry.ts` 的 `IMPLEMENTED_COMMANDS` 登记（十五个组已全部落地，`RESERVED_COMMANDS` 为空）。
3. `packages/app/src/lib/client-cli.ts` 的 `CLIENT_CLI_COMMANDS` 已经把十五个组全部登记好了，**新增组名时两处都要改**——`registry.test.ts` 会比对两份名单。本机运维新增子命令（如 `relay metrics`）还要挂 `cli-auth-entry.ts` 的 `HANDLERS` 与 `AUTH_COMMANDS`，否则 parse 成功却 dispatch 失败。

`main.ts` 已经替命令做完这些事：解析并校验全局旗标（未知旗标在这里就报用法错误）、处理 `--help`、把全局旗标从 argv 里摘掉、构造 `ctx`、把抛出的 `CliError` 翻成退出码与提示。命令拿到的 `argv` 里只剩自己的旗标与位置参数。

### ctx 的形状

```ts
interface CliContext {
  globals: { entry, node, json, quiet, color, timeoutMs };
  out: Output;          // 结果走 stdout，提示走 stderr
  http: HttpClient;     // 按 node 记账的 cookie 罐
  sessions: SessionStore;
  resolver: Resolver;   // node / device 解析（带缓存）
  configDir: string;
  targetNodeId(): Promise<string>;                    // --node 解析结果，未给即 'self'
  openSocket(nodeId, options?): Promise<GatewaySocket>;
}
```

- `ctx.http.json(nodeId, method, path, body?)`：非 2xx 直接抛。401、以及 body 里 `error`/`code` 是会话判词的 403（`UNAUTHORIZED`、`via_mismatch`、`expired`、`revoked`、`SESSION_*`、`*LOGIN_REQUIRED`）→ 退出码 3 并带 `vibeterm login --node <id>` 提示；其余 403（`outside_roots`、`FORBIDDEN`、`UPGRADE_NOT_ALLOWED`、`peer_mismatch` 等）是权限不足，抛 `PermissionError` → 退出码 1 且 message 带上服务端的业务码；404 → 4，其余 → 1，传输失败 → 5。这套映射只有 `httpStatusError()` 一份，文件族不再有自己的翻译层。
- `ctx.http.fetch(nodeId, path, init)`：不对状态码做判断，自己处理时用它；`ctx.http.assertOk()` 补上统一翻译。
- `ctx.http.ndjson(nodeId, path)`：逐行 yield 已解析对象，默认不设超时（长流用）。
- `ctx.http.bytes(nodeId, path)`：二进制。`RequestOptions.timeoutMs` 可按请求覆盖 `--timeout`，`null` 表示不设。
- `ctx.resolver.resolveNode(ref)`：接受 node id、node 名字、`self`/`local`/`entry`；重名报用法错误，找不到报 4。
- `ctx.resolver.resolveDevice(nodeId, ref)`：device id 或名字。
- `parseTarget(input)`：纯函数，拆 `[<node>/]<device>[:<window>[.<pane>]]`。node 与 device 以**第一个** `/` 分界，device 与位置以**第一个** `:` 分界，window 与 pane 以**最后一个** `.` 分界；同时保留 `location` 原文，窗口名本身含 `.` 时可整段回退。window/pane 到会话树的定位由 term 命令组自己做。
- `ctx.globals.tls`：`--ca` / `--insecure` 的解析结果，`http` 与 `openSocket` 都已经带上，命令组不用自己管。
- `ctx.out`：`data(value)`（`--json` 时紧凑一行，否则缩进两格）、`table(rows, columns)`、`line()`、`raw(bytes)`；`info()` / `warn()` 走 stderr，`--quiet` 或 `--json` 时静默。**stdout 只放命令结果**，`main.ts` 已经把库里的 `console.log`（`@vibeterm/ws-client` 的连接状态日志）改道到 stderr。

### WebSocket

`ctx.openSocket(nodeId)` 建一条到目标 node 的 Gateway WS，等 HELLO 协商完成后返回 `{ connection, cid(), close() }`。要点：

- npm `ws` 被 `core/ws.ts` 适配成 `@vibeterm/ws-client` 的 `WebSocketLike`，经 `socketFactory` / `wsUrlFactory` 注入，**没有改动 `@vibeterm/ws-client`**——那个包是 DOM 取向的，一律靠注入而不是打补丁。
- URL 为 `ws(s)://<entry>/ws?cid=…` 或 `…/n/<id>/ws?cid=…`，每建一条 socket 换一个新 nonce（合约要求）；浏览器设不了请求头，CLI 则把该 node 的会话 cookie 放进握手头。
- 网关按 `clientVersion` 做 canonical v1.1 版本门且 fail-closed，所以 `main.ts` 启动时先 `setDefaultClientVersion(cliVersion())`。`version.ts` 依次尝试构建期注入、`VIBETERM_CLI_VERSION`、同级 / 上级 `package.json`；报不出版本会被网关用 1002 关掉。
- 会话失效时网关用 **4401** 关闭，适配层把它翻成退出码 3 并指路 `vibeterm login`。
- 首连不自动重连（`maxReconnectAttempts: 0`），要不要重连由各命令自己决定。

## TLS 信任

| 旗标 | 作用 |
| --- | --- |
| `--ca <pem-file>` | 追加一个信任锚（自签 CA），https 与 wss 都生效 |
| `--insecure` | 不校验服务端证书；每次都往 stderr 打一行醒目警告，**永远不是缺省** |

**绝不设置 `NODE_TLS_REJECT_UNAUTHORIZED`**：那是整个进程的全局开关，还会被子进程继承。两个运行时各走一条显式通道（`core/tls.ts`）：

| | fetch | ws |
| --- | --- | --- |
| Bun | 每个请求的 `init.tls`（`{ca, rejectUnauthorized}`） | `tls.connect` 选项 |
| Node | 进程内 `tls.setDefaultCACertificates()`（Node ≥ 22.15） | `tls.connect` 选项 |

Node 上的 `--insecure` 落地方式是 TOFU：先用 `rejectUnauthorized:false` 连一次入口，把它出示的整条证书链装成本进程的信任锚。因此**主机名仍然校验** —— 证书 SAN 与访问地址不符时依旧失败，那种情况请用 `--ca` 指定正确的 CA。Node < 22.15 装不了运行时信任锚，会直接报错并指路 `NODE_EXTRA_CA_CERTS=<pem>`。

`mode.caFingerprint`（自签 CA 的 SPKI sha256）**没有做钉扎**：Node 的 fetch 不把证书链交给调用方，只有 ws 那条路径拿得到；只钉一半会给人「全都钉住了」的错觉，所以宁可不做。要严格限定信任范围就用 `--ca <该 CA 的 pem>`，验证由 TLS 栈本身完成。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般失败（含 `api` 的非 2xx） |
| 2 | 用法错误（未知命令 / 未知旗标 / 参数缺失 / 命令组尚未实现） |
| 3 | 需要登录或两步验证（`AuthError`） |
| 4 | 目标不存在（node / device / 路径） |
| 5 | 网络层失败（连不上、超时、DNS） |

命令一律抛 `core/errors.ts` 里的错误类型，不要自己调 `process.exit()`。

## 配置与会话文件

配置目录：`$VIBETERM_CLI_HOME` > `$XDG_CONFIG_HOME/vibeterm` > `~/.config/vibeterm`。

默认 entry：`--entry` > `$VIBETERM_ENTRY` > 会话文件里最后用过的 entry > 本机安装的 `app.env` 里的 `VIBETERM_BASE_URL`（**只读**，CLI 从不改写安装目录） > `http://127.0.0.1:9883`。

`<配置目录>/session.json`（目录 0700、文件 0600、原子写）：

```json
{
  "version": 1,
  "lastEntry": "https://vt.example.com",
  "entries": {
    "https://vt.example.com": {
      "entry": "https://vt.example.com",
      "uid": "u-...", "username": "admin", "updatedAt": 1757000000000,
      "nodes": {
        "self": { "nodeId": "self", "sid": "…", "expiresAt": 1757064000000 },
        "<32 位 hex node id>": { "nodeId": "…", "sid": "…", "expiresAt": 1757064000000 }
      }
    }
  }
}
```

文件里**只有** sid 与到期时刻。会话被服务端续期时（`X-Vibeterm-Session-Renewed`）就地更新到期时刻；`X-Vibeterm-Set-Session` 与 `Set-Cookie` 两种下发形态都认（前者是转发链路内部头，后者是浏览器看到的形态），`;0` / `Max-Age=0` 视为登出并清掉本地记录。手工改坏文件不会让 CLI 起不来：认不出的字段一律丢弃。

回收 Set-Cookie 时**只收 `self` 与本次请求的目标 node** 这两把：浏览器靠 cookie 作用域挡住越权写入，CLI 只有一个进程内的罐子，得自己挡——一次重定向或一个被塞了第三台 node cookie 的响应，不该把我们手上那台的会话换成对面给的值。

另外，`--node` 给的规范 id 若正好是 entry 自己（`/api/auth/mode.nodeId`），一律落回 `self`：走 `/n/<自己的 id>/` 会被入口当成一次转发，cookie 名与 via 都不对。

`vibeterm logout` 会对持有会话的每个 node 各发一次 `/api/auth/logout`（各 node 撤销自己签发的全部会话），再删掉本地这条 entry。

## 与 packages/app 的接线

`vibeterm <group>` 由 `packages/app/src/index.ts` 的 `dispatchCli` 在**当前进程内** `import()` 客户端 bundle 并调 `runCli(argv)`（保住 TTY，也省一次进程启动），退出码原样透出。与 `hub`/`relay` 那组不同：那些命令要 bun 运行时，所以走 `auth-spawn.ts` 起子进程。

bundle 的查找顺序（`packages/app/src/lib/client-cli.ts`）：

1. `$VIBETERM_CLI_BUNDLE`（测试与排障用）
2. 与 `dist/cli-node.js` 同级的 `cli.js`——安装版是 `<installDir>/current/cli/dist/cli.js`，npm 包里是 `<pkg>/dist/cli.js`
3. 开发态的 `packages/cli/dist/cli.js`
4. 开发态源码 `packages/cli/src/main.ts`（只有 bun 能直接跑 `.ts`）

打包链路：`packages/app` 的 `build:cli` 里串了 `build:client-cli`，把 `packages/cli/src/main.ts` 打进 `packages/app/dist/cli.js`；`files` 已含 `dist`，所以随 tarball 发布；`deployCliPackage()` 再把它拷到 `<installDir>/current/cli/dist/cli.js`。≤2.0.8 的旧包里没有这个文件，拷贝那步会跳过（只影响这些客户端命令，不该让部署失败）。

## 验收

```
cd packages/cli && bun test && bunx tsc --noEmit -p . && bun run build
node packages/cli/dist/cli.js --help          # bundle 必须能在纯 Node 下跑起来
cd packages/app && bun test src && bunx tsc --noEmit -p .
bunx biome check <改动的文件>                  # 仓库根执行
bun scripts/complexity/gate.ts
```

## 复杂度门禁

`bun run lint` 的后半段是 `bun scripts/complexity/gate.ts`，扫描 `apps/` 与 `packages/` 下的 `.ts` / `.tsx`（跳过 test / spec / integration / bench、生成的 i18n `resources|types`、`vendor/`、`tests/`）。阈值：

| 指标 | 上限 | 说明 |
| --- | --- | --- |
| 圈复杂度（McCabe） | 12 | `if` / 三元 / `case` / 循环 / `catch` / 短路逻辑（含 `??`） |
| 函数行数 | 80 | AST 起止行（含） |
| 文件行数 | 500（450 起 warn） | 无文件级 allow 时 450–500 只提醒 |
| 参数个数 | 5 | 不含 TypeScript `this` 参数 |
| 嵌套深度 | 4 | 只计 `if` / `for` / `while` / `switch` / `try` 与匿名箭头回调块；不计裸 `Block`，`else if` 不加层 |
| 跨文件重复 | ≥ 15 行规范化窗口，≥ 2 个文件 | 去掉注释 / 字符串 / 数字后做 token-hash；忽略 import 块、纯字面量窗、色板与类型字段噪声 |

存量超标写在 `scripts/complexity/allowlist.json`（键为相对路径或 `相对路径:函数名`），只许缩小不许升高；降回默认阈值内的字段 / 条目直接删除。`--tighten` 按当前实测值收紧，并把新阈值下已有超标冻结成新条目。故意同构的文件对写在 `scripts/complexity/duplication-allowlist.json`（无序对，例如 `en.ts` ↔ `zh-cn.ts`、hub-runtime ↔ relay-runtime）。`--report` 打印各指标计数与 top-10，不判定失败。新代码必须落在默认阈值内，不要往 allowlist 加条目。单测：`bun test scripts/complexity/gate.test.ts`。

## 注意事项

- 单测不打真实 endpoint。登录流程用 `core/test-fakes.ts` 的假网关（用 `@vibeterm/shared/auth` 真造一个用户，服务端侧真验签名与 TOTP），HTTP 层用假 `fetch`。要打真实网关的用例按 `live-integration-tests.md` 的约定单独放。
- `--json` 的调用方直接管道 stdout，所以往 stdout 写任何非结果内容都是 bug。
- 新增全局旗标要同时改 `core/args.ts` 的 `GLOBAL_FLAGS`、`main.ts` 的帮助文本与 `core/context.ts` 的 `CliGlobals`。

## `vibeterm files`

子命令：`roots [ls|add|rm|order|set|enable|disable]`、`ls`、`stat`、`cat`、`mkdir`、`browse`。路径与 GUI 相同：底层是 `rootId` + 绝对路径；CLI 接受 `[<node>:]<rootId>:<relpath>` 或 `[<node>:]<rootName>/<relpath>`，以及两段式 `<node> <spec>`。末尾单独一个冒号（`<root>:`）表示根本身。展示名为 `/` 的根必须用 `<rootId>:<relpath>`，斜杠形式会和本地绝对路径撞车。`..` 段在客户端直接报用法错误。`fs-root` 仅在节点没有启用根时有效。`ls` 走 `GET /api/files/list`（服务端每层最多 2000 条，`truncated: true` 时无法再翻页）。`cat` 走 `GET /api/files/raw`，二进制直写 stdout，忽略 `--json`。`mkdir <spec> [--recursive]` 走 `POST /api/files/mkdir`。`roots set <id|name> --path /abs [--enabled on|off]` 走 `PATCH {path, enabled?}`（path 必须绝对路径）。`roots enable|disable <id|name>` 走 `PATCH /api/files/roots/:id {enabled}`。`--enabled` 是字符串旗标（`on|off`），`roots add --enabled` 必须带值；`--disabled` 仍是布尔。`browse --device <id> --path <p> [--hidden]` 走 `GET /api/files/browse`（`--device` / `--path` 都必填）。文件路由的 `403 outside_roots|root_disabled|permission_denied` 是权限错误（退出码 1），不要当成未登录——由 `core/http.ts` 的 `httpStatusError()` 统一判定，`files-api.ts` 只调 `http.assertOk()`。旧节点探测（mkdir 路由不存在）必须匹配响应 JSON 的 `code === 'route_not_found'`（网关全局 404 的稳定码，`apps/gateway/src/api/index.ts`），无该字段时再回退英文 `Not found` / 无业务码的裸 404 以兼容更旧节点；`error`/`code` 为业务 `not_found|root_not_found|device_not_found` 时不是缺路由。`mkdirRemote()` 直接复用 `@vibeterm/api-client` 的 `mkdirPath()`（URL 与请求体唯一来源，CLI 侧只把 `ctx.http` 包成 `ApiClient` 注入，再把 `FileApiError` 翻成 CLI 的退出码语义），避免两个客户端各写一份。

`--json` 形状：

- `roots`：`{ "roots": [{ id, name, path, deviceId, deviceName, enabled, sortOrder }] }`
- `ls`：`{ node, root, path, truncated, entries }`
- `stat`：`{ node, rootId, path, name, type, size, modifiedAt, mime, isSymlink }`
- `mkdir`：`{ node, rootId, path, created }`
- `browse`：`{ node, deviceId, path, parent, entries, truncated }`

## `vibeterm cp`

`cp <src> <dst>`：任一侧为 `[<node>:]<root>/<path>` 或本地路径（`./`、`../`、`~`、操作系统绝对路径）。节点侧的 `<path>` 是相对该根的路径；**前导 `/` 表示文件系统绝对路径，会被 `outside_roots` 拒绝**。本地→节点：先 `POST /api/files/mkdir {recursive:true}`（每个目录一次、带缓存；空目录也会建）保证目标目录存在，再 `upload/init` → 8 MiB PUT（失败按已收区间续传；`runPush` 必须注入 `sleep`，否则重试会连发；阶梯退避带抖动）→ `commit`。节点过旧、mkdir 路由不存在（404 `code: route_not_found`，无该字段时回退英文 `Not found`；区别于业务 `not_found`）时在上传前失败。节点→本地：`download/prepare` → `GET content`（`Range` / 206 续传，截断后抖动退避再试）。节点→节点：先 `POST /n/<B>/api/transfer/grants`，再 `POST /n/<A>/api/transfer/jobs`，跟 `GET .../jobs/:id/events` NDJSON；流在非终态结束则轮询 `GET .../jobs/:id` 直到 `finishedAt !== null`（受 `--timeout` 约束）。`-r` 递归目录，**local→node 依赖目标节点支持 mkdir**。`--on-conflict overwrite|skip|rename`（默认 skip；`rename` 只用于 local↔node；node↔node 不能把文件改名到不存在的目标，必须传已有目录）。`--fail-on-skip` 在冲突/符号链接跳过时也退出 1。listing 截断或任何错误退出 1。SIGINT/SIGTERM 会 `DELETE` 进行中的 upload/download 会话并以 130 退出。人读进度默认只在 TTY 开，`--progress` / `--no-progress` 覆盖，节流 ≥500 ms 或 ≥1%。`cp jobs ls|cancel <id>` 管传输任务。

`--json` 时 stdout 仅为 NDJSON 进度：`{"type":"progress"|"item"|"done", ...}`，`done` 带 `files` / `skipped` / `errors` / `truncated`。`cp jobs ls --json`：`{ "jobs": [ { jobId, state, fromNodeId, toNodeId, progress, items } ] }`。

## `vibeterm port`

`map <listenPort> <targetNode>:<host>:<port> [--listen-host] [--name] [--on]`：先在 B 建 export，再用同一 `mapId` 在 A 建监听。A 返回 4xx 时撤掉 B 的 export；5xx / 网络错误则保留 export，并提示 `vibeterm port rm --export <mapId> --on <B>`（直接 `DELETE /api/portmap/exports/:mapId`）。监听节点与目标节点相同（含 `self` 与它的 mesh id）时客户端直接报用法错误：网关没有同节点短路，映射会显示 `listening` 但每条连接都 `bad_signature`。`ls` 含实时计数。`rm <id>` 看 `exportRemoved`，未清则再删 B。`pause|resume` 走 PATCH。`probe <node>:<host>:<port>` 同时打 `/api/portmap/probe` 与 `/target-probe`。

`--json` 形状：`{ "map" }` / `{ "maps" }` / `{ "removed", "exportRemoved" }` / `{ "listen", "target" }`。

## `vibeterm nodes`

子命令：`ls`、`show`、`hubs`、`hub-role`、`rename`、`relay`、`ports`、`allow`、`disallow`、`revoke`、`enroll`、`upgrade`（含 `cancel` / `--ids`）、`op clear`、`uninstall`、`rtc-config`、`pause`、`resume`。实现拆在 `commands/nodes.ts` 与 `nodes-hub-role.ts` / `nodes-relay.ts` / `nodes-ports.ts` / `nodes-ops.ts`。`ls` 合并 `GET /api/mesh/nodes` 与 hub 待批准行（`status=pending`），列含 ADDRESS（`nodeAddressOf`）与 PAUSED；ONLINE 对离线行拼相对时间（`listedOnline`，如 `no · 3h ago`）。`--json` 透传 `paused`、`lastSeenAt`、`address`。REACH 为 `reachOf`：`lan/dc` 这类 `reach/transport`，中继收成 `relay`。`pause` / `resume` 打 entry `POST /api/mesh/nodes/:id/pause|resume`；`CANNOT_PAUSE_SELF` / `CANNOT_PAUSE_HUB` 分别翻成 `cannot pause this machine (CODE)` / `cannot pause a hub node (CODE)`（Hub 恢复不报后者）。`show` 人读增加 PORTS 表，并打印 `address`、`lastSeenAt`。`rename`：hub 转发到 writer 的 `POST /n/<hub>/api/hub/nodes/:id/rename`；中继（`GET /api/mesh/relay/status` `mode==='relay'`）走 keylog `rename-node`，不再打 hub REST。`hub-role promote|demote|standby <node> [--yes] [--wait] [--force]` 打 `POST /n/<id>/api/hub/role`（未签名授权时先签 `admit-hub`），不能用本机 `hub promote` 代替。`relay ls|switch|rm|readmit` 是租户侧 status / switch / keylog；`relay ls` 多一列 ATTACHED，与本机运维 `relay list` 不是同一条命令。`ports <node> [--probe]` 读 `MeshNode.ports[]`。`upgrade cancel <node>` 打 `DELETE …/upgrade`，非 TTY 必须 `--yes`；`--ids a,b,c` 与 `--all` 互斥、隐含 `--wait`。`--version <ver>` 写入 `POST /api/mesh/nodes/:id/upgrade` body（未发布 tag → `400 RELEASE_NOT_FOUND`）。`op clear` 打 `DELETE …/operation`。`allow` 先查 hub 列表：`admission_status=pending` 时签 `admit-node`，否则 `PATCH /api/system/domain-access {allowed:true}`。`disallow` 关域名访问。`revoke` 签 `revoke-node`（需 `VIBETERM_PASSWORD`）；非 TTY 必须 `--yes`；mesh 里没有的节点可回退到 hub 列表。`enroll --password` 只打印 `vibeterm hub join <url> --password`；默认路径签 enrollment 并打印 join 命令。`upgrade --wait` 轮询 `GET /api/mesh/nodes/:id/upgrade`。`--all` **强制** `--wait`：按组（普通节点 → hub → 本机）等上一组全部收尾再开下一组；只升 online、已登录、未暂停、版本严格低于 latest 的节点；任一 `failed` / `timeout` / `unconfirmed` 退出码 1。`uninstall`：`POST /api/mesh/nodes/:id/uninstall` 后签 `revoke-node`（吊销失败即失败）；非 TTY 必须 `--yes`。

`--json` 形状：`{ nodes }`（含 `status`、`paused`、`address`、`lastSeenAt`） / `MeshNode & { address }` / `MeshHubsResponse` / `{ kind, operationId, verb, node, … }`（hub-role） / `{ node, ports }` / `{ ok, node }`（op clear / pause / resume） / `{ node, action, result }`（allow） / `{ node, result }`（revoke） / `{ latest, outcomes }`（`outcome` 含 `unconfirmed`） / `{ node, cancelled: true }`（upgrade cancel） / `{ node, scheduled, revoked }`（uninstall） / `{ stun, turn, probes? }` / `{ id, expiresAt, joinToken, joinCommand, publicUrl }`。

## `vibeterm devices`

子命令：`ls|show|add|edit|rm|test|order|connect|disconnect` 与 `folders ls|add|rm|layout|rename|reset`。`add`/`edit` 旗标镜像 GUI 表单（`--name --type local|ssh --host --port --user --auth-mode --password --private-key --passphrase --session --cwd --ssh-config`），复杂体也可 `--body`。口令 / 密钥不要写在 argv 上（会进进程列表，CLI 会往 stderr 警告）：优先 `--password-stdin`、`--password-file` / `@file`，或 `VIBETERM_DEVICE_PASSWORD`（`--private-key` / `--passphrase` 同理，`VIBETERM_DEVICE_PRIVATE_KEY` / `VIBETERM_DEVICE_PASSPHRASE`）。`rm` 非 TTY 必须 `--yes`。`order` 走 `PUT /api/devices/order`。`connect <device> [--once]` 发 `connect-device`，等到 `device-connected` 或第一份 `metadata-snapshot` 后默认持有这条 WS 直到 Ctrl-C（网关在最后一个客户端离开 5 s 后释放设备运行时）；`--once` 只确认一次就退出。`disconnect <device>` 只向本条 CLI WS 发 `disconnect-device` 并等 `device-disconnected`，**不**先 `openDeviceSession`；网关按 session 摘 client，不会拆掉 GUI 或其他客户端已连上的设备。分组走 `/api/device-folders`；`layout` 需要 `--body {folders,placements}`；`folders rename <id> --name <n>` 打 `PATCH`；`folders reset` 打 `POST /api/device-folders/reset`（非 TTY 必须 `--yes`）。

`--json` 形状：`{ devices }` / `Device` / `TestConnectionResult` / `{ ok, action, id, hold? }`（connect） / `DeviceFolderLayout`。

## `vibeterm share`

子命令：`create|ls|show|password|revoke|rm|log|settings|origins`。`create` 目标为 `[<node>/]<device>:<window>`，窗口用 tmux id（`@1`）、序号或名字；也可用 `--window-id @N`。网关只按窗口 `@id` 匹配且需要热 snapshot，所以 `create` 会先 `openDeviceSession`（连设备、等会话树），再用 `@vibeterm/ws-client/canonical-tree` 的 `resolveWindow` 收成 `@id`，socket 一直开到 `POST /api/share` 返回。未给 `--origin` 时打 `GET /api/share/origins`，按 GUI 规则取 `recommended`（须在候选里）否则第一个候选，并在 stderr 打印所用地址。口令可选：省略则与 GUI 一样 `generateSharePassword()`；也可 `--password-stdin` / `--password-file` / `@file` / `VIBETERM_SHARE_PASSWORD` / TTY；`--password` 仍可用但会打 stderr 警告。`rm` 非 TTY 必须 `--yes`。`settings set` 先校验旗标 / `--body`，再 GET 当前四字段，旗标覆盖、`--body` 最后覆盖后 PUT 全量：`--record-logs on|off`、`--retention-days`（0–3650）、`--log-max-mb`（1–1024，乘 1 MiB 写成 `logMaxBytes`）、`--origin auto|<url>`（`auto` → `null`）。无旗标且无 `--body` 报用法错误、不打 GET。分享口令 API 不能清空，只有改口令；`password --end-sessions` 在 POST 新口令的同时踢掉在线观众。日志 `--json` 原样给出网关分页（`data` 已是 base64）。

`--json` 形状：`{ share, password }` / `{ active, history }` / `ShareRecord` / `ShareLogPage` / `ShareSettings` / `ShareOriginsResponse`。

## `vibeterm watch`

`rules ls|show|add|edit|rm|state` 对齐 `packages/api-client/src/watch.ts`。`ls` 必须 `--device` 与 `--pane`。`add` / `edit` 的 `--extract-group` / `--confirm-with-llm` / `--summarize-with-llm` / `--provider-id` / `--model-id` 写入请求体（空串 → `null`；清空 provider 且未给 model 时一并清 model），只提交给出的字段。`state <id> on|off` 是 `PATCH {enabled}`；不带 on/off 则 `GET …/state`。`assist-regex "<description>"` 走 `POST /api/watch/assist-regex`。

`--json` 形状：`{ rules }` / `{ rule, state }` / `WatchRuleStateResponse` / `AssistRegexResponse`。

## `vibeterm agent`

HTTP 形状对齐 `packages/api-client/src/agent.ts` 与网关 `/api/agent/**`。`--node` 走全局 `ctx.targetNodeId()`（会话存在哪台网关就打哪台），**不**写进 create body 的 `nodeId`（那会被当成远端 pane 去签 grant）。

| 子命令 | HTTP |
|---|---|
| `ls` | `GET /api/agent/sessions` |
| `show <id>` | `GET /api/agent/sessions/:id` + `GET …/messages` |
| `new --device --pane [--provider --model --write-mode] [--title] [--origin-title]` | `POST /api/agent/sessions`（`--origin-title` → `originPaneTitle`）；`--title` 再 `PATCH {title}`（创建体没有 title） |
| `rm <id> [--yes]` | `DELETE /api/agent/sessions/:id` |
| `rename <id> <title>` | `PATCH {title}` |
| `send <id> [--stdin] "<text>"` | `POST …/messages {text}` |
| `steer <id> "<text>"` | `POST …/queue {text, steer:true}` |
| `queue ls <session>` | `GET …/queue` |
| `queue edit <session> <item> [--stdin] "<text>"` | `PATCH /api/agent/queue/:item {text}` |
| `queue rm <session> <item>` | `DELETE /api/agent/queue/:item` |
| `stop <id>` | `POST …/stop` |
| `confirm <id> approve\|deny [--reason]` | `POST /api/agent/confirmations/:id/decide`；409 → `{result:"conflict"}` |
| `confirmations ls <session>` | `GET /api/agent/sessions/:id/confirmations` |
| `model <id> --provider --model` | `PATCH {providerId, modelId}` |
| `set <id> --write-mode confirm\|auto` / `--allow-control-chars on\|off` / `--pane %N` | `PATCH {writeMode}` / `{allowControlChars}` / `{paneId}` |

`new` 未给 `--write-mode` 时默认 `confirm`。`queue edit|rm` 的 session 仅作定位，请求只按 item id。`--json`：`{ sessions }` / `{ session, messages }` / `{ session }` / `{ message\|queued }` / `{ queued }`。

## `vibeterm settings`

dispatcher 在 `commands/settings.ts`，主题拆到 `settings-http.ts` / `settings-site.ts` / `settings-local.ts` / `settings-llm.ts` / `settings-shortcuts.ts` / `settings-security.ts` / `settings-messaging.ts`；改密 / TOTP / 删 passkey 的签名在 `core/account-security.ts`；TLS / tunnel Access / LLM 请求体在 `core/settings-tls-body.ts` 与 `core/settings-body.ts`。

`site get|set <key> <value>`、`shortcuts get|set|add|rm|order|use-icons`、`restart`、`notifications mesh get|set`（set 先签 `notification-sink` 再 PUT）、`webhooks ls|add|rm|edit`（无 PATCH，edit 先拼并校验新 body 再 DELETE+POST）、`llm providers ls|add|edit|rm|refresh-models|enable|disable|models`、`llm get|set|default|search set`、`domain-access get|set`、`tls get|set|renew|ca`（`--mode/--sans/--port/…` 或 `--body`）、`tunnel status|<action>`（含 `set_access_mode` / `set_access_credentials` / `configure_access`）、`system info|addresses|update-check|upgrade status|start`、`local status|leave|direct`、`passwd [--full-reset]`、`totp enable|disable`、`passkey ls|rm`、`local-auth bootstrap|set`、`telegram …`、`weixin …`。webhook `--secret` 与 LLM `--api-key` 优先 `--*-stdin` / `--*-file` / `@file` / `VIBETERM_WEBHOOK_SECRET` / `VIBETERM_LLM_API_KEY`；写在 argv 上会打 stderr 警告。`tls set` 在 `mode: none` 或 `trustProxy: true`、以及 `tunnel … --trust-proxy on` 时必须 `--yes`（局域网可伪造 `X-Forwarded-*`）。`tunnel remove|remove_access|clear_access_credentials` 与 `totp disable` 非 TTY 也必须 `--yes`。`local leave` 先尽力自吊销（`revoke-node`，需 `VIBETERM_PASSWORD`）；没有密码时必须 `--skip-self-revoke`。`local direct` 尊重 `--node`（打 `/n/<id>/api/local/direct`）；`status` / `leave` 仍 entry-only。TLS / tunnel 只打 entry 自身。改密 / TOTP / 删 passkey 只走根钥签名（CLI 无 WebAuthn）；注册 passkey 提示去 GUI。复杂体一律 `--body <json>|@file`。

`--json` 打印网关响应原样。

## `vibeterm tmux`

子命令：`ls|windows|panes|new-window|kill-window|rename-window|split|kill-pane|select|focus|resize|rename-pane|move|break|order-windows|order-panes`。`ls`…`rename-pane` 的第一个位置参数一律是目标 `[<node>/]<device>[:<window>[.<pane>]]`。`move` / `break` / `order-*` 在 `commands/tmux-layout.ts`：`move <src> <dst> [--position left|right|top|bottom]`（缺省 `right`）走 WS `move-pane`；第二参数可以是完整目标或同一设备上的 location 简写（`parsePeerTarget`）。`break <pane>` 走 `break-pane`。`order-windows <device> --ids` / `order-panes <window> --ids` 走 `reorder-windows` / `reorder-panes`，id 列表按 GUI `reorderById` 当前缀匹配。`move` 落地谓词是源 pane 的 `windowId` / `index` / 宽高任一变化；`break` 是会话树出现新 window id。

每条子命令的骨架都一样（`core/tmux-ops.ts` 的 `openDeviceSession` + `applyTmuxChange`）：

1. `ctx.resolver` 解析 node 与 device（REST）；
2. `ctx.openSocket(nodeId)` 建 WS，HELLO 完成后由 `core/pane-session.ts` 的 `DeviceSession` 发 `DEVICE_CONNECT`，等 `device-connected` 与第一份 `metadata-snapshot`；
3. 在会话树上定位窗口 / pane（`core/term-target.ts`，见下）；
4. 发一条 tmux 控制命令（`@vibeterm/ws-client` 的 `GatewayTransportCommand`，wire kind 0x0201–0x0215）；
5. 等 `metadata-patch` 把这次改动折进树里（谓词由子命令给，如「新窗口 id 出现」「pane id 消失」「`active` 翻到目标上」），超时按 `--timeout` 报网络错误（退出码 5）；
6. 打印结果并关 socket。

`resize` 是唯一例外：tmux 会按窗口布局夹取尺寸，请求值拿不到属正常现象——等不到尺寸变化时只在 stderr 警告并打印当前尺寸，退出码仍是 0。

两处容易写错的落地谓词：

- **改名**必须用与网关同一套归一（`core/tmux-ops.ts` 的 `normalizeCustomName`：`trim()` + 截 64，空串即清除），否则用户带空格或超长的名字会永远等不到「改好了」。参见 `apps/gateway/src/ws/tmux-command-handlers.ts` 的 `renameWindow` / `renamePane`。
- **整个 tmux 会话被销毁**（关掉最后一个窗口）时元数据补丁里的 session 是 `null`，树等待会被 `DeviceSession` 用 `NotFoundError` 唤醒。`awaitTreeChange` 拿到它之后会再用一棵空树跑一次谓词：`kill-window` / `kill-pane` 这类「东西消失了」的谓词因此照样成立并正常返回，其余情况原样抛出（退出码 4），不会一路等到 `--timeout`。

元数据折叠**不在 CLI 里重做**：`CanonicalStateClient` 已经把 `SourceMetadataSnapshot` / `SourceMetadataPatch` 折成 `StateSnapshotPayload`，`DeviceSession` 只留最新一份。定位窗口 / pane 一律用 `@vibeterm/ws-client/canonical-tree` 的纯函数 `resolveWindow` / `resolvePane` / `activeWindow` / `activePane`，优先级与 tmux 一致：`@id`/`%id` > `窗口.pane 序号` > 序号 > 名字。`core/term-target.ts` 只决定「先按窗口解释还是先按 pane 解释」——目标里 `:` 之后没有 `.` 的写的是窗口，有 `.` 的写的是 pane，两条路都走不通时互相回落（窗口名本身含 `.` 的情况因此仍可达）。名字撞车报用法错误并列出候选。

`--json`：`ls` 给 `TmuxSession[]`（本设备一条），`windows` 给 `TmuxWindow[]`，`panes` 给 `TmuxPane[]`，其余给 `{ok:true, action, window|pane|id}`。

## `vibeterm term`

四条子命令共用同一条数据面（`commands/term.ts` 的 `PaneStream`）：订阅 pane（`SetPaneSubscriptions`）→ `RequestScreen` 建基线 → 收 `PaneData`。

**订阅之后必须取一次画面**：网关在 `SubscriptionApplied` 之后会把还没有终端游标的 pane 标成 blocked 并发一次 `rebase-required`，`ScreenCommit` 建立游标后 `PaneData` 才开始放行。少了这一步，`send` / `capture` / `run` 都会一个字节也收不到。

同一条链路上还有三件事不能省（否则「收不到字节」会被误判成「pane 很安静」）：

- `onRebase` → 重发一次 `RequestScreen`。`SubscriptionApplied` 的拒绝、`SourceGap`、pane epoch 变化都会重新拦住这个 pane，不重取画面就再也收不到 `PaneData`。
- `onDetached` / 会话树变成 null → 让所有在等的东西**立刻失败**（退出码 5 / 4），并结束采集。socket 断了不是静默。
- 画面等不到就抛 `NetworkError`（退出码 5），不能吞成 `null` 继续跑——那样 `run` 会打印空输出并退出 0。所有等待都用 `--timeout`，没有第二套写死的时限。

### `attach`

`core/term-attach.ts`。要求 stdin 与 stdout 都是 TTY，否则退出码 2 并指向 `term run|send|capture`。流程：连设备 → 定位 pane → **这时才进 raw 模式** → 订阅 pane → `RequestScreen` → 清屏后写截屏字节 → `PaneData` 直接写 TTY（网关已经摘掉 BEL 与它自己处理的那几类 OSC）→ 键盘字节按 UTF-8 发 `TerminalInput` → `SIGWINCH` 与首次挂接各发一次 `ResizePaneV11`（用本地 `process.stdout.columns/rows`）。`rebase-required`（pane epoch 变化、`SourceGap`）就重取一次画面。socket 断一次会自动重连一次：新 socket 上的 canonical 客户端没有旧游标，因此是重新拉一整屏，不是断点续传；再断即退出码 5。

终端复位这条路必须万无一失，为此有三条约束：

- **raw 模式只在会话建好之后进**。连接阶段留在 cooked 模式，Ctrl-C 仍然是真的 SIGINT（连接被中止，终端根本没被动过），不会被我们的 `SIGINT` 处理器吞掉。
- `LocalTerminal.start()` 同时挂 `process.on('exit')` 与 SIGTERM / SIGHUP；`stop()` 幂等（复位串只写一次）并摘掉自己装的每一个监听器。少了这三条，被 `kill` 或异常退出的进程会把用户的 shell 留在 raw 模式里。
- 所有事件回调都过 `guard()`：回调里抛出的异常会把会话按 `failed` 收尾并原样抛给 `run()`，而不是静悄悄丢掉、让 attach 一直挂着。`finish()` 在等待还没挂上时（连接中、重连间隙）把结果记进 `pendingOutcome`，下一次 `attachOnce` 立刻兑现——否则连接期间按的 `~.` 会石沉大海。
- `attachOnce` 的 finally 会清掉历史定时器与 `pendingScreen`，`paint()` 在会话已收尾时直接返回：`--history` 的 3 s 兜底定时器不能在 detach 之后往复位好的 shell 里泼一屏陈旧画面。

转义键是 ssh 那一套，**行首**的 `~` 起头（`core/term-escape.ts`，纯状态机 + 单测）：

| 键 | 动作 |
| --- | --- |
| `~.` | detach（pane 继续跑），退出码 0 |
| `~w` | 列出本会话的窗口 |
| `~<n>~` | 把 CLI 显示的窗口切到序号 n（**不动** tmux 自己的活动窗口，那是 `vibeterm tmux select`）。数字可以多位；`~` 或回车是终止符，跟别的字符时先切窗口再把那个字符照常发下去 |
| `~?` | 帮助 |
| `~~` | 发一个字面 `~` |

`--detach-key` 收两个字符（`none` 关掉整套转义）。raw 模式下 Ctrl-C 是字节 0x03 会原样发给 pane；额外挂的 `SIGINT` 处理也只是再发一次 0x03，不会退出。

### `send` / `capture` / `run`（面向脚本与 AI agent）

- `send`：按键名表在 `core/term-keys.ts`（`Enter`、`C-c`、`M-x`、`S-Up`、`F5`…，认不出的词按字面发；`--literal` 全按字面）。发完等最多 1.5 s 的回显作为「确实进了 pane」的信号，等不到也照样退出 0（很多程序不回显）。
- `capture`：默认把截屏原始字节写 stdout（颜色保留），`--strip-ansi` 洗成纯文本，`--history <bytes>` 另取一页回滚，`--wait-idle <ms>` 先等 pane 静默再取一次画面。
- `run`：把命令 + Enter 打进 pane，收字节直到静默 `--idle`（默认 800 ms）或 `--timeout`。

`run` 的完成判定：**网关会吞掉 OSC 133**（`apps/gateway/src/tmux-client/pane-stream/osc-handlers.ts` 的 `HANDLED_OSC_KINDS` 命中即整段不转发），不可见的 shell 集成标记根本到不了客户端。所以 `--marker` 用的是一个**肉眼可见**的哨兵 `(echo __VT_DONE_<nonce>_$?)`，并且分两阶段：

1. 打进命令，等输出静默 `--idle`（或撞上 `--timeout`）；
2. 静默之后**才**把哨兵作为**独立的一行**打进去，然后只等它的结果行 `__VT_DONE_<nonce>_<数字>`（不再按静默收尾，`sleep 30` 这种要等到 shell 真读到那一行）。

两条都是踩出来的：拼成 `cmd; echo …` 会被命令里的 `#`、未闭合的 heredoc 或结尾的 `&` 破坏；在命令还占着 tty 时提前打，那一行会被 tty 驱动当预输入**即时回显**，糊进输出中间（1.5 MiB 的输出因此只剩 500 字节）。`find()` 只认数字形态，回显里的字面 `$?` 不会误命中。这条路只在 POSIX shell 上成立（fish 用 `$status`），而且哨兵行躺在 tty 缓冲里，会被主动读 stdin 的命令吃掉——那类命令别用 `run`。

`run` 的输出剥离是 best-effort（`core/term-collect.ts` 的 `formatRunOutput`）：

- 第一个 LF 之前那段**只在确实是回显时**才丢。`looksEchoed()` 按「压掉空白后是命令的子序列」判定，既能认出被窄 pane 折行重画打散的回显（`li` ⊂ `echohello-cli`），又不会把 `stty -echo` 下命令自己的第一行输出吃掉。
- 有哨兵就切到**结果行**为止，并把之前那些回显的哨兵命令用 `scrub()` 从行内抹掉（它可能糊在某个输出行中间）。
- 结尾再丢一行「看着像提示符」的未换行残留。

pane 是共享终端，别人同时在里面敲字会混进来——这一点必须让调用方知道。

采集有 8 MiB 上限（`DEFAULT_COLLECT_MAX_BYTES`）：`yes` 这类命令一秒就能刷爆内存，收满即停并把 `reason` 标成 `truncated`。

退出码：pane 里命令的退出码只在 `--json` 的 `exitCode`（没有 `--marker` 时为 `null`），**不**决定 CLI 的退出码；但**输出没收全**（`reason` 为 `timeout` 或 `truncated`）时 CLI 退出 1，除非显式给 `--allow-timeout`——半截输出被当成全部是最危险的失败模式。

### VT 洗白的边界（`core/vt-text.ts`）

不是终端仿真器，只维护一张「当前行 + 列」的行画布：CR、退格、TAB（每 8 列一个制表位）、EL（`ESC[K`）、ED（`ESC[2J`）、CUF/CUB、CHA（`ESC[nG` 移到绝对列）会真的作用在行上——这样 zsh / fish 的行编辑重画才能还原成一行。列宽按一张小表算：东亚宽字符与常见 emoji 占两列（续格写空串，join 后不多字符），组合记号占零列挂在前一格上。**不实现**绝对行定位（CUP）、滚动区与备用屏，所以整屏重绘型 TUI（vim、top）洗出来仍然是一堆片段；读它们请用 `term capture`（网关截屏本来就是 `capture-pane` 的逐行文本）。SGR / OSC / DCS 一律丢弃，裸 LF 当 CRLF（截屏载荷用裸 LF 分行）。

### 一条硬约束：输入只能是 UTF-8

wire 上的 `TerminalInput.data` 是 UTF-8 字节，`GatewayTransportCommand` 的输入命令也只收字符串。stdin 的字节用流式 `TextDecoder` 解码（多字节字符被读取边界切开不会坏），但**非 UTF-8 的任意字节序列发不出去**——`--hex` 因此要求解码结果是合法 UTF-8。浏览器端同样如此（xterm 给的也是字符串），不是 CLI 的额外限制。
