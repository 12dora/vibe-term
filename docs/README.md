# 文档索引

本文件是 `docs/` 的稳定入口。文件名带日期编号是归档约定，**不要靠日期找文档**——从这里的表格进。

新增文档请按模块放进对应目录（没有就新建），文件名 `<日期><编号>-<英文短语>.md`，并回来补一行。规范见仓库根 `AGENTS.md`。

## 根目录

| 路径 | 用途 |
| --- | --- |
| `docs/known-issues.md` | 尚未解决的已知问题登记簿（含 fe e2e 固定失败基线）。解决后从中移除 |

## 2026021000-tmex-bootstrap —— 部署

| 路径 | 用途 |
| --- | --- |
| `2026021000-tmex-bootstrap/deployment.md` | 生产部署：npm 包安装、launchd / systemd 用户服务、env 与数据目录、升级与回滚 |

## agent —— 终端 AI Agent

| 路径 | 用途 |
| --- | --- |
| `agent/2026061300-terminal-agent-overview.md` | Agent 总览：数据模型、REST/WS 接口分工、消息队列、事件流、已知限制 |
| `agent/2026061302-system-prompt-and-credential-handling.md` | 类 JSX system prompt 模板、环境注入、注入防护与出站 LLM 凭证消毒 |
| `agent/2026061303-run-command-headless-ghostty.md` | `run_command` 工具与服务端 headless ghostty per-pane 模拟器 |

## appearance —— 外观与主题

| 路径 | 用途 |
| --- | --- |
| `appearance/2026070501-tui-theme-notify-2031.md` | 经 DEC mode 2031 向 pane 内 TUI 注入主题变更通知 |

## device-tree —— 设备树

| 路径 | 用途 |
| --- | --- |
| `device-tree/2026061400-reorder.md` | 设备/窗口/pane 的拖拽排序与服务端顺序持久化 |

## env —— 环境配置

| 路径 | 用途 |
| --- | --- |
| `env/2026061301-three-tier-env.md` | development / test / production 三套环境的加载规则与变量清单 |

## files —— 文件浏览与传输

| 路径 | 用途 |
| --- | --- |
| `files/2026061500-transfer-progress-chunked.md` | 分块上传、两阶段进度与速度、取消、2GB 上限、上传路径安全与临时文件清理 |
| `files/2026090101-files-sidebar-visibility-default.md` | 文件侧栏的可见性缺省与竖向拖拽 |

## fonts —— 字体

| 路径 | 用途 |
| --- | --- |
| `fonts/2026061501-font-pipeline.md` | Nerd Fonts 精选清单、woff2 构建工具链、动态 manifest 与运行时懒加载 |

## frontend —— 前端结构

| 路径 | 用途 |
| --- | --- |
| `frontend/packages.md` | workspace 包清单与出口、依赖方向、Connection/Runtime 两层工厂与嵌入用法 |
| `frontend/2026090307-app-error-boundary.md` | 路由 `errorElement` / 面板级错误边界 / 懒加载 chunk 重试 |

## hub —— 多节点 mesh

| 路径 | 用途 |
| --- | --- |
| `hub/2026082700-hub-node-architecture.md` | hub / node mesh 架构设计：身份与 key-log、载体分级、直连与中继、失陷边界 |
| `hub/2026082800-hub-node-operations.md` | hub / node 运维：角色装配、加入与吊销、登录与 passkey、直连排障 |
| `hub/2026082801-hub-docker-e2e.md` | Docker 多容器 hub/node 实测 harness |
| `hub/2026090104-multi-hub-standby.md` | 多 hub 主/备：writer 选举、fencing、切换 |
| `hub/2026090301-site-settings-node-linkage.md` | 站点名 / 访问地址与 mesh 节点身份联动：有效地址、写保护、双向同步 |
| `hub/2026090305-peer-endpoint-backoff.md` | 直连地址负向缓存与退避、LAN 预算、拨号并发、广播端网卡过滤 |
| `hub/2026090306-rtc-dial-breaker.md` | WebRTC DataChannel 熔断：阈值、冷却阶梯、强制探测、`dcBreaker` 字段 |

## notify —— 通知渠道

| 路径 | 用途 |
| --- | --- |
| `notify/2026062000-weixin-clawbot-channel.md` | 微信（iLink / ClawBot）渠道：扫码登录、用户授权、半主动推送语义与 API |

## onboarding —— 上手引导

| 路径 | 用途 |
| --- | --- |
| `onboarding/2026083101-connect-devices-panel.md` | 「接入更多设备」面板（移动端选地址→扫码、服务器接入）与远程访问入口 |

## operations —— 运维排障

