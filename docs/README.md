# VibeTerm 文档

本目录是 VibeTerm 的技术文档，面向开发者与运维。产品介绍与安装入门看仓库根 [README.md](../README.md)（英文版 [README.en.md](./README.en.md)），仓库工作约定看根 [AGENTS.md](../AGENTS.md)。

每篇文档开头一句话说明内容与读者；描述的都是**当前已落地的行为**，过程性记录不进这里。改代码影响到文档时同步改文档；新文档按主题放进下面四个目录之一，文件名用描述性 kebab-case 英文，并在该目录的 `README.md` 补一行（有新的「快速定位」场景时再补本页）。

| 目录 | 放什么 |
| --- | --- |
| [`architecture/`](./architecture/README.md) | 系统如何工作：多节点互联（mesh / 中继 / 直连 / 端口映射）、WebSocket 协议与状态机、终端底座与视口、文件传输、远程执行、分享、Agent、Watch、通知与消息指令 |
| [`operations/`](./operations/README.md) | 部署与运维手册：安装、mesh 与中继运维、容器节点、HTTPS / 端口 / 隧道、进程存活、事件循环看门狗、发版 / 签名 / 升级 / 改名迁移 |
| [`security/`](./security/README.md) | 登录面安全模型、访问令牌与访问策略（mesh 的威胁模型在 `architecture/mesh-architecture.md`） |
| [`development/`](./development/README.md) | 开发与测试：环境变量、前端包结构与外壳行为、性能基准、字体流水线、实测 harness |
| `images/` | 根 README 引用的截图 |
| [`known-issues.md`](./known-issues.md) | 尚未解决的已知问题登记簿；解决后从中移除 |

## 快速定位

- 想把多台机器连起来：[部署指南](./operations/production-install.md) → [mesh 运维](./operations/mesh-operations.md)；想给别人提供转发服务：[公共中继角色](./architecture/relay.md)。
- 直连建不起来 / 徽标显示中继：[节点直连](./architecture/peer-direct-connect.md) 与 [mesh 运维「常见排障」](./operations/mesh-operations.md)；放行哪些口：[角色入站端口](./operations/nonstandard-ports.md)。跨境 RTT 差一倍、直连慢于中继：[路径优选](./architecture/path-selection.md)。
- 装在 ≤ 2 GiB 或 256 MB Alpine 的小内存机上：[小内存主机](./operations/small-memory.md)。想知道某个 tmux 窗口吃了多少内存、或想在 Linux 上把它限住：[窗口内存](./operations/window-memory-limits.md)。OpenRC 上限额不可用，读数仍走进程树 RSS。
- 服务显示 running 但 HTTP / 中继不通：[事件循环看门狗](./operations/gateway-loop-watchdog.md)。
- 登录相关（密码、通行密钥、TOTP、登录限制、登录历史、公网暴露）：[登录面安全](./security/login-security.md)；agent / CI 免登录凭据：[访问令牌](./security/access-tokens.md)；网页端生成、终端兑换的一次性登录：[一次性登录命令](./security/login-codes.md)。
- 发一个版本：[发布流程](./operations/release-process.md) → [发行包签名](./operations/release-signing.md)；升级出问题：[升级事务](./operations/upgrade-transaction.md)。
- 改 WebSocket 协议：[ws-borsh v1 规范](./architecture/ws-borsh-v1-spec.md) 与 [状态机](./architecture/ws-state-machines.md)。
- 起开发环境 / 写测试：[三套环境](./development/environments.md)、[实测约定](./development/live-integration-tests.md)；改共享口径先看 [单一上游](./development/code-conventions.md)。
- 在终端里用 `vibeterm`（登录、接进别的机器、让 AI agent 跑命令）：[命令行使用手册](./operations/cli-usage.md)。
- 给 `vibeterm` 加客户端命令：[客户端 CLI 架构](./development/cli-architecture.md)。

每个目录下的 `README.md` 是该目录的完整文档清单。
