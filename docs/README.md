# 文档索引

本文件是 `docs/` 的稳定入口。文件名带日期编号只是归档约定，**不要靠日期找文档**——从这里的表格进。

新增文档按模块放进对应目录（没有就新建），文件名 `<日期><编号>-<英文短语>.md`，并回来补一行。
规范见仓库根 `AGENTS.md`。产品层面的介绍看仓库根 `README.md`，不在 `docs/` 里重复。

目录顺序：**上手与部署 → 架构（mesh / 协议 / 终端 / agent）→ 功能模块 → 运维与工程（运维 / 性能 /
测试 / 发版 / 更新 / 环境）→ 已知问题**。

## 上手与部署

| 路径 | 用途 |
| --- | --- |
| `deployment/2026021000-production-install.md` | 生产部署：一键安装、launchd / systemd 用户服务、env 与数据目录、HTTPS 反代、备份、升级与排障 |
| `deployment/2026061400-process-survival.md` | tmex 崩溃 / 重启时 tmux 进程的存活边界（`KillMode=process`、`AbandonProcessGroup`、linger） |
| `env/2026061301-three-tier-env.md` | development / test / production 三套环境的加载规则与变量清单 |
| `onboarding/2026083101-connect-devices-panel.md` | 「接入更多设备」面板（移动端选地址→扫码、服务器接入）与远程访问入口 |

## 架构：多节点 mesh

| 路径 | 用途 |
| --- | --- |
| `hub/2026082700-hub-node-architecture.md` | hub / node mesh 架构设计：身份与 key-log、链路多路复用、直连与中继、失陷边界 |
| `hub/2026082800-hub-node-operations.md` | hub / node 运维：角色装配、加入与吊销、登录与 passkey、环境变量、直连排障 |
| `hub/2026090104-multi-hub-standby.md` | 多 hub 主 / 备：writer 选举、fencing、写入转发、跨 hub relay、切换手册 |
| `hub/2026090301-site-settings-node-linkage.md` | 站点名 / 访问地址与 mesh 节点身份联动：有效地址、写保护、双向同步 |
| `hub/2026090305-peer-endpoint-backoff.md` | 直连地址负向缓存与退避、LAN 预算、拨号并发、广播端网卡过滤 |
| `hub/2026090306-rtc-dial-breaker.md` | WebRTC DataChannel 熔断：阈值、冷却阶梯、强制探测、`dcBreaker` 字段 |
| `hub/2026090502-rtc-signaling-epoch-link-liveness.md` | 直连信令代次、ICE 配置、链路活性与在途流保护（1.1.31） |
| `hub/2026082801-hub-docker-e2e.md` | Docker 多容器 hub/node 实测 harness（单机 compose 与远端分体拓扑） |
| `hub/2026090402-docker-node.md` | 可升级的 tmex 节点容器：容器内自装、事务式升级、看护循环 |
| `relay/2026090304-relay-role.md` | 公共中继（relay）角色实现参考：盲中继协议、租户密钥、接口、CLI 与运维 |
| `relay/2026090403-relay-metrics.md` | `GET /api/relay/metrics`：采样口径、字段来源与设置页可视化 |
| `relay/2026090501-relay-mgmt-switch-usage.md` | 中继管理页、手动切换中继、三档配额实时用量与当前错误语义 |

## 架构：WebSocket 协议

| 路径 | 用途 |
| --- | --- |
| `ws-protocol/2026021402-ws-borsh-v1-spec.md` | `tmex-ws-borsh-v1` wire 格式唯一真源：kind 编号、payload schema、作废号段、能力协商 |
| `ws-protocol/2026021403-ws-state-machines.md` | 两端状态机规范：连接、设备、canonical 首屏 / 订阅 / resize / bell / feed，附 selectToken 屏障的历史对应 |
| `ws-protocol/2026070402-site-theme-update.md` | `KIND_SITE_THEME_UPDATE` 站点主题跨端广播与 last-writer-wins |

## 架构：终端

| 路径 | 用途 |
| --- | --- |
| `terminal/2026041600-ghostty-wasm-runtime.md` | Ghostty wasm 终端底座：分层、初始化、输入 / 输出 / 渲染链路与 xterm 兼容面 |
| `terminal/2026090101-viewport-policy.md` | 终端视口策略：最小可见客户端拥有 PTY 尺寸 |
| `terminal/2026061501-mobile-keyboard-behavior.md` | 移动端三种键盘避让模式（lift / resize / follow）与光标跟随算法 |
| `terminal/2026061101-claude-code-osc-notification.md` | Claude Code 各通知渠道的 OSC 序列与 `TERM=xterm-ghostty` 注入 |
| `terminal/2026070501-tui-theme-notify-2031.md` | 经 DEC mode 2031 向 pane 内 TUI 注入主题变更通知 |
| `terminal/2026090304-ws-latency-measurement.md` | 延迟徽标的测量口径：心跳 nonce / 中位数、网关 PONG 优先通道与 `[ws-metrics] ping` |

## 架构：终端 AI Agent

| 路径 | 用途 |
| --- | --- |
| `agent/2026061300-terminal-agent-overview.md` | Agent 总览：数据模型、REST/WS 接口分工、消息队列、事件流、生命周期与已知限制 |
| `agent/2026061302-system-prompt-and-credential-handling.md` | 类 JSX system prompt 模板、环境注入、注入防护与出站 LLM 凭证消毒 |
| `agent/2026061303-run-command-headless-ghostty.md` | `run_command` 工具与服务端 headless ghostty per-pane 模拟器 |

