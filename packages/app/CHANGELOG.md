# 2.0.0

_2026-09-07_

## English

### Changed

- **tmex is now VibeTerm.** The product, CLI (`vibeterm`, with `tmex` kept as an alias), package (`vibeterm-cli`), environment variables (`VIBETERM_*`), install directory and service name are renamed. Upgrading an existing 1.x install migrates it in place: the install directory moves to `vibeterm`, `app.env` keys are rewritten, the database file is renamed and the service is re-registered under the new label. Nothing is lost: accounts, passkeys, two-step verification, nodes, shares and browser settings carry over. Downgrading below 2.0 after the migration is not supported.
- **Mixed-version fleets keep working.** A 2.0 hub still talks to 1.x nodes and can push their upgrade; nodes that fetch releases themselves find both the new and the legacy package name for this release.
- **Cloudflare Access.** Policies and applications created under the old name are recognised and renamed on the next sync.

### Fixes

- **Sharing and sessions.** Session and share cookies issued before the rename stay valid through the upgrade.

---

## 中文

### 变更

- **tmex 更名为 VibeTerm。** 产品名、命令行（`vibeterm`，`tmex` 保留为别名）、安装包（`vibeterm-cli`）、环境变量（`VIBETERM_*`）、安装目录与服务名全部更名。已有 1.x 安装升级时原地迁移：安装目录改为 `vibeterm`，`app.env` 键改写，数据库文件改名，服务以新名称重新注册。账号、通行密钥、两步验证、节点、分享与浏览器设置全部保留。迁移后不支持降级到 2.0 以下版本。
- **新旧版本混合运行。** 2.0 Hub 仍可与 1.x 节点通信并推送升级；自行拉取发行包的节点在本版本同时能找到新旧两种包名。
- **Cloudflare Access。** 旧名称下创建的策略与应用会被识别，并在下一次同步时改名。

### 修复

- **分享与会话。** 更名前签发的会话与分享 cookie 在升级后仍然有效。
