# 2.0.4

_2026-09-08_

## English

### Improvements

- Much smoother mouse-wheel and trackpad scrolling inside TUI apps such as Claude Code, especially for panes on remote nodes: scroll events are now paced so the app never drops them, scrolling follows your finger at the app's own speed, and the view stops within a fraction of a second after you stop.
- Scrolling back through a long shell history no longer jumps back to the bottom when older lines are loaded; older history is fetched earlier and in the background, and wide terminals keep their full scrollback.
- Typing into a busy pane (for example while an agent is streaming output) is more responsive.
- Split panes scrolling at the same time no longer fight over the same drawing surface.

### Fixes

- A key pressed right after a scroll gesture (such as Shift+Enter) is now always delivered after the scroll, never before it.
- The floating shortcut bar on mobile stays exactly at the top of the on-screen keyboard again.
- Panes hidden in another tab no longer keep loading history in the background.

---

## 中文

### 改进

- 在 Claude Code 等 TUI 应用里用滚轮 / 触控板滚动明显更顺滑，远端节点上的终端尤其明显：滚动事件按应用能消化的节奏送入，不再被整批丢掉；画面跟手滚动，手指停下后会在很短时间内停住。
- 在很长的 shell 历史里向上翻页时，加载更早内容不再把视口弹回底部；更早的历史会提前在后台取回，宽终端也能保住完整的回滚内容。
- 在忙碌的 pane 里打字（例如 agent 正在持续输出时）响应更快。
- 分屏的两个 pane 同时滚动时不再互相争抢绘制资源。

### 修复

- 滚动手势之后紧接着按下的按键（如 Shift+Enter）现在一定排在滚动之后送达，不会插队。
- 手机端悬浮快捷键栏重新精确贴在软键盘顶部。
- 藏在其他标签页里的 pane 不再在后台持续加载历史。
