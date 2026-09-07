# 终端 AI Agent

本文描述服务端终端 Agent 的数据模型、接口分工、生命周期、终端工具（含 headless ghostty 与 `run_command`）、系统提示词与凭证处理；面向改动 `apps/gateway/src/agent/` 与 `packages/panels/src/agent/` 的开发者。远端窗格的授权模型另见 [远程窗格授权](./agent-remote-pane-grant.md)。

## 1. 目标

VibeTerm 在页面右边栏提供一个 AI Agent 对话面板。Agent 运行在 gateway 服务端，绑定到某个 tmux pane，可以读屏、写终端（受确认机制约束）、做 web 搜索、抓取网页。

- **服务端运行**：浏览器页面关闭不影响 agent 继续跑，多客户端通过 WS 订阅天然同步。
- **设备故障 fail-fast**：SSH 设备断开属于故障场景，终端工具调用立即失败反馈给模型/用户，不挂起硬等重连。
- **多 Provider**：支持任意 OpenAI 兼容 LLM（Chat Completions / Responses 两种协议），自动拉取模型列表，API key 加密落库（AES-256-GCM，复用 `apps/gateway/src/crypto/`）。
- **对话历史持久化**：消息按 step 边界落库（AI SDK ModelMessage 原样），流式 delta 只广播不落库。

## 2. 架构

代码位于 `apps/gateway/src/agent/`（服务端）与 `packages/panels/src/agent/` + `packages/stores/src/agent.ts`（前端）。

### 服务端组件

| 组件 | 文件 | 职责 |
|---|---|---|
| AgentSupervisor | `agent/supervisor.ts` | 单例调度：单 session 互斥（`Map<sessionId, ActiveRun>`）、用户消息入队启动 run、确认决策续跑、stop、重启恢复 |
| AgentRun | `agent/run.ts` | 单轮 turn 执行器：`streamText` + `stopWhen: stepCountIs(maxStepsPerTurn)`，消费 fullStream 广播 delta，`onStepFinish` 落库完整消息 |
| 终端工具 | `agent/tools/terminal.ts`、`agent/tools/run-command.ts` | `read_screen` / `send_input` / `get_pane_info` / `run_command`，见 §5 |
| Web 工具 | `agent/tools/web.ts` | `web_search`（Tavily/Brave，未配 key 不注册）、`fetch_url`（15s 超时 / 2MB 体积上限 / 正文截 16KB / 最多 3 跳重定向） |
| AgentWsHub | `agent/ws-hub.ts` | `sessionId → Set<ServerWebSocket>` 订阅管理；SUBSCRIBE 即回 `sync` 事件（由 supervisor 提供 syncProvider） |
| Provider 注册 | `llm/provider-registry.ts` | 按 protocol 分发：`openai-responses` → `createOpenAI().responses()`；`openai-chat` → `createOpenAICompatible().chatModel()` |
| REST | `api/agent*.ts`、`api/llm.ts` | session CRUD、消息投递、stop、确认决策、provider/settings 管理 |

依赖：Vercel AI SDK（`ai` + `@ai-sdk/openai` + `@ai-sdk/openai-compatible`），确认流使用 AI SDK 的 tool approval 机制（`needsApproval`）。

### 数据表（`apps/gateway/src/db/schema.ts`）

- `llm_providers`：协议、baseUrl、apiKeyEnc（加密）、模型列表缓存。
- `agent_settings`（单行）：搜索 provider 及 key、全局默认 provider/model。
- `agent_sessions`：绑定 deviceId/paneId、provider/model、writeMode（`confirm`/`auto`，默认 confirm）、status（`idle`/`running`/`waiting_confirmation`/`stopped`/`error`）、maxStepsPerTurn（默认 25）；远端窗格会话另有加密的 `remote_grant`。
- `agent_messages`：会话内 seq 单调递增，content 为 AI SDK ModelMessage 原样 JSON。
- `agent_queued_messages`：运行中投递的排队消息。
- `agent_confirmations`：id 即 AI SDK approvalId，status `pending`/`approved`/`denied`/`cancelled`，决策走 CAS 防并发重复决定。

