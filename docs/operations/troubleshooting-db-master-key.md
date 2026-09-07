# 数据库与主密钥不匹配的恢复

本文说明数据库密文与 `VIBETERM_MASTER_KEY` 不匹配时的症状、降级行为和恢复路径，面向安装版运维。

## 症状与根因

恢复数据库时未同时恢复配套的 `app.env`，会使部分字段无法解密。旧版本可能完全无法启动，服务管理器反复拉起；日志常见 `CryptoDecryptError`、`OperationError` 或解密失败。

当前版本在 mesh 模式读取 `node_identity` 失败时停用 mesh／Hub 控制面，保留 HTTP、SPA 与 `/api/auth/*`。`GET /healthz` 附带 `degraded: "master_key_mismatch"`；本地密码登录仍可用，匿名访问业务 API 仍被拒绝。TLS 私钥解密失败会保留 HTTP，HTTPS 不可用。Telegram 按机器人隔离坏 token，不阻断其它机器人及网关启动。

`/healthz` 可访问只说明进程和本地 HTTP 可用；出现上述 degraded 状态不能视为 mesh 已恢复。

| 密文位置 | 影响 | 无原密钥时的处理 |
|---|---|---|
| `node_identity.private_key`、`x25519_private_key` | 节点身份无法装载，mesh 停用 | 本机执行 `vibeterm mesh reset-identity`，然后重新加入 Hub／中继 |
| `mesh_relays.token_enc`、`mesh_secrets.key_enc` | 中继令牌及加密日志密钥不可用 | 用账户密码与有效密封包重新加入中继；密封包过期时先在可操作节点完成中继 reauth／重新封装 |
| TLS CA、叶子证书、ACME 账户与 DNS 凭据 | HTTPS 监听或续签不可用 | 恢复私钥或从本地 HTTP 重新配置 HTTPS；重建 CA 会影响全部 pin，先安排逐节点恢复 |
| Telegram Bot Token | 对应机器人不启动 | 在设置中重新填写 token |
| SSH 密码／私钥等设备认证 | 对应设备连接失败 | 重新填写凭据 |

用户根公钥及密码 KDF 不依赖 `VIBETERM_MASTER_KEY`，TOTP 则由密码派生密钥保护；不要为修复设备密文而随意重置用户密码。

## 优先恢复原密钥

1. 从日志确认报错 scope／field。Linux 可运行 `systemctl --user status vibeterm.service -l --no-pager` 与 `journalctl --user -u vibeterm.service -n 200 --no-pager`。自定义服务名以安装配置为准。
2. 备份当前数据库及 `app.env`，在本机检查安装目录的 `backups/app.env.*`，找到与数据库配套的 `VIBETERM_MASTER_KEY`。不要将密钥贴到日志、工单或聊天中。
3. 恢复该键并重启服务；核对 `/healthz` 不再 degraded、Hub／中继重新连接，随后验证 HTTPS 与外部通知。

## 原密钥不可恢复

确认不再能恢复原密钥后，先停止该安装的服务，避免运行时继续持有旧身份，再在节点本机终端执行：

```bash
vibeterm mesh reset-identity
```

命令在变更前显示影响并要求输入完整 `yes`；脚本执行须显式加 `--yes`。它保留账户根钥、通行密钥、TOTP 与日志，生成新节点身份，清除本地中继连接密钥与节点缓存，撤销本机会话。须重新加入可信 Hub／中继，随后启动服务；在可信入口吊销原节点身份。命令不会自动删除 TLS 配置或轮换 CA。

如果 `VIBETERM_MASTER_KEY` 自身缺失或格式非法，先在本机配置有效的新密钥，再重建身份；新密钥无法解密旧密文。TLS 密钥同样丢失时，使用保留的本地 HTTP 登录重新配置 HTTPS。自签名 CA 变更前务必保留各节点的 OS 访问路径，并按 [mesh 运维](./mesh-operations.md) 执行 `hub ca fingerprint`／`hub trust refresh`。

`mesh reset-root` 会重建账户根钥，而且仍需读取节点身份，不能代替失钥时的 `mesh reset-identity`。仅在账户本身必须重建或日志已分叉时使用前者。

## 注意事项

- 数据库与主密钥应作为同一恢复集合备份；不要把测试数据库直接覆盖到运行中的安装。
- 优先恢复原密钥可同时修复各类密文；身份重建只处理 mesh 连接材料，其余凭据须逐项恢复。
- Linux 服务默认输出到 journald，可用 `journalctl --user -u vibeterm.service -f` 连续观察；无需另加明文密钥日志。
