# 终端 OSC 通知与 Claude Code 渠道

本文说明 VibeTerm 支持的终端通知序列（OSC 9 / 99 / 777 / 1337、BEL、tmux passthrough 解包）、Claude Code 各通知渠道的对应关系，以及 `TERM=xterm-ghostty` 注入让 `auto` 渠道自动生效的机制；面向用户与改动 `pane-stream-parser` 的开发者。

## 背景

Claude Code（CLI）在任务完成或需要注意时会向终端发送 OSC 通知序列。要在 tmux 内收到它们，需要解包 tmux passthrough、支持 kitty 的 OSC 99，并让 Claude Code 的 `auto` 渠道探测到合适的终端。

## 解析器支持（`apps/gateway/src/tmux-client/pane-stream-parser.ts`）

- **tmux passthrough 解包**：Claude Code 检测到自己运行在 tmux 内（`$TMUX` 存在）时，会把所有通知序列包成 tmux passthrough：`ESC Ptmux; <内层序列，ESC 翻倍> ESC \`。解析器解包 `ESC Ptmux;`（`ESC ESC` 还原为 `ESC` 后重新喂回状态机；非 `tmux;` 前缀的 DCS 保持原样透传；64KB 上限）。
- **OSC 99**（kitty 桌面通知协议）：解析 `i`/`d`/`p` 元数据，按 id 聚合 title/body 分片，完成时上报。`NotificationSource` 含 `osc99`（shared 类型、Borsh u8=4、gateway ws 白名单）。
- OSC body 中出现 `ESC + 非 ST` 字节时状态机回到 body 状态，payload 不错乱。

## Claude Code 渠道与 VibeTerm 的对应关系

Claude Code 各通知渠道发出的序列（在 tmux 内均经 passthrough 包装，VibeTerm 已能全部解包）：

| `preferredNotifChannel` | 序列 | VibeTerm 支持 |
| --- | --- | --- |
| `iterm2` / `iterm2_with_bell` | `OSC 9 ; <message> BEL` | ✅ |
| `ghostty` | `OSC 777 ; notify ; <title> ; <body> BEL` | ✅ |
| `kitty` | `OSC 99`（三段：title / body / focus，按 `i=<id>` 聚合） | ✅ |
| `terminal_bell` | 裸 `BEL` | ✅（走 bell 通知） |
| `auto`（默认） | 探测结果通常为 `ghostty` → `OSC 777` | ✅（依赖 `TERM=xterm-ghostty` 注入，见下节；注入失败时回退为不发通知） |

## auto 渠道的自动识别

Claude Code 默认 `preferredNotifChannel: auto` 时按终端探测决定渠道，其检测优先级（Claude Code 2.1.170）：

```js
if (process.env.TERM === "xterm-ghostty") return "ghostty";   // 优先于 TERM_PROGRAM
if (process.env.TERM?.includes("kitty")) return "kitty";
if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM; // tmux 3.2+ 强制为 "tmux"
if (process.env.TMUX) return "tmux";
```

tmux 3.2+ 在派生 pane 进程时**强制覆盖** `TERM_PROGRAM=tmux`（会话环境变量无法覆盖），因此唯一可注入的钩子是 `TERM=xterm-ghostty`。VibeTerm 现在默认（`VIBETERM_TMUX_TERM_PROGRAM=ghostty`）在接管会话时：

1. 检测宿主（本地或 SSH 远端）是否有 `xterm-ghostty` terminfo，缺失则用内置源（`apps/gateway/src/tmux-client/ghostty-terminfo.ts`，自 Ghostty 官方导出）通过 `tic -x` 安装到 `~/.terminfo`；
2. 成功后把 tmux `default-terminal` 设为 `xterm-ghostty`（注意：这是 **tmux server 级选项**，影响该 server 上所有会话的新 pane）；
3. 同时写入会话环境 `TERM_PROGRAM=ghostty`（对不覆盖该变量的 tmux <3.2 生效）。

之后新开的 pane / window 中 `TERM=xterm-ghostty`，Claude Code auto 渠道即识别为 ghostty 并通过 OSC 777 发送通知。**已存在的 shell 进程不受影响**，需要新开 pane 或重启 shell。

- VibeTerm 终端引擎本身就是 ghostty-vt（WASM），terminfo 声明的能力与前端真实能力一致。
- 设 `VIBETERM_TMUX_TERM_PROGRAM=off` 可完全关闭该行为。
- `tic` / `infocmp` 不可用（无 ncurses 工具）或安装失败时自动跳过 `default-terminal` 设置，保持 tmux 默认 TERM，不会破坏现有程序。
- 不想依赖该机制时，仍可在 Claude Code 设置中显式指定：`{ "preferredNotifChannel": "iterm2" }`（iterm2 / ghostty / kitty 均受 VibeTerm 支持）。

## 验证方式

在 VibeTerm 页面打开的 pane 中执行（模拟 Claude Code 在 tmux 内发出的包装序列）：

```bash
printf '\033Ptmux;\033\033]9;hello from claude\007\033\\'
```

网页端应弹出通知 toast（需站点设置中 `enableBrowserNotificationToast` 开启，默认开启；同一 pane 同一来源默认 3 秒节流）。

## 参考

- 协议文档：[ws-borsh v1 规范](./ws-borsh-v1-spec.md)（notification `source` 枚举）
