# Ghostty Wasm 终端运行机制说明

## 背景

WebUI 终端底座已从原先的 xterm 直连实现切换为 Ghostty wasm 兼容层。当前方案并不是在浏览器中运行一个完整的 Ghostty 应用，而是将 Ghostty 的 VT 内核编译为 wasm，在前端中承担终端状态维护、VT 输出解析、格式化渲染、键盘编码和粘贴编码等职责。

后端的 tmux 会话、pane 管理、WebSocket 协议、设备连接与数据转发仍由 gateway 和 ws-borsh 链路负责。Ghostty wasm 只负责浏览器侧的“终端语义执行”。

## 目标

- 在不改动页面层主要 contract 的前提下替换终端底座。
- 保留现有 `TerminalRef`、resize hook、选择状态机和 E2E 调试入口。
- 通过独立 workspace 包隔离 Ghostty wasm 细节，避免 `apps/fe` 直接依赖底层导出。

## 整体结构

当前关键层次如下：

1. `apps/fe` / `packages/panels`
   - 页面层与业务面板；不直接接触 wasm。
2. `packages/terminal-ui`
   - 终端组件、渲染面（surface）、pane 数据面接线、resize / 触控 / 键盘策略。
3. `packages/ghostty-terminal`
   - Ghostty wasm 加载器。
   - C API 封装和结构体读写。
   - 终端控制器、输入事件桥接、canvas 渲染与 xterm 兼容 buffer。
   - 包内提交 `ghostty-vt.wasm` 与对应 metadata，由维护脚本手动更新。
4. `vendor/ghostty`
   - Ghostty 官方源码 submodule。
   - 锁定版本由 superproject gitlink 决定，包内 metadata 会镜像当前锁定 commit。

## 运行时职责分配

### 后端负责什么

- tmux 会话和 pane 的真实生命周期。
- 终端输出收集、输入转发和设备连接管理。
- canonical 数据面：`PaneData`、`Screen*` / `History*` 事务、`ResizePaneV11` 等 ws-borsh 消息。
  （1.1.23 之前这里是 `TERM_HISTORY` / `TERM_OUTPUT` / `TERM_RESIZE` / `TERM_SYNC_SIZE`，
  这四个 kind 已随整条 legacy 状态流删除，见 [ws-borsh v1 规范](../ws-protocol/2026021402-ws-borsh-v1-spec.md)。）

### Ghostty wasm 负责什么

- 解析从后端收到的 VT 字节流。
- 维护屏幕内容、scrollback、viewport 和终端 mode。
- 按当前终端状态提供渲染网格（行 / cell / 光标 / 调色板）与纯文本。
- 把浏览器键盘事件编码成终端输入字节序列。
- 按终端 mode 对粘贴文本做 bracketed paste 编码。

### React 终端组件负责什么

- 创建和销毁终端控制器实例。
- 将 ws-borsh 的历史输出和实时输出喂给 Ghostty。
- 将 Ghostty 编码后的输入重新发回 gateway。
- 协调主题、输入模式、尺寸同步、移动端交互和 E2E 探针。

## 初始化链路

入口在 `packages/terminal-ui/src/components/Terminal.tsx`。

组件挂载后会调用 `createTerminalController(...)`，创建过程位于 `packages/ghostty-terminal/src/terminal.ts`：

1. 调用 `getGhosttyBindings()` 加载 `ghostty-vt.wasm`。
2. 通过 `ghostty_type_json()` 读取 wasm 导出的类型布局信息。
3. 创建以下核心句柄：
   - `terminalHandle`：终端状态实例。
   - `keyEncoderHandle` / `mouseEncoderHandle`：键盘与鼠标编码器。
   - `renderState`：渲染状态资源（`render-state.ts` 的 `createRenderState`），每帧从 wasm 读回网格。