### 接口分工

- **REST**：用户消息（`POST /api/agent/sessions/:id/messages`）、停止、确认决策（`POST /api/agent/confirmations/:id/decide`）。确认走 REST 是为了统一路径（通知链接、消息指令 `approve` / `deny`）。
  - **运行中不拒绝**：`AgentSupervisor.sendMessage` 发现该 session 有 active run 时把消息**入队**（`agent_queued_messages`），返回 `201 { queued }` 并广播队列；`steer=true` 时额外请求立即注入当前 run。队列可经 `GET/POST /api/agent/sessions/:id/queue`、`PATCH/DELETE /api/agent/queue/:id` 查看、追加、改写、撤回。
  - 仍返回 409 的只有真正的冲突态：`waiting_confirmation` 且有 pending confirmation（须先决策）、session 正在 stopping、重复 decide。
- **WS（Borsh）**：客户端只有 `AGENT_SUBSCRIBE`(0x0601)/`AGENT_UNSUBSCRIBE`(0x0602)；服务端单一 `AGENT_EVENT`(0x0603)，`eventType: u8` + JSON payload，避免协议 lockstep。eventType 见 `packages/shared/src/ws-borsh/agent.ts`：1=sync 2=status 3=text_delta 4=reasoning_delta 5=tool_call 6=tool_result 7=confirmation_request 8=confirmation_resolved 9=message_persisted 10=error 11=turn_finished 12=credential_warning 13=queue_updated。

### 事件流（一轮带确认的 turn）

```
用户发消息 (REST POST messages)
  → supervisor.submitUserMessage：落库 user 消息，startRun
  → AgentRun：acquire 设备连接 → streamText
      ├─ fullStream: text/reasoning delta → hub 广播（不落库）
      ├─ tool_call / tool_result → 广播
      └─ onStepFinish → 落库完整 ModelMessage → 广播 message_persisted
  → 模型请求 send_input 且 writeMode=confirm：
      写 agent_confirmations(pending) → status=waiting_confirmation
      → 广播 confirmation_request + eventNotifier('agent_confirmation_pending')
      → run 结束、release 连接（确认挂起零成本，无悬挂请求/连接）
用户点允许/拒绝 (REST decide)
  → CAS 写决策 → 同回合全部确认就绪后合并一条 tool 消息落库 → 起新 run 续跑
      （approve：续跑 initial 阶段真实执行工具；deny：模型收到拒绝结果后继续）
  → 正常结束 status=idle + turn_finished（可选通知）
```

断线恢复不做 delta 级回放：前端重连后 REST 按 `afterSeq` 增量拉历史，SUBSCRIBE 时服务端立即回 `sync`（当前 status + 进行中文本 + pending confirmations + lastMessageSeq）。

## 3. 生命周期语义

- **页面关闭**：run 在服务端继续；重开页面靠历史 + sync 恢复，进行中的流式文本无缝接上。
- **SSH/设备断开（fail-fast）**：终端工具执行时设备不可用立即向模型返回错误（`runTmux` 的 `'silent'` 形态抛 `TmuxTargetMissingError`，不触发连接告警）；同一 run 内终端工具连续失败 2 次（`run.ts` `TERMINAL_FAILURE_LIMIT`）终止 run，status=error + `agent_error` 通知。绝不静默挂起等重连。
- **gateway 重启恢复**（`supervisor.start()`）：
  - `running`：先作废残留 pending 确认（crash 中间态）并补 execution-denied result，再从已落库消息重新发起 run（等价重试最后 step）。
  - `waiting_confirmation`：pending 仍在则保持等待，**不重发通知**；pending 丢失则尝试按已决议确认补 response 续跑，否则自愈置 idle。
- **stop 语义**：`stopSession` abort 活动 run 并落库已累积文本（标记 truncated），status=stopped；waiting_confirmation 时取消 pending 并落**合成 execution-denied tool-result**（而非 approval-response，保证消息流自洽）。进程 shutdown（`supervisor.stop()`）只 abort 不改 status，留给下次启动恢复。
- **异常重试**：网络/5xx 整轮指数退避重试（默认 3 次，`AgentRunDeps.llmMaxRetries`），仍失败 status=error + 通知。

