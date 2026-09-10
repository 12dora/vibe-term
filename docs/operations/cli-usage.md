# vibeterm 命令行使用手册

用 `vibeterm` 在终端里做网页端能做的事：登录、接进任意节点上的某个终端窗格（像 ssh 一样）、以及让 AI coding agent 非交互地在别的机器上跑命令、看画面。面向使用者；想加命令组的看[客户端 CLI 架构](../development/cli-architecture.md)。

## 它是什么，不是什么

`vibeterm login|whoami|api|nodes|devices|tmux|term|files|cp|port|share|watch|settings` 这些**客户端命令**只经 HTTP / WebSocket 访问网关，权限与一个浏览器会话完全等价，因此可以指向任意 entry，也可以装在没有 VibeTerm 服务的机器上。

`vibeterm init|doctor|upgrade|uninstall|hub|relay|mesh|tls|enroll|direct` 是**本机运维**命令，直接读本机安装目录、库与主密钥，只能在装了服务的机器上跑。两类命令共用一个二进制，但边界完全不同。

## 登录

```bash
vibeterm login --entry https://vt.example.com --user admin
```

- 密码交互输入；非交互场景用 `VIBETERM_PASSWORD`。开了两步验证就再给 `--totp <6 位码>` 或 `VIBETERM_TOTP`。
- 默认把 entry 后面**每个节点**都登一遍（`--all-nodes`），之后访问任意节点都不用再登；只想登一台就 `--node <id|名字>`。
- 登录流程与网页端逐步一致（argon2id 派生根种子 → 临时会话密钥对 → 签名委托）。密码、根种子、会话私钥**都不落盘**，落盘的只有会话 sid 与到期时刻，文件是 `~/.config/vibeterm/session.json`（0600）。
- 只在本 origin 注册了通行密钥、又没开 TOTP 的账号，CLI 登不上（不实现 WebAuthn），会退出码 3 并说明补救办法：在网页端开 TOTP。

```bash
vibeterm whoami           # 当前 entry、账号与各节点会话状态
vibeterm logout           # 对每个已登录节点各撤销一次会话，并删掉本地记录
```

`logout` 撤销的是**服务端**签发的会话，和在网页端退出登录等价：本机 session.json 被删的同时，别处用同一账号拿到的会话也一并失效。丢了笔记本就在任意一台机器上 `vibeterm logout`。

默认 entry 的优先级：`--entry` > `$VIBETERM_ENTRY` > 上次用过的 entry > 本机安装的 `VIBETERM_BASE_URL` > `http://127.0.0.1:9883`。

## 目标语法

几乎所有和终端相关的命令都收同一种目标：

```
[<node>/]<device>[:<window>[.<pane>]]
```

- `<node>`：节点 id 或名字；不写就是 entry 自己（也可以用全局 `--node`）。`self` / `local` / `entry` 都表示 entry 自己。
- `<device>`：设备 id 或名字（`vibeterm devices ls` 里的那些）。
- `<window>`：tmux 窗口 id（`@1`）、序号（`1`）或名字；不写取活动窗口。
- `<pane>`：窗格 id（`%7`）、窗口内序号或名字；不写取该窗口的活动窗格。

```bash
vibeterm tmux ls office/dev-box              # 那台机器上的会话树
vibeterm term attach office/dev-box:build.1  # build 窗口的 1 号窗格
vibeterm term attach dev-box:%7              # 直接按 tmux 窗格 id
```

名字撞车时会列出候选并要求改用 id。

## 看 tmux 结构

```bash
vibeterm tmux ls <target>                    # session → window → pane 三层
vibeterm tmux windows <target>
vibeterm tmux panes <target> [--all]
```

改结构（每条都会等改动真的落到会话树上才返回，超时看 `--timeout`）：

```bash
vibeterm tmux new-window <target> --name build
vibeterm tmux rename-window <target> deploy
vibeterm tmux kill-window <target>
vibeterm tmux split <target> --horizontal    # 不给方向就是上下分屏
vibeterm tmux kill-pane <target>
vibeterm tmux select <target>                # 切 tmux 的活动窗口
vibeterm tmux focus <target>                 # 切活动窗格
vibeterm tmux resize <target> 120x40
vibeterm tmux rename-pane <target> worker
```

`resize` 请求的尺寸会被 tmux 按窗口布局夹取，拿不到原值是正常的，命令会打印实际尺寸。

## 接进一个终端（交互）

```bash
vibeterm term attach office/dev-box
vibeterm term attach office/dev-box:build.1 --history 65536
```

接上之后就是一个普通终端：键盘直接进远端窗格，窗口大小变化会同步过去，断线会自动重连一次（重连后重新拉一整屏，不是断点续传）。`--history <字节>` 会在首屏之前先补一页回滚，方便直接往上翻。

