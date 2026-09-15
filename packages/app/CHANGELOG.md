# 2.6.0

_2026-09-15_

## English

### Changes

- Share → Log replay: the recording is now scaled to fit the replay window. A session recorded on a phone (for example 52×47) fills the height of the dialog on a desktop and stays centred with side bands; a very wide recording is shrunk to fit as far as it stays readable, then scrolls as before. The replay window is taller and wider on large screens, and it only appears once it is already fitted.

### Fixes

- Share → Log replay: recordings no longer come out garbled when the terminal was resized after sharing started (for example shared from a phone, then opened on a desktop). The recorder now records the real terminal size whenever tmux changes it, not just when a guest resized it; zoomed panes record the zoomed size. Recordings made before this version cannot be repaired — they do not contain the size changes.

---

## 中文

### 变更

- 分享 → 日志回放：录像现在会按回放窗自动缩放。手机上录的会话（如 52×47）在桌面上按对话框高度放大、居中显示、两侧留衬底；特别宽的录像在保持可读的前提下缩小，仍放不下时照旧可以拖动查看。大屏上的回放窗更高更宽，并且只在已适配好之后才出现。

### 修复

- 分享 → 日志回放：分享开始后终端尺寸变过（如手机上分享、之后在桌面打开）的录像不再错位。录制器现在在 tmux 每次改尺寸时都记录真实终端尺寸，而不只是访客改尺寸时；放大（zoom）的窗格按放大后的尺寸记录。本版本之前的录像无法修复——日志里没有尺寸变化信息。