## 4. 系统提示词

提示词是类 JSX 的可组合模板（零依赖）：

- 自研极简 JSX→纯文本运行时：`apps/gateway/src/agent/prompts/jsx.ts`（`h`/`Fragment` + `cat`/`lines`/`blocks` 工具函数），组件即「props → string」纯函数。基础组件 `Doc`/`Section`/`Item`/`Lines` 在 `components.ts`。
- 模板 `system-prompt.tsx` 用 Bun 原生 classic JSX 转译。文件头三条 pragma：`/** @jsxRuntime classic */ /** @jsx h */ /** @jsxFrag Fragment */`。`@jsxRuntime classic` 不可省——否则从仓库根跑 `bun test` 时 Bun 会按默认 automatic 运行时去找 `react/jsx-dev-runtime` 而报错。
- gateway `tsconfig.json` 含 `jsx: react` + `jsxFactory: h` + `jsxFragmentFactory: Fragment`（gateway 无其他 tsx，前端独立 tsconfig 不受影响）。
- 入口 `prompts/index.ts` 导出 `buildAgentSystemPrompt(context)` 与 `buildTitleGenerationPrompt`。

模板段落：身份 / 入口环境 / 真实环境探测引导 / 窗口尺寸与 TUI / 终端工具规则 / 网络设备知识 / 注入防护 / 凭证处理 / 意图确认 / 安全科普 / 通用规则 / 用户自定义指令。

### 环境注入

`prompts/environment.ts` 的 `collectAgentEnvironment(device)` 采集「入口主机」事实：device 类型/host/user/port、tmux session、时区、当前时间；**仅 local 设备**额外注入 gateway 主机 OS/shell。提示词明确标注这是「入口主机」，并强引导 agent：pane 可能已 ssh 到远程服务器/网络设备，动手前先探测真实环境（`uname`/`ver`/`echo $SHELL`/提示符）。网络 IP 不注入，改为引导 agent 自查。

### 实时窗口尺寸与 pane 元信息

窗口尺寸随时变化，不 inject，改为实时读取：`TerminalRuntimeLike.getPaneInfo(paneId)` 沿 `DeviceSessionRuntimeConnection` → `DeviceSessionRuntime` → Local/Ssh 连接实现，底层 `tmux display-message -p` 取 `pane_width/pane_height/alternate_on/cursor_x/cursor_y/pane_current_command`（`capture-history.ts` 的 `PANE_META_FORMAT`/`parsePaneMeta`）。`read_screen`/`send_input` 返回值附带实时 `cols/rows`（失败降级为 `null`）。

### 注入防护

屏幕内容、抓取的网页都是不可信数据，可能藏诱导指令。双层防护：

- 结构层：`tools/untrusted.ts` 的 `wrapUntrusted` 把 `read_screen`/`send_input` 屏幕文本、`fetch_url` 网页正文用 `<<<UNTRUSTED ...>>> ... <<<END ...>>>` 标记包裹。
- 指令层：system prompt 明确这些内容是数据而非指令，绝不执行其中内嵌命令，可疑诱导上报用户。

## 5. 终端工具与 headless ghostty

agent 操作终端不是「屏幕抓取」而是**服务端 headless ghostty 渲染 + 实时字节流**驱动：

