# architecture/

系统如何工作。每篇是对应子系统当前实现的规范说明，改动协议、数据模型或安全边界时先改这里。

## 多节点互联

| 文档 | 内容 |
| --- | --- |
| [mesh-architecture.md](./mesh-architecture.md) | 拓扑、身份与鉴权、链路多路复用与载体、paused 本机可见性例外、端口计划、前端多运行时、角色装配、失陷边界 |
| [peer-direct-connect.md](./peer-direct-connect.md) | 直连地址退避、paused 不拨号、WebRTC 熔断、信令代次、`ports` 可达性、失败码 |
| [relay.md](./relay.md) | 公共中继角色的完整参考 |
| [relay-limits-and-metrics.md](./relay-limits-and-metrics.md) | 中继级限额、带宽公平分配、指标接口 |
| [port-mapping.md](./port-mapping.md) | 节点间 TCP 端口映射 |
| [site-settings-node-linkage.md](./site-settings-node-linkage.md) | 站点名 / 访问地址与节点身份联动 |
| [mesh-notification-sink.md](./mesh-notification-sink.md) | 多节点通知汇聚 |
| [agent-remote-pane-grant.md](./agent-remote-pane-grant.md) | 远程 agent 窗格授权 |
| [node-to-node-transfer.md](./node-to-node-transfer.md) | 节点间文件传输 |

## WebSocket 协议

| 文档 | 内容 |
| --- | --- |
| [ws-borsh-v1-spec.md](./ws-borsh-v1-spec.md) | wire 格式唯一真源 |
| [ws-state-machines.md](./ws-state-machines.md) | 两端状态机 |
| [site-theme-broadcast.md](./site-theme-broadcast.md) | 站点主题广播 kind |

## 终端

| 文档 | 内容 |
| --- | --- |
| [ghostty-terminal.md](./ghostty-terminal.md) | Ghostty wasm 终端底座 |
| [terminal-viewport-policy.md](./terminal-viewport-policy.md) | 多客户端 PTY 尺寸仲裁 |
| [terminal-osc-notifications.md](./terminal-osc-notifications.md) | OSC 通知与 Claude Code 渠道 |
| [tui-theme-notify.md](./tui-theme-notify.md) | mode 2031 主题热切换 |
| [ws-latency-badge.md](./ws-latency-badge.md) | 延迟徽标测量口径 |
| [mobile-keyboard.md](./mobile-keyboard.md) | 移动端软键盘避让与唤起 |
| [terminal-share.md](./terminal-share.md) | 终端分享 |
| [device-tree-reorder.md](./device-tree-reorder.md) | 设备树拖拽排序 |
| [file-transfer.md](./file-transfer.md) | 浏览器文件传输：分块上传、流式下载、`POST /api/files/mkdir` 与上传路径安全 |

## Agent、Watch、通知与消息

| 文档 | 内容 |
| --- | --- |
| [terminal-agent.md](./terminal-agent.md) | 终端 AI Agent |
| [watch-monitor.md](./watch-monitor.md) | Watch 屏幕监控 |
| [notifications-weixin-channel.md](./notifications-weixin-channel.md) | 微信通知渠道 |
| [messaging-commands.md](./messaging-commands.md) | 消息指令层 |
