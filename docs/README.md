# VibeTerm 文档

本目录是 VibeTerm 的技术文档，面向开发者与运维。产品介绍与安装入门看仓库根 [README.md](../README.md)（英文版 [README.en.md](./README.en.md)），仓库工作约定看根 [AGENTS.md](../AGENTS.md)。

每篇文档开头一句话说明内容与读者；描述的都是**当前已落地的行为**，过程性记录不进这里。改代码影响到文档时同步改文档；新文档按主题放进下面四个目录之一，文件名用描述性 kebab-case 英文，并在该目录的 `README.md` 与本页补一行。

| 目录 | 放什么 |
| --- | --- |
| [`architecture/`](./architecture/README.md) | 系统如何工作：多节点互联（mesh / hub / 中继 / 直连 / 端口映射）、WebSocket 协议与状态机、终端底座与视口、文件传输、分享、Agent、Watch、通知与消息指令 |
| [`operations/`](./operations/README.md) | 部署与运维手册：安装、mesh 与多 hub 运维、容器节点、HTTPS / 端口 / 隧道、进程存活、发版 / 签名 / 升级 / 改名迁移 |
| [`security/`](./security/README.md) | 登录面安全模型与访问策略（mesh 的威胁模型在 `architecture/mesh-architecture.md`） |
| [`development/`](./development/README.md) | 开发与测试：环境变量、前端包结构与外壳行为、性能基准、字体流水线、实测 harness |
| `images/` | 根 README 引用的截图 |
| [`known-issues.md`](./known-issues.md) | 尚未解决的已知问题登记簿；解决后从中移除 |

## 快速定位

- 想搭一台公网入口把多台机器连起来：[部署指南](./operations/production-install.md) → [mesh 运维](./operations/mesh-operations.md) → 需要第二台入口时 [多 hub 主/备](./operations/multi-hub-standby.md)；想给别人提供转发服务：[公共中继角色](./architecture/relay.md)。
- 直连建不起来 / 徽标显示中继：[节点直连](./architecture/peer-direct-connect.md) 与 [mesh 运维「常见排障」](./operations/mesh-operations.md)；放行哪些口：[角色入站端口](./operations/nonstandard-ports.md)。跨境 RTT 差一倍、直连慢于中继：[路径优选](./architecture/path-selection.md)。
- 登录相关（密码、通行密钥、TOTP、限流、公网暴露）：[登录面安全](./security/login-security.md)。
- 发一个版本：[发布流程](./operations/release-process.md) → [发行包签名](./operations/release-signing.md)；升级出问题：[升级事务](./operations/upgrade-transaction.md)。
- 改 WebSocket 协议：[ws-borsh v1 规范](./architecture/ws-borsh-v1-spec.md) 与 [状态机](./architecture/ws-state-machines.md)。
- 起开发环境 / 写测试：[三套环境](./development/environments.md)、[实测约定](./development/live-integration-tests.md)；改共享口径先看 [单一上游](./development/code-conventions.md)。
- 在终端里用 `vibeterm`（登录、接进别的机器、让 AI agent 跑命令）：[命令行使用手册](./operations/cli-usage.md)。
- 给 `vibeterm` 加客户端命令：[客户端 CLI 架构](./development/cli-architecture.md)。

## 全部文档

### architecture/