## 功能模块

| 路径 | 用途 |
| --- | --- |
| `device-tree/2026061400-reorder.md` | 设备 / 窗口 / pane 的拖拽排序与服务端顺序持久化（经 canonical metadata 下发） |
| `files/2026061500-transfer-progress-chunked.md` | 分块上传、两阶段进度与速度、取消、2GB 上限、上传路径安全与临时文件清理 |
| `files/2026090101-files-sidebar-visibility-default.md` | 文件侧栏的可见性缺省与竖向拖拽 |
| `watch/2026061300-watch-monitor-overview.md` | Watch 规则模型、调度、三种触发（正则 / 不变 / LLM）与 API |
| `notify/2026062000-weixin-clawbot-channel.md` | 微信（iLink / ClawBot）渠道：扫码登录、用户授权、半主动推送语义与 API |
| `messaging/2026090402-messaging-command-template.md` | 平台无关的消息命令层（Telegram / 微信）：解析、授权、命令表与新平台适配 |
| `frontend/2026070800-workspace-packages.md` | workspace 包清单与出口、依赖方向、Connection / Runtime 两层工厂与嵌入用法 |
| `frontend/2026090307-app-error-boundary.md` | 路由 `errorElement` / 面板级错误边界 / 懒加载 chunk 重试 |
| `fonts/2026061501-font-pipeline.md` | Nerd Fonts 精选清单、woff2 构建工具链、动态 manifest 与运行时懒加载 |

## 运维排障

| 路径 | 用途 |
| --- | --- |
| `operations/2026021200-db-key-mismatch-journald.md` | 数据库复制后 master key 不匹配的启动失败排障与 journald 日志配置 |
| `operations/2026090101-public-login-hardening.md` | 公网登录面：客户端 IP 判定、首次 bootstrap 本机限制与未登录面的资源上限 |
| `operations/2026090101-public-login-security-review.md` | 公网启用账号密码登录的安全评估：现有机制、处置清单与「明确不做的事」 |
| `operations/2026090201-passkey-second-factor-opaque-login.md` | 登录失败模糊化与通行密钥二次验证 |
| `operations/2026090304-passkey-trusted-local-source-waiver.md` | 本机 / 内网 / CGNAT 源地址免通行密钥二次验证：判定、入口打标、安全边界 |
| `operations/2026090302-domain-access-policy.md` | 按节点的「允许域名访问」开关：拦截规则、服务白名单、锁死自救 |
| `operations/2026090201-effective-https-status.md` | HTTPS 设置区「对外有效 HTTPS」的判定与展示 |
| `operations/2026090303-acme-dns-providers.md` | ACME dns-01 提供商抽象（Cloudflare / DNSPod）与非标端口 HTTPS 配置 |
| `operations/2026090502-tunnel-fake-ip-edge-bypass.md` | 隧道边缘 fake-IP 绕行：DoH 解析真实边缘、`--edge` 静态模式与排查法 |

## 性能

| 路径 | 用途 |
| --- | --- |
| `performance/2026082700-hot-path-optimizations.md` | 热路径优化实测：解析器零拷贝、retention 增量记账、帧精确尺寸、渲染桥行级 dirty、history 分页、DB 索引，及 Rust/WASM 移植评估 |
| `performance/2026090502-fe-smoothness-ws-reconnect.md` | 前端流畅度（页面模块缓存、chunk 预热、`content-visibility`、vendor 分包）与浏览器 WS 重连韧性 |
| `performance/2026083101-settings-tabs-latency.md` | 设置页各 tab 加载慢的根因与处置 |
| `performance/2026090101-static-cache-policy.md` | 打包前端静态资源的缓存策略 |

## 测试

| 路径 | 用途 |
| --- | --- |
| `testing/2026061302-live-integration-tests.md` | 打真实 endpoint 的 live integration 测试约定与凭证守卫 |

## 发版与更新

| 路径 | 用途 |
| --- | --- |
| `release/2026041300-cli-release-process.md` | `tmex-cli` 发布流程：版本注入、全量构建、校验、打 tag 触发 Actions |
| `release/2026061406-release-changelog-flow.md` | `scripts/release.ts` 的双语 changelog 生成与 agent 改写规范 |
| `release/2026083101-github-releases-distribution.md` | 发行源切换到本仓库 GitHub Releases 与 `install.sh` |
| `release/2026083101-upgrade-crash-safety.md` | 自升级的 BIOS 式事务：落地布局、阶段与崩溃表、回滚与修复 |
| `update/2026061406-self-update.md` | 程序内自更新状态机、`canSelfUpdate` 判定与版本展示 |
| `update/2026061502-bun-path-resolution.md` | bun 路径解析：优先级、`TMEX_BUN_PATH`、路径消毒与超时 |
| `update/2026090502-resumable-remote-upgrade-push.md` | 远程升级推包续传：偏移协议、`.part` 生命周期、重试预算与前端进度 |

## 已知问题

| 路径 | 用途 |
| --- | --- |
| `known-issues.md` | 尚未解决的已知问题登记簿（含 e2e 抖动基线）。解决后从中移除 |