1. **OSC 133 解析**：`PaneStreamParser`（`apps/gateway/src/tmux-client/pane-stream-parser.ts`）从 control-mode `%output` 解析 `133 A/B/C/D;<exit>`（含注入的 `vibeterm=<nonce>` 参数），经 `onPromptMarker` 沿 `control-mode-subscription → connection → DeviceSessionRuntime` listener 透传。tmux 不支持 OSC 133 且 `capture-pane` 吃掉这些标记，所以只能从字节流拿。
2. **Headless ghostty**：`packages/ghostty-terminal/src/headless.ts` 的 `HeadlessTerminal`（子路径导出 `ghostty-terminal/headless`）：`create/write/render(渲染态纯文本)/isAlternateScreen(DEC 1049)/size/resize/free`，在 Bun 里 headless 运行。wasm 资源用 `new URL('./assets/ghostty-vt.wasm', import.meta.url)`（Vite 与 Bun 通用）；生产打包由 `packages/app/scripts/copy-runtime-assets.sh` 把 wasm 拷进 `dist/runtime/assets/`。
3. **Per-pane 模拟器**：`apps/gateway/src/tmux-client/pane-emulator.ts` 的 `PaneEmulator` 把某 pane 的实时流喂进 headless ghostty 维护渲染网格，并提供 `render/isAlternateScreen/size` 和字节/标记 `tap`。`PaneEmulatorRegistry` 镜像 `runtime-registry` 的引用计数：wasm bindings 全局单例；每 pane 一个句柄，按 `deviceId:paneId` 复用；引用归零 / `destroy` / `shutdownAll` → `free` + 解绑订阅；bounded scrollback（默认 5000）+ 输出硬上限 + 池上限（LRU 驱逐空闲实例）。`run.ts` 在 run 期间尽力 acquire、finally release；stub runtime 无订阅则退回 capture-pane。
4. **工具**（`apps/gateway/src/agent/tools/terminal.ts`）：
   - `read_screen`：emulator `render()` 出**渲染态**可见屏（含 TUI），带 `alternateScreen`；无 emulator 退回 capture-pane。
   - `send_input`：模式感知——行模式回流式增量（tap 捕获发送后新字节），TUI/alternate 回整屏重渲染；无 emulator 退回 15 行尾部。hex send-keys + keys 枚举。
   - `get_pane_info`：尺寸/光标/当前命令（tmux）+ alternate（emulator）。
   - `run_command`（`run-command.ts`），三类目标判定链：
     - **POSIX**：注入隐形 OSC 133 + 一次性 nonce 包裹命令（退出码语法按 shell flavor：`$?`/fish `$status`），等带本 nonce 的 `;D` → 精确输出 + 退出码；无标记回退提示符/静默判定。
     - **CLI（网络设备）**：学提示符 → 提示符末尾重现判完成（无退出码）；`--More--` 自动续翻；错误串启发（`% Invalid input` 等）→ `likelyError`；可选 `disablePagingCommand`。
     - **TUI**：启动即/执行中切 alternate → `status=entered_tui` 交回交互式读写屏。
     - `expect` 命中早返回；硬超时返回已累积。输出剥 ANSI + 处理 `\r` 覆盖 + 剥命令回显，`wrapUntrusted` 标注，凭证消毒仍走出站 middleware。
5. **提示词**：agent 先探测环境（POSIX/网络 CLI/TUI），据此选 `run_command`（传 shell/mode/prompt）或交互式读写屏。

## 6. 凭证处理（不对称策略）

凭证（屏幕上的 `show run` 密码 / `cat` 私钥 / token，以及用户输入）会外发 LLM provider 并落进 `vibeterm.db`。

**机器来源内容（屏幕/网页）：DB 存真实，仅出站 LLM 消毒**

- 工具返回**真实**内容，`onStepFinish` 落库即真实（本地审计/重放完整）。
- 消毒收口在 **provider 出站边界**：`redaction-middleware.ts` 用 AI SDK `wrapLanguageModel` + `transformParams`，在每次调 provider 前对 prompt 消毒。该 seam **同时覆盖 run 内 tool-result 回喂与跨轮历史回放**，LLM 永不见真实凭证。
- 只消毒 `role==='tool'` 与 assistant 内嵌的 `tool-result` 输出（text/json 递归），**绝不动 user/system 消息**。

**用户输入消息：不改写，仅告警**

- 用户自己输入的凭证**不改写**（照常发 LLM + 落库，尊重用户意图）。
- `supervisor.submitUserMessage` 用 `detectSecrets` 检测，命中则广播 `AGENT_EVENT_CREDENTIAL_WARNING`（前端 toast 告警）+ Telegram 推送（受 `enableTelegramNotificationPush` 开关控制）。

