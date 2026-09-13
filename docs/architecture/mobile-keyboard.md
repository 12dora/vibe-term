# 移动端软键盘：避让模式与唤起入口

本文描述触屏设备上终端与虚拟键盘的两套规则：键盘弹出时页面如何避让（lift / resize / follow 三模式），以及什么操作才会唤起键盘；面向改动 `packages/terminal-ui` 触控与键盘逻辑的开发者。

## 1. 键盘避让（三种模式）

终端页右上角（`PageActions`）的「键盘行为」入口弹出底部 Sheet（`packages/panels/src/settings/terminal-settings-sheet.tsx`，大屏 `sm:mx-auto sm:max-w-md` 居中限宽），三种模式即点即生效，持久化在浏览器（`useUIStore.keyboardBehaviorMode`，zustand persist key `vibeterm-ui`，旧用户缺字段时 `merge` 回默认）。入口在所有屏幕尺寸展示（含触屏 PC、iPad）。

| 内部值 | 用户文案 | 行为 |
|---|---|---|
| `lift` | 页面平移 | 整页按键盘高度上移，终端尺寸不变 |
| `resize` | 终端缩放 | 整页缩到键盘上方的可用高度，终端随之 resize 占满（会改远端 tmux 窗格行数） |
| `follow` | 光标对齐 | 不改尺寸，按光标位置上移使光标正好在键盘上方；边界封顶避免露白。**默认** |

`lift` 在满屏终端下体验良好（光标在底部），但**新打开的空 shell** 光标在顶部，整页上移后光标被推出屏幕。`follow` 修复这一点，光标在底部时表现等同 `lift`。`resize` 会主动触发远端 tmux `resize-pane`（vim/htop 重绘），因此不作默认。

### 实现链路

- `packages/terminal-ui/src/hooks/use-keyboard-avoidance.ts`：监听 `visualViewport` resize/scroll + window resize + document focusin/focusout（RAF 防抖）；仅当 `document.activeElement.closest('[data-virtual-keyboard-avoid]')` 命中时输出结果：

  ```ts
  type KeyboardAvoidance =
    | { strategy: 'none' }
    | { strategy: 'transform'; offset: number }   // lift / follow
    | { strategy: 'height'; height: number };      // resize
  ```

- `packages/terminal-ui/src/utils/virtualKeyboard.ts`：`computeVirtualKeyboardOffset` = `round(innerHeight - viewportHeight - offsetTop)`，`scale≠1` 或 `<60px` 归零；`needsManualKeyboardAvoidance()` 触屏检测。
- `apps/fe/src/main.tsx` `MainInset`：`transform` 时给 `SidebarInset`（`<main>`）加 `translateY(-offset)` + `transition 0.12s`；底部 safe-area 填充与 offset 联动；`height` 时把 `<main>` 高度设为 `innerHeight - inset`，触发终端既有 `ResizeObserver` → resize 链路。
- 标记点：`packages/panels/src/device-console/terminal-stage.tsx` 的终端容器与 `editor-input-panel.tsx` 的 editor textarea 容器上的 `data-virtual-keyboard-avoid`。

### follow 模式的光标对齐

纯函数 `computeCursorFollowOffset`（`virtualKeyboard.ts`）：

```
keyboardTopClientY = innerHeight - inset
naturalBottom      = cursorBottomClientY + appliedOffset   // 加回当前已应用的位移
offset             = clamp(round(naturalBottom + margin - keyboardTopClientY), 0, maxOffset)
// maxOffset 默认 inset；follow 模式传 inset + 快捷键栏高度
```

`clamp` 上界是避免露白的核心：位移不超过键盘高度，否则 `<main>` 底边升过键盘顶、暴露下方空白。`follow` 模式下 direct 输入的快捷键栏会浮到键盘正上方（hook 写 CSS 变量 `--vibeterm-shortcut-lift = inset - offset`，ShortcutsBar 据此再 `translateY`，与 `<main>` 的 `-offset` 叠加后总位移恰为 `-inset`），栏本身填住了那段空白，因此上界放宽到 `inset + 快捷键栏高度`。`naturalBottom` 加回 `appliedOffset` 使计算对自身位移稳定收敛（不抖动）。键盘打开期间用 RAF 轮询光标位置（光标移动不发 viewport 事件），setState 仅在 offset 变化 ≥1px 时触发。光标拿不到（终端未聚焦 / 编辑器模式 / 光标隐藏）时回退到 `inset`（等价 `lift`）。