**行首**的 `~` 是转义键（和 ssh 一样）：

| 键 | 作用 |
| --- | --- |
| `~.` | 断开（远端进程继续跑） |
| `~w` | 列出本会话的窗口 |
| `~<n>~` | 把显示切到 n 号窗口（只影响本次 attach，不动 tmux 的活动窗口）。序号可以多位（`~12~`），结尾的 `~` 或回车都算终止符 |
| `~?` | 帮助 |
| `~~` | 输入一个字面 `~` |

`--detach-key '^q'` 可以换成别的两个字符，`--detach-key none` 关掉整套转义。Ctrl-C 会原样发给远端程序，不会退出 attach。

退出码：`0` 正常断开，`2` 没有 TTY（在脚本里请改用下面几条命令），`3` 需要重新登录，`5` 网络断了。

## 给 AI agent 用（非交互）

跑在一台机器上的 coding agent（Claude Code 之类）可以用下面三条命令去调试别的节点。全部支持 `--json`，stdout 只有结果，提示都走 stderr。

### 跑一条命令并拿到输出

```bash
vibeterm term run office/dev-box "bun test" --marker --timeout 120000
vibeterm term run office/dev-box "systemctl status vibeterm" --idle 1500 --json
```

- 把命令打进窗格并回车，然后收集输出，直到**静默** `--idle` 毫秒（默认 800）或到 `--timeout`。命令必须是**一行**（多行请用 `term send --stdin`）。
- `--marker`：等输出安静下来之后，再单独打一行 `(echo __VT_DONE_<随机串>_$?)`，据此确认「真跑完了」并拿到退出码（`--json` 的 `exitCode`）。命令还在跑（比如 `sleep 30`）时会一直等到它结束或 `--timeout`。只对 POSIX shell（bash/zsh/sh）成立，fish 用的是 `$status`；主动读 stdin 的命令（`cat`、交互式安装器）会把这一行吃掉，那类命令别用 `run`。裸的 `exit N` 会结束窗格里的 shell，哨兵就没机会跑——请写成 `(exit N)` 或 `sh -c 'exit N'`。
- 输出上限 8 MiB，收满即停并把 `reason` 标成 `truncated`。
- `--json` 形状：`{"pane","command","reason":"idle|timeout|done|truncated","exitCode":0|null,"output":"…","raw":"<base64 原始字节>"}`。
- **退出码**：远端命令自己的成败看 `exitCode`，不影响 CLI 的退出码；但**输出没收全**（`reason` 是 `timeout` 或 `truncated`）时 CLI 退出 **1**，除非显式加 `--allow-timeout`。别把半截输出当成全部。

**这是尽力而为的**：窗格是一个共享的交互终端，不是一个干净的 `ssh host cmd`。输出里可能混进提示符、别人同时敲进去的字、或者被终端宽度折行打断的回显。要可靠的完成判定就加 `--marker`；长跑的流式命令（`tail -f`、`npm run dev`）不要用 `run`，它会一直等到超时——改用 `send` + `capture`。

### 看当前画面

```bash
vibeterm term capture office/dev-box --strip-ansi
vibeterm term capture office/dev-box --wait-idle 500 --history 32768 --json
```

- 默认把画面的原始字节写 stdout（颜色保留）；`--strip-ansi` 洗成纯文本；`--raw` 是原始字节且不补结尾换行。
- `--wait-idle <ms>`：先等窗格安静下来再取，适合「刚发了个按键，等界面画完」。
- `--history <字节>`：额外取一页回滚。
- `--json` 形状：`{"pane","paneEpoch","seq","screen":"<base64>","text":"…"}`，给了 `--history` 再多一个 `"history":{"screen","text"}`。
- 洗白只是个简化实现（会执行 CR / 退格 / 制表位 / 清行 / 绝对列，不执行绝对**行**定位），全屏 TUI（vim、top）的纯文本结果会有出入；这种情况直接看 `screen` 的原始字节更可靠。

### 发按键

```bash
vibeterm term send office/dev-box "npm run dev" Enter
vibeterm term send office/dev-box C-c
vibeterm term send office/dev-box --hex 1b5b41            # Up
echo -n "$PATCH" | vibeterm term send office/dev-box --stdin
```

按键名与 `tmux send-keys` 一致：`Enter` `Escape` `Tab` `Space` `BSpace` `Up`/`Down`/`Left`/`Right` `Home` `End` `PageUp`/`PageDown` `F1`–`F12`，加 `C-` / `M-` / `S-` 前缀。认不出的词按字面文本发；`--literal` 则每个词都按字面发。