| 路径 | 用途 |
| --- | --- |
| `operations/2026021200-db-key-mismatch-journald.md` | 数据库复制后 master key 不匹配的启动失败排障与 journald 日志配置 |
| `operations/2026090101-public-login-hardening.md` | 公网登录面：客户端 IP 判定与首次 bootstrap 本机限制 |
| `operations/2026090101-public-login-security-review.md` | 公网启用账号密码登录的安全评估 |
| `operations/2026090201-effective-https-status.md` | HTTPS 设置区「对外有效 HTTPS」的判定与展示 |
| `operations/2026090201-passkey-second-factor-opaque-login.md` | 登录失败模糊化与通行密钥二次验证 |
| `operations/2026090302-domain-access-policy.md` | 按节点的「允许域名访问」开关：拦截规则、服务白名单、锁死自救 |
| `operations/2026090303-acme-dns-providers.md` | ACME dns-01 提供商抽象（Cloudflare / DNSPod）与非标端口 HTTPS 配置 |
| `operations/2026090304-passkey-trusted-local-source-waiver.md` | 本机 / 内网 / CGNAT 源地址免通行密钥二次验证：判定、入口打标、安全边界 |

## performance —— 性能

| 路径 | 用途 |
| --- | --- |
| `performance/2026082700-hot-path-optimizations.md` | 热路径优化实测：解析器零拷贝、retention 增量记账、帧精确尺寸、渲染桥缓存、history 分页、DB 索引，及 Rust/WASM 移植评估 |
| `performance/2026083101-settings-tabs-latency.md` | 设置页各 tab 加载慢的根因与处置 |
| `performance/2026090101-static-cache-policy.md` | 打包前端静态资源的缓存策略 |

## product —— 产品

| 路径 | 用途 |
| --- | --- |
| `product/2026062400-prd.md` | 产品需求文档：功能面、接口面、页面面与版本状态 |
| `product/2026062400-mindmap.md` | 产品能力思维导图 |

## release —— 发版

| 路径 | 用途 |
| --- | --- |
| `release/2026041300-cli-release-process.md` | `tmex-cli` 发布流程：构建链、资源打包、版本注入 |
| `release/2026061406-release-changelog-flow.md` | `scripts/release.ts` 的双语 changelog 生成与版本写入 |
| `release/2026083101-github-releases-distribution.md` | 发行源切换到本仓库 GitHub Releases 与 `install.sh` |
| `release/2026083101-upgrade-crash-safety.md` | 自升级的崩溃安全性与回滚 |

## service —— 常驻服务

| 路径 | 用途 |
| --- | --- |
| `service/2026061400-process-survival.md` | tmex 崩溃/重启时 tmux 进程的存活边界（`KillMode=process`、linger） |

## terminal —— 终端

| 路径 | 用途 |
| --- | --- |
| `terminal/2026041600-ghostty-wasm-runtime.md` | Ghostty wasm 终端底座的运行机制与前端接线 |
| `terminal/2026021404-terminal-switch-barrier-design.md` | pane 切换屏障（selectToken）：Gateway 时序、超时降级与验收用例 |
| `terminal/2026061101-claude-code-osc-notification.md` | Claude Code 各通知渠道的 OSC 序列与 `TERM=xterm-ghostty` 注入 |
| `terminal/2026061501-mobile-keyboard-behavior.md` | 移动端三种键盘避让模式（lift / resize / follow）与光标跟随算法 |
| `terminal/2026090101-viewport-policy.md` | 终端视口策略：最小可见客户端拥有 PTY 尺寸 |
| `terminal/2026090304-ws-latency-measurement.md` | 延迟徽标的测量口径：心跳 nonce / 中位数、网关 PONG 优先通道与 `[ws-metrics] ping` |

## testing —— 测试

| 路径 | 用途 |
| --- | --- |
| `testing/2026061302-live-integration-tests.md` | 打真实 endpoint 的 live integration 测试约定与凭证守卫 |

## update —— 自更新

| 路径 | 用途 |
| --- | --- |
| `update/2026061406-self-update.md` | 程序内自更新状态机、`canSelfUpdate` 判定与版本展示 |
| `update/2026061502-bun-path-resolution.md` | bun 路径解析：优先级、`TMEX_BUN_PATH`、路径消毒与超时 |

## watch —— 屏幕监控

| 路径 | 用途 |
| --- | --- |
| `watch/2026061300-watch-monitor-overview.md` | Watch 规则模型、调度、三种触发（正则/不变/LLM）与 API |

## ws-protocol —— WebSocket 协议

| 路径 | 用途 |
| --- | --- |
| `ws-protocol/2026021402-ws-borsh-v1-spec.md` | `tmex-ws-borsh-v1` wire 格式唯一真源：kind 编号、schema、capabilities |
| `ws-protocol/2026021403-ws-state-machines.md` | 两端状态机规范：连接、设备、选择事务、输出门控、resize、bell、canonical feed |
| `ws-protocol/2026070402-site-theme-update.md` | `KIND_SITE_THEME_UPDATE` 站点主题跨端广播与 last-writer-wins |
