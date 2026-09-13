# operations/

部署、运维与发版手册。按「装起来 → 组网 → 暴露到公网 → 保活 → 升级 / 发版」的顺序阅读。

## 部署与组网

| 文档 | 内容 |
| --- | --- |
| [ai-deploy.md](./ai-deploy.md) | 按场景给出可直接执行的部署步骤（独立 / Hub / 中继 × 公网域名 / 端口转发 / Cloudflare Tunnel），外加 agent 用 CLI 调试别的节点，面向 AI 助手与运维 |
| [production-install.md](./production-install.md) | 单机生产部署（安装、服务、日志、反代、SSH 设备、备份、排障） |
| [mesh-operations.md](./mesh-operations.md) | mesh 运维手册（角色、环境变量、搭 hub、加入 / 吊销、账号安全、直连、灾难恢复、排障表） |
| [multi-hub-standby.md](./multi-hub-standby.md) | 多 hub 主 / 备 |
| [docker-node.md](./docker-node.md) | 容器节点 |

## 公网暴露

| 文档 | 内容 |
| --- | --- |
| [nonstandard-ports.md](./nonstandard-ports.md) | 角色入站端口（含 UDP）与 80/443 不可用时的 HTTPS 候选 / 探测 |
| [https-and-acme.md](./https-and-acme.md) | 对外有效 HTTPS、ACME dns-01 提供商、80/443 被占场景 |
| [tunnel-edge-fake-ip.md](./tunnel-edge-fake-ip.md) | Cloudflare Tunnel 边缘与 ICE STUN/TURN 的 fake-IP 绕行 |

## 保活与排障

| 文档 | 内容 |
| --- | --- |
| [tmux-process-survival.md](./tmux-process-survival.md) | 服务 kill 策略、linger、systemd OOMPolicy |
| [troubleshooting-db-master-key.md](./troubleshooting-db-master-key.md) | 库与主密钥不匹配 |

## 日常使用

| 文档 | 内容 |
| --- | --- |
| [cli-usage.md](./cli-usage.md) | `vibeterm` 客户端命令行使用手册：登录与登出、目标语法、接进任意节点的终端、Agent 会话与 run / capture / send、节点 / 设置 / 文件 / 设备命令、安全边界与退出码 |

## 发版与升级

| 文档 | 内容 |
| --- | --- |
| [release-process.md](./release-process.md) | 发版手册与 changelog 改写规范 |
| [release-signing.md](./release-signing.md) | 发行包签名 |
| [upgrade-transaction.md](./upgrade-transaction.md) | 崩溃安全的升级事务 |
| [self-update.md](./self-update.md) | 程序内自更新与发行包缓存 |
| [remote-upgrade.md](./remote-upgrade.md) | 远程升级：三通道投递与推包续传 |
| [bun-path-resolution.md](./bun-path-resolution.md) | CLI 的 bun 路径解析 |
| [rename-migration.md](./rename-migration.md) | tmex → VibeTerm 改名迁移 |
