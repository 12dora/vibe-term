# 2.21.0

_2026-11-28_

## English

### New Features

- **Click links printed by coding agents**: links from Claude Code, Codex and other tools that mark up links (OSC 8 hyperlinks) now open with a plain click, including Markdown links that show only their label and long URLs the tool split across lines — every part opens the full address. Hovering a link whose text differs from its address shows the full address.
- **Plain click opens links**: links open with a single click; dragging still selects text. In apps that use the mouse (such as vim with mouse enabled), clicking plain-text URLs still goes to the app — hold Cmd (macOS) or Ctrl to open them. Shift+click always selects.
- **Tap links on mobile**: tapping a link opens it without bringing up the keyboard.

### Bug Fixes

- **More reliable mouse handling in terminal apps**: pressing several mouse buttons together, or releasing the mouse outside the window, no longer leaves a stuck drag or sends stray clicks to the app.

For terminals on another node, that node needs 2.21.0 for agent links to be clickable.

---

## 中文

### 新功能

- **编码 Agent 输出的链接可直接点击**：Claude Code、Codex 等以 OSC 8 超链接输出的链接，现在单击即可打开，包括只显示标题的 Markdown 链接，以及被工具拆成多行的长网址（点击任意一段都打开完整地址）。悬停在文字与地址不同的链接上会显示完整地址。
- **单击打开链接**：链接单击即开，拖动仍为选择文本。在使用鼠标的程序中（如开启鼠标的 vim），单击纯文本网址仍交给程序处理，按住 Cmd（macOS）或 Ctrl 单击即可打开；Shift+单击始终为选择。
- **移动端轻点打开链接**：轻点链接即打开，不会弹出键盘。

### 问题修复

- **终端程序中的鼠标操作更可靠**：同时按下多个鼠标键，或在窗口外松开鼠标，不再导致拖动卡住或向程序发送多余的点击。

经其他节点访问的终端，该节点需升级到 2.21.0，Agent 输出的链接才可点击。