光标位置来自 `packages/ghostty-terminal`：`terminal.ts` 每帧渲染缓存 `lastCursor`；public `getCursorViewportRect()` 仅当本终端聚焦（`document.activeElement === this.textarea`）且光标可见时返回 `screenElement.getBoundingClientRect().top + cursor.y * cellHeight` 的 client 上/下沿，否则 `null`。桥接单例 `packages/terminal-ui/src/utils/keyboard-cursor-bridge.ts`（`registerCursorRectGetter` / `readActiveCursorRect`），`Terminal.tsx` 在实例就绪时注册、卸载时注销；非聚焦终端返回 `null`，天然解决编辑器模式 / 多终端。

i18n：`terminal.keyboardBehavior.*`（三语）。旧版 iOS（`offsetTop>0`）的坐标准确性只能靠真机抽查，模拟器复现不了真机键盘行为。

## 2. 唤起入口收敛到输入行

触屏上大量手势只是「看」——滚动 scrollback、长按选词复制、切 pane 后确认内容——若画布任意轻点都聚焦 helper textarea（`.xterm-helper-textarea`），软键盘就会反复弹出并连带触发避让。反过来，合成 `mousedown` 的默认动作又会把焦点从 textarea 上夺走——键盘弹着时点画布会「闪收」。两者都属于焦点被指针隐式决定。

收敛后的语义：焦点只由**明确的输入意图**触发——点终端的**输入行**（光标所在行，上下各放宽一行）弹键盘，点画布其他任何位置都不动焦点；收起走快捷键栏的「隐藏键盘」。

### 行为矩阵

| 环境 | 操作 | 软键盘 | 其他行为 |
|---|---|---|---|
| 桌面（鼠标） | 点终端 | 无 | 聚焦终端可直接输入 |
| 桌面 | 挂载 / 切 pane / editor 切回 direct | 无 | 自动回焦 |
| 触屏 | 轻点输入行（光标行 ±1 行） | 弹出 | 无其他副作用 |
| 触屏 | 轻点画布其他位置 | 不弹；已弹着也不收 | 无副作用（不起选区、不发鼠标字节） |
| 触屏 | 滚回历史后轻点任意位置 | 不弹（光标行不在屏上） | — |
| 触屏 | 轻点画布（上报模式 TUI） | 仅光标行弹出 | 照常发 press+release |
| 触屏 | 单指滑动 / 双指滑动 | 不变 | 滚动 / 平移 / 滚轮上报照旧 |
| 触屏 | 长按 | 不弹 | 本地 word 选择 + 选区工具条 |
| 触屏 | 选区工具条的复制 / 粘贴 / 取消 | 不弹 | 工具条锚在选区上/下方；点「复制」走手势机旁路 + `pointerup`（见 §3） |
| 触屏 | 点快捷键栏的「隐藏键盘」 | 收起 | 该按钮只在键盘弹着时出现 |

触屏判定：视口 < 768px 或带触摸能力（`isTouchFirstEnvironment`，与 `useMobileViewport` 同源），因此平板 / 触屏本也走触屏语义，但它们上的**真鼠标点击仍照常聚焦**。

### 实现点

- `packages/terminal-ui/src/components/touch/tap-focus.ts`：纯判定。`moved=false` 且 touchend 落在 `.xterm` 子树内即视为「画布轻点」，覆盖层（选区工具条、启动占位）上的轻点必须放行；`cursorRowFromTerminal` + `tapHitsCursorRow` 判定是否落在输入行。光标行取自 `lastCursor`（视口内行号），基准点取 `.xterm-screen` 的 client rect，行高取 `_core._renderService.dimensions.css.cell.height`——与 ghostty 自己的 `hitTest` 同源，平移视口下也对齐。`viewportY !== baseY`（滚回历史）时返回 null。
- `packages/terminal-ui/src/components/touch/gesture-machine.ts`：`pending`（上报模式 tap）分支的 `terminal.focus()` 改为按输入行判定；新增 `moved` 记账与 `handleCanvasTap()`：画布轻点在 touchend 上 `preventDefault` + `noteTouchHandled()`，把整套合成鼠标序列作废；随后 `focusIfTapHitsInputRow()` 只在命中输入行时显式 `focus()`（touchend 属用户手势，iOS 允许在其中唤起键盘）。
- `packages/ghostty-terminal/src/terminal-pointer-handlers.ts`：`click` 监听器补上合成抑制窗口判定，抑制窗口内的 `mousedown` 改为 `preventDefault` 后返回。抑制窗口只由触摸手势置位（500ms），真鼠标点击不受影响。
- `packages/terminal-ui/src/utils/terminal-input-focus.ts`：焦点入口统一。`refocusTerminalInput()` 承载全部**隐式**回焦（挂载自动聚焦、分屏切焦点 pane、复制/粘贴/取消选区后回焦），触屏一律跳过；`focusTerminalInput` / `blurTerminalInput` / `isTerminalInputFocused` 供显式入口使用。
- `packages/panels/src/device-console/terminal-keyboard-button.tsx`：快捷键栏最左侧的「隐藏键盘」按钮，**只收不开**——只在终端输入元素持有焦点时渲染（document 上的 focusin/focusout 同步），`onMouseDown` 阻止默认避免按钮自身抢焦点。只在触屏渲染（`TerminalStage` 的 `isMobile`），direct 模式才有。
- `packages/panels/src/device-console/terminal-shortcuts-slot.tsx`：`ShortcutsBar` 增 `keyboardToggle`；有它时即使一条快捷键都没配置也渲染 `.terminal-shortcuts-strip`，键盘避让测量的浮条高度因此始终包含该按钮。
- i18n：`terminal.hideKeyboard`。