| 文档 | 内容 |
| --- | --- |
| [mesh-architecture.md](./architecture/mesh-architecture.md) | 多节点互联架构：拓扑、用户自持根钥与密钥日志、节点证书、链路多路复用、paused 本机可见性例外、端口计划、角色装配、失陷边界 |
| [peer-direct-connect.md](./architecture/peer-direct-connect.md) | 节点直连：地址退避、paused 不拨号、WebRTC 熔断、信令代次、`ports` 可达性、失败码与链路信息窗 |
| [path-selection.md](./architecture/path-selection.md) | 路径优选与选路模式：智能 / 直连 / 中继、滞环与升回、重掷协议、五元组 ECMP、WS 开链竞速、上行 `path-rerace` |
| [relay.md](./architecture/relay.md) | 公共中继角色：盲中继协议、租户密钥、密钥日志记录、加入串与密码加入、存储、HTTP / uplink 接口、CLI 与网页、运维、边界、令牌换发 |
| [relay-limits-and-metrics.md](./architecture/relay-limits-and-metrics.md) | 中继运营限额（租户数、总带宽、公平分配、单文件上限）与 `/api/relay/metrics` |
| [port-mapping.md](./architecture/port-mapping.md) | 端口映射：node A 的 TCP 监听经 peer 流复用器隧道到 node B |
| [site-settings-node-linkage.md](./architecture/site-settings-node-linkage.md) | 站点名 / 访问地址与 mesh 节点身份联动 |
| [ws-borsh-v1-spec.md](./architecture/ws-borsh-v1-spec.md) | `vibeterm-ws-borsh-v1` wire 格式的唯一真源：kind 编号、payload schema、作废号段、能力协商 |
| [ws-state-machines.md](./architecture/ws-state-machines.md) | 两端状态机：连接、设备、canonical 首屏 / 订阅 / resize / bell / feed，附屏障历史对应 |
| [site-theme-broadcast.md](./architecture/site-theme-broadcast.md) | `KIND_SITE_THEME_UPDATE` 站点主题跨端广播 |
| [ghostty-terminal.md](./architecture/ghostty-terminal.md) | Ghostty wasm 终端底座：分层、初始化、输入 / 输出 / 渲染链路、xterm 兼容面 |
| [terminal-viewport-policy.md](./architecture/terminal-viewport-policy.md) | 终端视口策略：最小可见客户端拥有 PTY 尺寸 |
| [terminal-osc-notifications.md](./architecture/terminal-osc-notifications.md) | 终端 OSC 通知序列与 Claude Code 渠道、`TERM=xterm-ghostty` 注入 |
| [tui-theme-notify.md](./architecture/tui-theme-notify.md) | 经 DEC mode 2031 向 pane 内 TUI 注入主题变更通知 |
| [ws-latency-badge.md](./architecture/ws-latency-badge.md) | 延迟徽标的测量口径与毛刺排查 |
| [mobile-keyboard.md](./architecture/mobile-keyboard.md) | 移动端软键盘：避让三模式与唤起入口 |
| [device-tree-reorder.md](./architecture/device-tree-reorder.md) | 设备 / 窗口 / pane 拖拽排序与顺序持久化 |
| [file-transfer.md](./architecture/file-transfer.md) | 浏览器文件传输：分块上传、流式下载、进度、取消、`POST /api/files/mkdir` 建目录与路径安全 |
| [node-to-node-transfer.md](./architecture/node-to-node-transfer.md) | 节点间文件传输：一次性授权、协议、限制与清理 |
| [terminal-share.md](./architecture/terminal-share.md) | 终端分享：数据模型、接口、凭证与 ws 隔离、录制回放、安全边界 |
| [terminal-agent.md](./architecture/terminal-agent.md) | 终端 AI Agent：数据模型、接口、生命周期、系统提示词、终端工具与 `run_command`、凭证处理 |
| [agent-remote-pane-grant.md](./architecture/agent-remote-pane-grant.md) | 远程窗格授权：`/api/mesh-internal/tmux/*` 的按窗格授权 |
| [watch-monitor.md](./architecture/watch-monitor.md) | Watch 规则模型、三种触发、LLM 介入点、调度 |
| [notifications-weixin-channel.md](./architecture/notifications-weixin-channel.md) | 微信（iLink）通知渠道 |
| [mesh-notification-sink.md](./architecture/mesh-notification-sink.md) | 多节点通知汇聚 |
| [messaging-commands.md](./architecture/messaging-commands.md) | 平台无关的消息指令层（Telegram / 微信） |

### operations/

