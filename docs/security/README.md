# security/

登录面与访问策略的安全模型。mesh 的身份 / 密钥模型与失陷边界在 [architecture/mesh-architecture.md](../architecture/mesh-architecture.md)，发行包验签在 [operations/release-signing.md](../operations/release-signing.md)，远程窗格授权在 [architecture/agent-remote-pane-grant.md](../architecture/agent-remote-pane-grant.md)。

| 文档 | 内容 |
| --- | --- |
| [login-security.md](./login-security.md) | 登录失败模糊化、客户端 IP 解析与 bootstrap 限制、未登录面资源上限、通行密钥二次验证（按 origin 生效 + 可信本地来源豁免 + TOTP/通行密钥 OR + 逃生口）、公网暴露的安全评估与明确不做的事 |
| [domain-access-policy.md](./domain-access-policy.md) | 按节点的「允许域名访问」开关：拦截规则、服务白名单、锁死自救 |
