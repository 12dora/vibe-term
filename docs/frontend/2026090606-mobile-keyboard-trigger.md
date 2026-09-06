# 触屏软键盘的唤起入口收敛到输入区

## 背景

移动端 / PWA 上，终端画布里的任意一次轻点都会聚焦 ghostty 的 helper textarea（`.xterm-helper-textarea`），软键盘随之弹出并遮住半屏。而触屏上大量手势只是「看」——滚动 scrollback、长按选词复制、切 pane 后确认内容——每一次都被键盘打断，还会连带触发键盘避让（整页平移 / 光标对齐）。

弹键盘的路径有两条：

- 上报模式（alt-screen TUI）：手势机 `pending` 态的 tap 分支显式调 `terminal.focus()`；
- 非上报模式：手势机不干预 touchend，浏览器随后合成一整套鼠标事件，`click` 命中 ghostty 的 `focusIfEnabled`。

反过来，合成 `mousedown` 的默认动作又会把焦点从 helper textarea 上夺走——键盘弹着时点画布会「闪收」。两者都属于同一类问题：焦点被指针位置隐式决定。

## 行为矩阵

| 环境 | 操作 | 软键盘 | 其他行为 |
|---|---|---|---|
| 桌面（鼠标） | 点终端 | 无 | 聚焦终端可直接输入（不变） |
| 桌面 | 挂载 / 切 pane / editor 切回 direct | 无 | 自动回焦（不变） |
| 触屏 | 轻点终端画布 | 不弹；已弹着也不收 | 无副作用（不起选区、不发鼠标字节） |
| 触屏 | 轻点画布（上报模式 TUI） | 不弹 | 照常发 press+release |
| 触屏 | 单指滑动 / 双指滑动 | 不变 | 滚动 / 平移 / 滚轮上报照旧 |
| 触屏 | 长按 | 不弹 | 本地 word 选择 + 选区工具条 |
| 触屏 | 选区工具条的复制 / 粘贴 / 取消 | 不弹（原先复制完会回焦弹键盘） | 动作本身不变 |
| 触屏 | 点快捷键栏的「显示键盘」 | 弹出 | 按钮转为「隐藏键盘」 |
| 触屏 | 再点一次该按钮 | 收起 | — |

触屏判定沿用既有口径：视口 < 768px 或带触摸能力（`isTouchFirstEnvironment`，与 `useMobileViewport` 同源），因此平板 / 触屏本也走触屏语义，但它们上的**真鼠标点击仍照常聚焦**（见下）。

## 实现点

- `packages/terminal-ui/src/components/touch/tap-focus.ts`（新）：纯判定。`moved=false` 且 touchend 落在 `.xterm` 子树内即视为「画布轻点」，覆盖层（选区工具条、启动占位）上的轻点必须放行，否则其按钮点不动。
- `packages/terminal-ui/src/components/touch/gesture-machine.ts`：
  - `pending`（上报模式 tap）分支删掉 `terminal.focus()`；
  - 新增 `moved` 记账与 `suppressTapSyntheticMouse()`：画布轻点在 touchend 上 `preventDefault` + `noteTouchHandled()`，把整套合成鼠标序列作废——既不聚焦（不弹键盘），也不让默认动作夺走焦点（不闪收）。
- `packages/ghostty-terminal/src/terminal-pointer-handlers.ts`：`click` 监听器补上合成抑制窗口判定（原先只有 `mousedown` 有），且抑制窗口内的 `mousedown` 改为 `preventDefault` 后返回。抑制窗口只由触摸手势置位（500ms），**真鼠标点击不受影响**，桌面与混合设备的鼠标语义不变。
- `packages/terminal-ui/src/utils/terminal-input-focus.ts`（新）：焦点入口统一。`refocusTerminalInput()` 承载全部**隐式**回焦（挂载自动聚焦、分屏切焦点 pane、复制/粘贴/取消选区后回焦），触屏一律跳过；`focusTerminalInput` / `blurTerminalInput` / `isTerminalInputFocused` 供显式入口使用。原先散在三处的 `window.innerWidth < 768 || 'ontouchstart' in window` 内联判定合并到 `isTouchFirstEnvironment()`。
- `packages/panels/src/device-console/terminal-keyboard-button.tsx`（新）：快捷键栏最左侧的软键盘开关，`aria-pressed` 反映当前焦点态（document 上的 focusin/focusout 同步），`onMouseDown` 阻止默认避免按钮自身抢焦点（iOS 上焦点一转移键盘就收）。只在触屏渲染（`TerminalStage` 的 `isMobile`），direct 模式才有（editor 模式本来就有输入框）。
- `packages/panels/src/device-console/terminal-shortcuts-slot.tsx`：`ShortcutsBar` 增 `keyboardToggle`（终端 ref，引用稳定，不破 memo）；有它时即使一条快捷键都没配置也渲染 `.terminal-shortcuts-strip`，键盘避让测量的浮条高度因此始终包含该按钮。
- i18n：`terminal.showKeyboard` / `terminal.hideKeyboard`（zh 源，en/ja 同步）。

## 验收

- 单测：`tap-focus`（轻点/滚动/覆盖层三分支）、`gesture-machine`（画布轻点压序列、滚动不压、工具条放行、上报 tap 不再 focus）、`terminal-input-focus`（环境判定 + 隐式回焦分流）、`terminal-pointer-handlers`（真鼠标聚焦、合成序列不聚焦且吃默认动作、窗口过期恢复）、`TerminalKeyboardButton` 首帧形态。
- e2e（`tests/mobile-terminal-interactions.spec.ts`）：移动端挂载不聚焦 → 轻点画布不聚焦 → 点「显示键盘」聚焦且 `aria-pressed=true` → 键盘弹着时再点画布焦点不丢 → 再点按钮收起。已验证：把抑制分支短路掉，该用例在「轻点画布不聚焦」处失败。
- 回归：`mobile-keyboard-avoidance`、`mobile-mouse-reporting`、`split-screen-mobile`、`terminal-focus`（桌面）、`terminal-ui`、`ws-borsh-resize`、`keyboard-behavior-settings` 全绿。