**消毒规则（高精度模式）**：`secret-scan.ts` 的 `redactSecrets`/`detectSecrets`，高置信度模式串：私钥块、已知前缀 token（`sk-`/`ghp_`/`AKIA`/`xoxb-`/`ya29.`/`AIza`/`glpat-` 等）、`Authorization: Bearer`、含密码连接串/URL、网络设备 typed 口令（`password 7`/`secret 5`）/`enable secret`/`snmp-server community`。配套负样本单测确保不误伤普通配置/散文。

**重要权衡**：`vibeterm.db` 的 agent 消息表会保存真实的终端/网页内容，可能含明文凭证。消毒边界**仅止于外部 LLM provider**，数据库文件本身需按敏感数据对待（备份、同步、外泄都可能泄露凭证）。

## 7. 安全与隐私

- **写终端确认**：`send_input` 的 `needsApproval` 按 session writeMode 判定，默认 confirm；pane 绑定在 session 上而非工具参数，模型无法越界写其它 pane。
- **SSRF 防护**：`fetch_url` 默认拒绝回环/链路本地/私有网段地址，重定向逐跳重新校验（最多 3 跳）；env `VIBETERM_AGENT_ALLOW_PRIVATE_FETCH=1` 放行。
- **隐私提示**：`read_screen` 会把终端可见内容（可能含密钥回显）发给第三方 LLM，session 切换菜单底部常驻提示文案。
- **auto 模式中断重放风险**：进程死在「终端已写入但 step 未落库」窗口时，重启恢复会重写一遍输入。confirm 模式有确认兜底；auto 模式接受此风险。
- **API key**：providers / 搜索 key 均加密落库，REST 只写不回显（掩码展示）。

## 8. 已知限制

1. **DNS rebinding**：fetch_url 的私网判断基于 hostname 字面/解析一次，未做连接时二次校验。
2. **token 用量统计**：未实现（usage 数据 AI SDK 有暴露，表结构未留字段）。
3. **agent 跨多 pane 操作**：单 session 单 pane 绑定，跨 pane 需多 session。
4. **同回合多确认须全部决定后才续跑**：AI SDK 的 `collectToolApprovals` 只消费最后一条 tool 消息的 approval responses，supervisor 按「全部决定后合并一条 tool 消息」处理（`appendApprovalResponsesIfReady`）。
5. **WS 背压**：delta 广播未做按订阅者背压控制，慢消费者可能积压（前端有 40ms 节流缓解）。
6. **error 重试链路时长**：SDK 内部重试 × run 级重试全程约 60-70s，前端无进度感知。
7. **agent_turn_finished 通知**：仅 deps 级开关（默认开），无用户级持久化设置项。
8. **端到端集成测试**：真 tmux → control 流 → parser → emulator → run_command 的全链路集成测试未补；各层单测分别覆盖（真 OSC 字节、真 ghostty wasm、run_command 全分支）。

## 9. 测试

- 单测：`agent/supervisor.test.ts`（approve 续跑 / deny / CAS 重复决策 / stop / 重启恢复 / 凭证告警）、`agent/run.test.ts`（auto 模式、终端工具连续失败终止）、`agent/ws-hub.test.ts`、`llm/provider-registry.test.ts`、`llm/ai-sdk.spike.test.ts`（AI SDK 能力闸门）、`secret-scan` 正负样本、`redaction-middleware`（user/system 不消毒）、OSC 133 parser、`HeadlessTerminal` 真 wasm、emulator/registry 防泄漏、run_command 全分支。
- e2e（`apps/fe/tests/`）：`agent-session.spec.ts`（confirm flow、刷新后历史恢复、双标签页同步、provider 不可达、session CRUD）、`agent-panel.spec.ts`、`settings-llm.spec.ts`、`mobile-agent-watch.spec.ts`。
- 打真实 LLM 端点的实测见 [实测](../development/live-integration-tests.md)。
