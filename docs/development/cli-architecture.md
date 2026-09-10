# 客户端 CLI 架构（packages/cli）

`vibeterm login|api|term|…` 这些**客户端命令**的模块契约，面向要新增命令组的开发者。命令组作者读完本文即可动手；只想用 CLI 的看 `vibeterm --help` 与各组的 `--help`。

## 背景

`packages/app`（发布名 `vibeterm-cli`）里原有的命令都是**本机运维**命令：`init` / `upgrade` / `hub …` / `relay …`，它们直接读本机安装目录、库与主密钥。`packages/cli`（`@vibeterm/cli`）是另一类东西——**只经 HTTP / WebSocket 访问网关的客户端**，安全边界与网页端逐条对齐，因此可以指向任意 entry，也可以在没有本机安装的机器上用。

两者的分界：

| | packages/app（原有） | packages/cli（本文） |
| --- | --- | --- |
| 命令 | `init` `doctor` `upgrade` `uninstall` `hub` `relay` `mesh` `tls` `enroll` `direct` | `login` `logout` `whoami` `api`，以及预留的 `nodes` `devices` `tmux` `term` `files` `cp` `port` `share` `watch` `settings` |
| 依赖 | 本机安装目录、SQLite、主密钥；`hub`/`relay` 那组还要 bun 运行时 | 只有 `fetch` 与 WebSocket |
| 运行时 | Node（`init` 等）+ bun（`cli-auth-entry.ts`） | Node ≥ 20（bundle 也能在 bun 下跑） |
| 权限 | 本机 root 级配置 | 与一个浏览器会话完全等价 |

## 安全边界（不可退让）

1. 登录流程与浏览器逐步一致：`GET /api/auth/mode` → `POST /api/auth/challenge` → argon2id 派生根种子 → 生成临时会话密钥对 → 签 `Delegation(method='root')` + `Login` → `POST /api/auth/login`（可带 TOTP）。服务端没有为「本机 CLI」新开任何信任面；`client-source.ts` 的回环 / 内网通行密钥豁免照旧生效。
2. **CLI 从不使用本机节点的 mesh 身份、数据库、主密钥或 `app.env` 里的密钥**去访问别的 node。访问别的 node 一律经 entry 的 `/n/<nodeId>/…` 转发，并携带**那个 node 自己的**会话 cookie（`vibeterm_s_<nodeId>`），该 cookie 由 `/n/<id>/api/auth/login` 换来——与网页端的 `loginToNode` 完全相同。
3. 根种子与根钥私钥只在内存里活到 delegation 签完，随即清零（`core/auth.ts` 的 `buildSessionMaterial`）。**落盘的只有会话 sid 与到期时刻**，密码、种子、会话私钥一概不写盘。
4. 两步验证由 TOTP 满足（`--totp` / `VIBETERM_TOTP` / TTY 提示）。服务端 `/api/auth/mode.secondFactorPolicy` 为 `either` 时，一个有效 TOTP 码即可通过通行密钥这一关；为 `passkey`（账号没开 TOTP、但本 origin 注册了通行密钥）时 CLI 做不了断言，退出码 3 并说明补救办法。CLI 不实现 WebAuthn。

## 目录与模块