4. `open(container)` 时创建 `.xterm` 风格 DOM（`terminal-dom.ts`）、隐藏 `textarea`、内容表面，
   并把 `CanvasRenderer` 挂到渲染协调器（`TerminalRenderCoordinator`）。
5. 选区文本经全局探针 `__tmexE2eTerminalSelectionText` 暴露给 E2E；其余 E2E 入口由
   `packages/terminal-ui` 侧的组件提供。

其中，wasm 只会按模块级 Promise 懒加载一次，避免严格模式和多终端实例重复初始化。

## wasm 资产维护约束

- 运行时只读取 `packages/ghostty-terminal/src/assets/ghostty-vt.wasm`。
- 对应的版本信息记录在 `packages/ghostty-terminal/src/assets/ghostty-vt.meta.json`。
- 手动维护入口：`bun run --filter ghostty-terminal update:wasm`
  - 从当前锁定的 `vendor/ghostty` submodule 编译 wasm。
  - 覆盖包内 `ghostty-vt.wasm`。
  - 同步写回 metadata（锁定 commit、sha256、文件大小）。
- 自动化入口：`bun run --filter ghostty-terminal verify:wasm`
  - 只校验 wasm 与 metadata 存在。
  - 只校验 metadata 中记录的 commit 是否与当前锁定的 `vendor/ghostty` gitlink 一致。
  - 不触发任何编译。

这意味着自动化流程遵循“never build, only verify”，避免在测试、构建或 CI 中拉起 Zig / Ghostty 编译链。

## 输出链路

后端输出进入浏览器后的执行路径如下：

1. canonical 状态流经 `PaneSinkRegistry` 分发到该 pane 的 sink
   （`packages/terminal-ui/src/components/hooks/usePaneSinkRegistration.ts` 的
   `onOutput` / `onScreenSnapshot` / `onHistoryPage` / `onRebase`）。
2. 渲染面对换行做最小归一化，主要是把裸 `\n` 补成 `\r\n`，避免列位置异常。
3. 调用终端实例的 `write(...)`。
4. `GhosttyTerminalController.write(...)` 内部调用 `ghostty_terminal_vt_write(...)`。
5. Ghostty 更新内部终端状态后，控制器通知 `TerminalRenderCoordinator`（`terminal-render-coordinator.ts`
   + `terminal-render-loop.ts`）在下一帧渲染。
6. 渲染一帧的过程：
   - `render-state.ts` 从 wasm 读回本帧的行 / cell / 调色板 / 光标，并在读取过程中顺带算出**行级 dirty**
     （内核本身恒报 `full`，见 [热路径优化](../performance/2026082700-hot-path-optimizations.md) 第 6 节）；
   - `CanvasRenderer`（`canvas-renderer*.ts`）只重绘变化的行，另有独立的选区层与光标层；
   - `TerminalBuffer`（`terminal-buffer.ts`）用同一份行文本维护 xterm 兼容视图（`buffer.active`），
     scrollbar 数据同步 viewport / baseY / length。

因此页面上的终端内容是 Ghostty 维护的终端状态读回后由 canvas 绘制的结果，既不是前端自己解释 ANSI，
也不再是 formatter 出的 HTML（早期实现是 `.xterm-screen.innerHTML`，已换成 canvas）。

## 输入链路

输入仍然通过浏览器事件进入，但编码职责已经切到 Ghostty：

1. 控制器在 `open()` 时创建一个隐藏 `textarea` 作为输入焦点承载。
2. `keydown` / `keyup` 事件进入 `encodeKeyboardEvent(...)`。
3. 该函数将浏览器事件转换为 Ghostty 需要的：
   - key code
   - modifier mask
   - composing 状态
   - 可选 UTF-8 字符
   - 可选 unshifted codepoint
4. 调用 `ghostty_key_encoder_encode(...)` 得到终端输入字节流。
5. 控制器通过 `onData(...)` 把编码结果抛回 React 组件。
6. `Terminal.tsx` 再调用 `sendInput(...)` 发给后端。