发进去的内容必须是合法 UTF-8（wire 上就是 UTF-8 文本），`--hex` 的字节也一样。

### 一个典型排障回合

```bash
vibeterm tmux ls prod-1/app                                  # 看有哪些窗口
vibeterm term run prod-1/app:logs "journalctl -u vibeterm -n 50" --marker --json
vibeterm term send prod-1/app:logs "tail -f /var/log/app.log" Enter
sleep 5
vibeterm term capture prod-1/app:logs --strip-ansi
vibeterm term send prod-1/app:logs C-c
```

第 2 行用了 `--marker`：它会在输出安静之后单独补一行哨兵，因此既能确认命令真的跑完，也能拿到退出码；第 3 行是长跑的流式命令，只能 `send` + `capture`，不能 `run`。

## 文件拷贝

```bash
vibeterm cp ./patch.diff office:home/tmp/patch.diff
vibeterm cp office:home/app/dist ./dist -r
```

节点侧路径是**相对该文件根**的：`[<node>:]<root>/<path>`。前导 `/` 会被当成文件系统绝对路径并被 `outside_roots` 拒绝，不要写成 `office:/home/u/file`。本地路径才用 `./`、`../`、`~` 或操作系统绝对路径。

## 端口映射

```bash
vibeterm port map 8080 office:127.0.0.1:8080     # 把 office 上的 8080 映到本机
```

监听节点和目标节点必须是两台不同的机器（含 `self` 与它自己的 mesh id）。网关没有同节点短路，self→self 的映射会显示 `listening`，但连上去每条都 `bad_signature`。

## 终端分享

```bash
vibeterm share create laptop:build                 # 窗口名；也可 laptop:@1 或 --window-id @1
vibeterm share create self/laptop:smoke --origin https://vt.example.com
vibeterm share rm <id> --yes
```

`create` 会先连上设备、等会话树变热，再把窗口名/序号收成 `@id`（冷启动直接 POST 会 404）。未给 `--origin` 时用 `GET /api/share/origins` 的推荐地址（须在候选里）或第一个候选，并在 stderr 打印实际使用的 origin。口令可省略（与网页端一样自动生成），也可 `--password-stdin` / `VIBETERM_SHARE_PASSWORD`。非 TTY 下 `rm` 必须 `--yes`。

## 安全说明

- **边界与网页端完全一致**。CLI 没有任何「本机特权」：它拿的是和浏览器一样的会话 cookie，能做的事一条不多。访问别的节点走 entry 的 `/n/<nodeId>/…` 转发并带**那个节点自己的**会话，和网页端一模一样；CLI 从不使用本机节点的 mesh 身份、数据库或主密钥去碰别的机器。
- **会话随时可撤销**。`vibeterm logout` 会让服务端撤销该账号的会话，等同于网页端退出登录。会话文件里只有 sid 与到期时刻，拿到它也只等于拿到一个浏览器会话；真要止血就 `logout`，必要时再在网页端改密码。
- **窗格是共享的**。`term send` / `term run` 打进去的字符和真人敲的没有区别，会被同一个窗格的其他观看者看到，也会进 shell 历史。别把口令、令牌当按键发；要传密钥用 `vibeterm cp`。
- **`term run` 会执行任意命令**。给 AI agent 用之前想清楚它能碰到哪些节点——权限就是那个账号的权限。需要收紧就为它单独建账号 / 单独的节点授权，而不是共用管理员会话。
- 非交互场景把密码放 `VIBETERM_PASSWORD`、TOTP 放 `VIBETERM_TOTP`，不要写进命令行参数（会进 shell 历史与进程列表）。

## 排障

| 现象 | 原因与处置 |
| --- | --- |
| 退出码 3 | 会话过期或没登录：`vibeterm login`（跨节点加 `--node`） |
| 退出码 4 | node / device / 窗口 / 窗格不存在：`vibeterm nodes ls`、`vibeterm devices ls`、`vibeterm tmux ls` 逐层确认 |
| 退出码 5 | 连不上、握手超时，或改动没在 `--timeout` 内落地 |
| `attach` 退出码 2 | 当前不是交互终端：脚本里请用 `term run|send|capture` |
| `run` 的输出里混着提示符 | 见上面的「尽力而为」说明，加 `--marker` |
| `run` 退出码 1、`reason` 是 timeout / truncated | 输出没收全：加大 `--timeout`、缩小输出，或明确接受半截结果时加 `--allow-timeout` |
| 版本太旧被 1002 关掉 | CLI 与网关都要 ≥ 1.1.23（canonical v1.1 版本门），升级两端 |

每条命令都有 `--help`，`--json` 的形状写在各自的用法里。没被包成命令组的接口一律可以用 `vibeterm api <METHOD> <path>` 直接打。