| 文档 | 内容 |
| --- | --- |
| [ai-deploy.md](./operations/ai-deploy.md) | AI 助手部署指南：按场景（独立 / Hub / 中继 × 公网域名 / 端口转发 / Cloudflare Tunnel）给出可直接执行的步骤、验收与排障速查，以及 agent 用 CLI 调试别的节点 |
| [production-install.md](./operations/production-install.md) | 生产部署：安装、服务与日志、HTTPS 反代、升级、SSH 设备、备份、排障 |
| [mesh-operations.md](./operations/mesh-operations.md) | mesh 运维：角色矩阵、延迟优化、节点表、环境变量、搭 hub、加入 / 吊销、账号安全、直连、反代、灾难恢复、排障表 |
| [multi-hub-standby.md](./operations/multi-hub-standby.md) | 多 hub 主 / 备：同步、跨 hub relay、failover、写入围栏、promote / demote 手册 |
| [docker-node.md](./operations/docker-node.md) | 可升级的容器节点 |
| [nonstandard-ports.md](./operations/nonstandard-ports.md) | 按角色列出应放行的 TCP/UDP 口；80/443 不可用时的 HTTPS 候选与探测 |
| [https-and-acme.md](./operations/https-and-acme.md) | 对外有效 HTTPS 判定、ACME dns-01 提供商（Cloudflare / DNSPod）、80/443 被占场景 |
| [tunnel-edge-fake-ip.md](./operations/tunnel-edge-fake-ip.md) | Cloudflare Tunnel 边缘与 ICE STUN/TURN 的 fake-IP 绕行与排查 |
| [tmux-process-survival.md](./operations/tmux-process-survival.md) | 服务 kill 策略、linger、tmux 3.6 pane scope 与 systemd OOMPolicy |
| [troubleshooting-db-master-key.md](./operations/troubleshooting-db-master-key.md) | 数据库与 `VIBETERM_MASTER_KEY` 不匹配的启动失败 |
| [release-process.md](./operations/release-process.md) | 发版手册：发行源、版本注入、changelog 改写规范、构建、校验、打 tag |
| [release-signing.md](./operations/release-signing.md) | 发行包 Ed25519 签名：密钥轮换、校验点、兼容矩阵 |
| [upgrade-transaction.md](./operations/upgrade-transaction.md) | 崩溃安全的升级事务：布局、阶段与崩溃表、修复 |
| [self-update.md](./operations/self-update.md) | 程序内自更新：版本注入、`canSelfUpdate`、状态机、发行包缓存与租约 |
| [remote-upgrade.md](./operations/remote-upgrade.md) | 远程升级：三通道投递、推包续传与进度 |
| [bun-path-resolution.md](./operations/bun-path-resolution.md) | CLI 的 bun 路径解析与 `run.sh` 约束 |
| [cli-usage.md](./operations/cli-usage.md) | `vibeterm` 客户端命令行使用手册：登录与登出、目标语法、tmux 结构、像 ssh 一样接进任意节点的终端、AI agent 会话与 run / capture / send、节点 / 设置 / 文件 / 设备命令、安全边界与退出码 |
| [rename-migration.md](./operations/rename-migration.md) | tmex → VibeTerm 改名迁移：命名表、冻结值、兼容桥、目录迁移、升级手册 |

### security/

| 文档 | 内容 |
| --- | --- |
| [login-security.md](./security/login-security.md) | 登录失败模糊化、客户端 IP 与 bootstrap、二次验证「TOTP 或本 origin 通行密钥」二选一（按 origin + 本地豁免）、TOTP 限流与防重放、公网安全评估 |
| [domain-access-policy.md](./security/domain-access-policy.md) | 按节点的「允许域名访问」开关 |

### development/

| 文档 | 内容 |
| --- | --- |
| [environments.md](./development/environments.md) | development / test / production 三套环境与 `loadEnv()` |
| [cli-architecture.md](./development/cli-architecture.md) | 客户端 CLI（`packages/cli`）的模块契约：命令组怎么加、ctx 形状、退出码、会话文件、与安装版二进制的接线、复杂度门禁 |
| [code-conventions.md](./development/code-conventions.md) | 单一上游与派生约定：节点展示、设置标签、确认框、契约、消息通道、环境解析、探测循环 |
| [workspace-packages.md](./development/workspace-packages.md) | 前端 workspace 包结构、两层工厂与嵌入用法 |
| [app-error-boundary.md](./development/app-error-boundary.md) | 路由 / 面板级错误边界与 chunk 重试 |
| [sidebar-node-first-paint.md](./development/sidebar-node-first-paint.md) | 冷启动侧栏节点首屏：占位、缓存（含 paused）、门闸认 stale `loggedIn`、前台拨号竞速 |
| [files-sidebar-visibility.md](./development/files-sidebar-visibility.md) | 文件侧栏可见性缺省与纵向拖拽 |
| [connect-devices-panel.md](./development/connect-devices-panel.md) | 「接入更多设备」面板、放行端口步与远程访问向导 |
| [font-pipeline.md](./development/font-pipeline.md) | 终端字体打包流水线 |
| [performance-hot-paths.md](./development/performance-hot-paths.md) | 热路径优化、基准脚本与 Rust / WASM 评估 |
| [performance-frontend.md](./development/performance-frontend.md) | 前端流畅度、WS 重连、设置页加载、静态资源缓存 |
| [live-integration-tests.md](./development/live-integration-tests.md) | 打真实 endpoint 的实测约定 |
| [relay-live-harness.md](./development/relay-live-harness.md) | 中继三进程实测主管 |
| [hub-docker-e2e.md](./development/hub-docker-e2e.md) | Docker 多容器 hub/node 实测 harness |