```
packages/cli/src/
  main.ts                入口：找命令、拆全局旗标、建 ctx、翻译退出码
  registry.ts            命令注册表（含预留组）
  version.ts             自报版本（网关的 canonical v1.1 版本门要用）
  commands/
    types.ts             Command 契约
    login.ts logout.ts whoami.ts api.ts
  core/
    args.ts              轻量参数解析 + 全局旗标拆分
    config.ts            配置目录与默认 entry 的优先级
    session-store.ts     session.json（0600）
    http.ts              cookie 罐、Origin、会话续期、JSON/NDJSON/字节、错误翻译
    auth.ts              登录流程（浏览器版去掉 WebAuthn）
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

2. 在 `src/registry.ts` 把它从 `RESERVED_SPECS` 挪进 `IMPLEMENTED_COMMANDS`。
3. `packages/app/src/lib/client-cli.ts` 的 `CLIENT_CLI_COMMANDS` 已经把十四个组全部登记好了，**新增组名时两处都要改**——`registry.test.ts` 会比对两份名单。

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

- `ctx.http.json(nodeId, method, path, body?)`：非 2xx 直接抛（401/403 → 退出码 3 并带 `vibeterm login --node <id>` 提示，404 → 4，其余 → 1，传输失败 → 5）。
- `ctx.http.fetch(nodeId, path, init)`：不对状态码做判断，自己处理时用它；`ctx.http.assertOk()` 补上统一翻译。
- `ctx.http.ndjson(nodeId, path)`：逐行 yield 已解析对象，默认不设超时（长流用）。
- `ctx.http.bytes(nodeId, path)`：二进制。`RequestOptions.timeoutMs` 可按请求覆盖 `--timeout`，`null` 表示不设。
- `ctx.resolver.resolveNode(ref)`：接受 node id、node 名字、`self`/`local`/`entry`；重名报用法错误，找不到报 4。
- `ctx.resolver.resolveDevice(nodeId, ref)`：device id 或名字。
- `parseTarget(input)`：纯函数，拆 `[<node>/]<device>[:<window>[.<pane>]]`。node 与 device 以**第一个** `/` 分界，device 与位置以**第一个** `:` 分界，window 与 pane 以**最后一个** `.` 分界；同时保留 `location` 原文，窗口名本身含 `.` 时可整段回退。window/pane 到会话树的定位由 term 命令组自己做。
- `ctx.out`：`data(value)`（`--json` 时紧凑一行，否则缩进两格）、`table(rows, columns)`、`line()`、`raw(bytes)`；`info()` / `warn()` 走 stderr，`--quiet` 或 `--json` 时静默。**stdout 只放命令结果**，`main.ts` 已经把库里的 `console.log`（`@vibeterm/ws-client` 的连接状态日志）改道到 stderr。

### WebSocket

`ctx.openSocket(nodeId)` 建一条到目标 node 的 Gateway WS，等 HELLO 协商完成后返回 `{ connection, cid(), close() }`。要点：

- npm `ws` 被 `core/ws.ts` 适配成 `@vibeterm/ws-client` 的 `WebSocketLike`，经 `socketFactory` / `wsUrlFactory` 注入，**没有改动 `@vibeterm/ws-client`**——那个包是 DOM 取向的，一律靠注入而不是打补丁。
- URL 为 `ws(s)://<entry>/ws?cid=…` 或 `…/n/<id>/ws?cid=…`，每建一条 socket 换一个新 nonce（合约要求）；浏览器设不了请求头，CLI 则把该 node 的会话 cookie 放进握手头。
- 网关按 `clientVersion` 做 canonical v1.1 版本门且 fail-closed，所以 `main.ts` 启动时先 `setDefaultClientVersion(cliVersion())`。`version.ts` 依次尝试构建期注入、`VIBETERM_CLI_VERSION`、同级 / 上级 `package.json`；报不出版本会被网关用 1002 关掉。
- 会话失效时网关用 **4401** 关闭，适配层把它翻成退出码 3 并指路 `vibeterm login`。
- 首连不自动重连（`maxReconnectAttempts: 0`），要不要重连由各命令自己决定。

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

## 注意事项

- 单测不打真实 endpoint。登录流程用 `core/test-fakes.ts` 的假网关（用 `@vibeterm/shared/auth` 真造一个用户，服务端侧真验签名与 TOTP），HTTP 层用假 `fetch`。要打真实网关的用例按 `live-integration-tests.md` 的约定单独放。
- `--json` 的调用方直接管道 stdout，所以往 stdout 写任何非结果内容都是 bug。
- 新增全局旗标要同时改 `core/args.ts` 的 `GLOBAL_FLAGS`、`main.ts` 的帮助文本与 `core/context.ts` 的 `CliGlobals`。
