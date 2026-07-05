# 0.17.0

_2026-07-05_

## English

### New

- Full mouse support in terminal apps (vim, opencode, htop…):
  - Hold **Shift and drag** to select and copy text even while the app is capturing the mouse.
  - **Touch gestures on mobile**: tap to click, drag with one finger, scroll with two fingers.
  - Hover tracking and horizontal (trackpad) scrolling now reach apps that support them.
- File paths printed in the terminal are clickable and open directly in the file preview.
- The AI agent's web search now supports multiple search providers.
- Notification channels can be enabled or disabled individually.
- The listen address of the service (bind host) is now configurable.

### Fixes

- Mouse clicks and drags inside terminal apps landed one row off on Retina/HiDPI displays.
- After refreshing the page or switching windows, terminal apps stopped responding to mouse drags; mouse modes are now restored accurately.
- Terminal contents could go blank or shift by one line after switching windows, or misalign when another device resized the session.

### Improvements

- Smoother and lighter mouse dragging in terminal apps (redundant events are no longer sent).
- UI polish and internal improvements.

---

## 中文

### 新增

- 终端应用（vim、opencode、htop 等）的完整鼠标支持：
  - 按住 **Shift 拖拽**即可在鼠标被应用接管时选择并复制文本。
  - **移动端触摸手势**：单击点按、单指拖拽、双指滚动。
  - 支持悬停跟踪与触控板横向滚动的应用现在能收到对应事件。
- 终端里输出的文件路径可以直接点击，跳转到文件预览。
- AI Agent 的联网搜索支持多个搜索服务商。
- 通知渠道可以逐个开启或关闭。
- 服务监听地址（bind host）可配置。

### 修复

- Retina/高分屏下终端应用内的鼠标点击与拖拽位置偏移一行。
- 刷新页面或切换窗口后，终端应用不再响应鼠标拖拽；现在会准确恢复鼠标模式。
- 切换窗口后终端内容可能空白或错位一行，以及另一台设备调整会话尺寸后画面错位的问题。

### 改进

- 终端应用内的鼠标拖拽更流畅、更省资源（不再发送冗余事件）。
- 界面细节优化与内部改进。
