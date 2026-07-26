# 1.0.2

_2026-07-27_

## English

### Highlights

- tmex is now ready for its first stable 1.0 release, with a more reliable terminal experience across desktop and mobile.
- Terminal output, screen recovery, resizing, mouse reporting, split panes, and input handling now remain consistent during reconnects and heavy activity.
- The managed gateway is ready for standalone use, with improved health monitoring, bounded recovery work, dynamic endpoints, and support for Windows psmux runtimes.

### Features

- Added real-time updates for devices, sessions, windows, and panes.
- Added a default local device on fresh installations and clearer device naming based on the host name.
- Added configurable terminal file links, host-controlled page titles, injectable host services, and reusable device, console, and management panels.
- Added capability negotiation and pluggable WebSocket transports for embedded hosts.
- Improved the Files and Settings experience with grouped device sources, file-root update notifications, optional headers, and runtime feature flags for Files and Watch.
- Added mobile-friendly navigation and interactions for terminal, settings, device, agent, file, and watch panels.
- Added support for disabling selected notification channels and for host-managed notifications.

### Reliability and fixes

- Fixed the Settings file-roots page crash caused by sharing incompatible cached data with the sidebar.
- Improved terminal recovery across alternate screens, blank lines, reconnects, chunked history, remote resizing, pane moves, and stale selections.
- Improved mouse and touch behavior, including modifier-key handling, coordinate mapping, dragging, wheel input, and mobile gestures.
- Improved theme behavior, including CJK font fallbacks and preset overrides.
- Improved connection lifecycle handling, session health, device ordering, and clean shutdown behavior.

### Performance

- Reduced terminal latency by prioritizing the tmux control channel for input.
- Reduced rendering and network overhead with bounded history recovery, output batching, metadata coalescing, and protection for slow clients.

## 中文

### 版本亮点

- tmex 首次进入稳定版 1.0，桌面端和移动端的终端使用体验更加可靠。
- 终端输出、屏幕恢复、尺寸同步、鼠标操作、分屏和输入处理在重连及高负载场景下更加稳定。
- 托管网关已经支持独立运行，并增强了健康检查、故障恢复、动态端点和 Windows psmux 运行时支持。

### 新功能

- 新增设备、会话、窗口和面板的实时状态更新。
- 全新安装时自动创建本地设备，并根据主机名提供更清晰的默认设备名称。
- 支持配置终端文件链接、由宿主控制页面标题、注入宿主服务，以及复用设备、控制台和设备管理面板。
- 支持能力协商和可插拔 WebSocket 传输，便于集成到宿主应用。
- 文件和设置页面支持按设备分组、文件根目录变更通知、可选页面头部，以及 Files 和 Watch 功能开关。
- 优化移动端导航，并完善终端、设置、设备、Agent、文件和 Watch 面板的触控操作。
- 支持关闭指定通知渠道，并支持由宿主应用统一管理通知。

### 稳定性与修复

- 修复设置页文件根目录与侧边栏复用不同缓存数据导致的页面崩溃。
- 改善备用屏幕、空行、重连、分段历史、远程调整尺寸、面板移动和过期选择状态下的终端恢复。
- 改善鼠标和触控操作，包括修饰键、坐标映射、拖拽、滚轮和移动端手势。
- 修复主题相关问题，补充中文字体回退并确保预设样式正确生效。
- 改善连接生命周期、会话健康状态、设备顺序和退出清理。

### 性能

- 输入优先通过 tmux 控制通道发送，降低终端输入延迟。
- 通过限制历史恢复规模、合并输出、合并状态更新和隔离慢客户端，降低渲染与网络开销。
