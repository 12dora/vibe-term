# 0.16.3

_2026-07-04_

## English

### Features

- **Theme sync across devices**: Dark/light theme is now persisted server-side and broadcast to all connected web clients and devices in real time. Switching theme on one browser instantly updates every other open tab and remote SSH device. TUI coding agents (OpenCode, Codex, Claude Code) detect the correct theme on startup via tmux's native OSC 11 color query response.

### Bug Fixes

- **Split-pane selection cleared by opposite pane output**: When one pane continuously outputs text (e.g. a running build), selecting text in another pane no longer gets immediately cleared. The terminal resize logic now skips unnecessary selection resets when pane dimensions haven't changed.

---

## 中文

### 新功能

- **跨设备主题同步**：dark/light 主题现在持久化在服务端，并实时广播给所有已连接的网页客户端和设备。在一个浏览器上切换主题，其他所有标签页和远程 SSH 设备会立即同步。终端内的 Coding Agent（OpenCode、Codex、Claude Code）启动时能通过 tmux 原生 OSC 11 颜色查询正确探测当前主题。

### Bug 修复

- **分屏对端输出时选中文字被清空**：当一个 pane 持续输出文本（如正在运行的构建），在另一个 pane 中选取文字不再被立即清空。终端 resize 逻辑现在在 pane 尺寸未变时跳过不必要的 selection 重置。