粘贴文本则通过 `ghostty_paste_encode(...)` 处理。若终端启用了 bracketed paste mode，则 Ghostty 会自动输出带包裹序列的内容。

## IME 与移动端输入

当前实现保留了一个最小、可测的 IME 处理策略：

- `compositionstart` 标记进入 composing 状态。
- `compositionend` 仅在事件本身携带最终文本时发送输入。
- 取消组合输入时不发送 fallback 文本。
- 非 composing 的 `beforeinput` 直接作为普通文本输入发送。

这样可以满足当前移动端 E2E 的直接输入、IME 提交、取消组合输入和粘贴行为约束。

## 尺寸同步链路

尺寸同步仍由 `useTerminalResize` 管理，Ghostty 控制器只提供测量和 `resize(...)` 能力：

1. `FitAddon.proposeDimensions()` 或容器尺寸回退逻辑计算目标 `cols/rows`。
2. `useTerminalResize` 根据场景决定发 `resize` 还是 `sync`。
3. 调用终端实例的 `resize(cols, rows)`。
4. 控制器内部执行 `ghostty_terminal_resize(...)`。
5. 新尺寸继续通过 ws-borsh 协议与后端 pane 尺寸收敛。

这里保留了与旧实现接近的接口形状，因此页面层和现有 resize 测试不需要大面积改写。

## 为什么还保留 `.xterm` 风格接口

虽然底层不再使用 xterm，但兼容层仍保留了以下表面形状：

- `.xterm`、`.xterm-screen`、`.xterm-helper-textarea` 等 DOM 类名（canvas 直接挂在 `.xterm-screen` 上）；
- `buffer.active.baseY / viewportY / length / getLine()`（`TerminalBuffer` 只保存当前视口文本）；
- `_core._renderService.dimensions.css.cell`；
- `FitAddon`（`proposeDimensions()` 仍是尺寸测量入口）。

这样做的目的不是继续依赖 xterm，而是降低页面层、移动端交互逻辑和既有 E2E 的迁移成本。

## 关键文件

- `packages/ghostty-terminal/src/ghostty-wasm.ts`
  - Ghostty wasm 导出封装、结构体布局读写、formatter / key / mouse / paste 调用。
- `packages/ghostty-terminal/src/terminal.ts`
  - 终端控制器、DOM 适配、输入事件桥接、渲染调度入口。
- `packages/ghostty-terminal/src/{render-state,canvas-renderer,terminal-render-coordinator}.ts`
  - 渲染状态读回与行级 dirty 判定、canvas 绘制（含选区层 / 光标层）、帧调度。
- `packages/ghostty-terminal/src/headless.ts`
  - 服务端 headless 模拟器（gateway 的 `run_command` / 读屏用，见
    [run_command 与 headless ghostty](../agent/2026061303-run-command-headless-ghostty.md)）。
- `packages/terminal-ui/src/components/Terminal.tsx`
  - 与 ws-borsh、主题、输入模式、resize hook 和页面层 contract 的连接点。
- `packages/terminal-ui/src/components/useTerminalResize.ts`
  - 容器测量、sync/resize 防抖和尺寸上报策略。

## 当前边界

- 当前只覆盖 tmex 真实使用到的能力，不追求完整 xterm API 等价。
- 渲染是 canvas：按行 dirty 重绘，选区与光标各自成层；不做 DOM 逐 cell。
- 同一个 wasm 内核还被 gateway 以 headless 形式复用（服务端读屏与 `run_command`）。

## 结论

当前 Ghostty 在 WebUI 中的实际角色是“浏览器内的终端解释与编码内核”。它取代了原先 xterm 在终端语义层的职责，但没有接管 tmux 会话管理、ws 协议或页面级状态流。整个方案的核心价值在于：

- 终端语义由官方 Ghostty VT 内核提供；
- 页面层继续沿用原有 contract；
- wasm 细节被封装在独立包中，便于后续维护和升级。