## 3. 选区工具条与复制方式

选区出现后，工具条锚在选区包围盒的**上方**（上方空间不够则下方），水平居中并在容器内 8 px 夹取。几何来自 Ghostty 的 `getSelectionViewportRect()`（client 坐标并集，裁到画布可见区）；旧壳没有该方法时回退顶栏居中。选区变化、容器 / 窗口 / `visualViewport` resize 后重算。

触屏点「复制」必须绕过长按手势机，否则 `touchend` 会 `preventDefault`、合成鼠标序列把选区清掉或根本点不中按钮：

- `touchstart` 命中 `[data-testid="terminal-selection-toolbar"]` → `resetGesture()`，不 arm 长按、不进 pending/scroll、`touchend` 不 `preventDefault`、不发鼠标上报。
- 按钮：touch 走 `onPointerUp` + `preventDefault`；鼠标走 `onClick`。合成 `mousedown` 不再 `preventDefault`（防 WebKit 吞 click）。
- 空选区复制打 `terminal.copyFailed`，不再静默。`writeClipboardText` 仍在手势栈上同步调用。

设置 → 终端「复制方式」（`terminalCopyMode`，持久化键 `vibeterm-ui`，默认 `'button'`，非法值归一成 `'button'`）。两项并排（窄屏折行、等宽）：

| 值 | 行为 |
|---|---|
| `button`（文案「点击按钮后复制」） | 选区完成只出工具条，写入剪贴板要再点「复制」。桌面划选抬手 / 选区变化不写盘 |
| `auto` | 选区 **committed** 时同步写剪贴板并 toast「已复制」；工具条仍出现但隐藏复制按钮。同一段文本不重复复制（清空选区后可再复制）。不 `clearSelection` |

提交路径：鼠标 = 容器 `pointerup`（非 touch）走 `commitSelectionCopy`（`copyMode !== 'auto'` 直接 return）；触摸 = 手势机 `endTouchSelection` 上的 `onSelectionCommitted`。`copy` 事件与 Cmd/Ctrl+C 是快捷键路径，**不看** `copyMode`。多 node 共用同一份 UI store（`storagePrefix: ''` → `vibeterm-ui`）。划选即进剪贴板时优先查用户是否按了快捷键、本机/IME 划选复制，或 tmux OSC 52（均与此开关无关）。

## 测试

- 单测：`virtualKeyboard`（`computeCursorFollowOffset` 边界）、`tap-focus`、`gesture-machine`（画布轻点压序列、滚动不压、工具条放行 / 命中工具条不 arm 长按、光标行 ±1 聚焦、滚回历史不聚焦、上报模式点光标行既发字节又聚焦）、`selection-anchor` / `selection-toolbar-action`、`terminal-input-focus`、`terminal-pointer-handlers`、`TerminalHideKeyboardButton` 首帧形态。
- e2e：`mobile-keyboard-avoidance.spec.ts`（三模式 DOM 契约）、`mobile-terminal-interactions.spec.ts`（挂载不聚焦 → 点远离光标的行不聚焦 → 点光标行聚焦且按钮出现 → 键盘弹着时点别的行焦点不丢 → 点「隐藏键盘」收起）。行坐标在页内按 `lastCursor` + `.xterm-screen` 实算，不写死行号。
