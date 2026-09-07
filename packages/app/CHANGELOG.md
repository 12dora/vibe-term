# 2.0.3

_2026-09-07_

## English

### New

- Direct-connect plugin is installed and enabled by default on every new node (`init`, `hub join`, `relay join`, web setup). If the download is unavailable, setup still completes and the node falls back to relay/LAN links.
- Node management: the node detail dialog (⋯) now has a single button to install (and enable) or remove the direct-connect plugin, for this machine and for remote nodes, with a one-click gateway restart.
- Relay members that hold a previous relay token stay online after a password change and show "awaiting token"; up to three rotations within 30 days remain recoverable.
- "Resend relay token" button in the relay panel, plus a warning whenever a relay-side write is not acknowledged by the relay.
- New recovery commands: `vibeterm hub trust refresh`, `hub ca fingerprint|rotate`, `hub urls list|add|remove`, `mesh keylog status`, `mesh reset-identity`, `tls reset`, `relay pack upload`.
- Nodes page shows recovery hints when the hub CA changed, the hub no longer admits this node, or two hubs are active at once; the login page and app shell warn when the master key can no longer decrypt the node identity.

### Improvements

- Kick-mode relay password change and tenant kick refuse to run while admitted members are offline unless explicitly forced, and explain the recovery steps.
- Destructive CLI operations (`hub user passwd --full-reset`, `mesh reset-root`, `tls reset`) require an explicit confirmation.
- `vibeterm upgrade --repair` recovers when `install-meta.json` is unreadable.
- A lost master key no longer takes the whole gateway down: local login keeps working while mesh is disabled, with the recovery steps in the log.

### Fixes

- Self-signed hub CA is no longer rotated silently; a changed CA is reported instead of breaking every node's uplink.
- Relay sealed pack can only be written with the current token, so a stale node cannot overwrite a fresh recovery pack.
- Retrying a key-log write after a lost relay acknowledgement now confirms correctly.
- Password join after `mesh reset-identity` performs a full re-join instead of failing.

---

## 中文

### 新增

- 新节点默认安装并启用直连插件（`init`、`hub join`、`relay join`、网页接入向导）。下载不可用时接入照常完成，节点回落到中继或局域网链路。
- 节点管理：节点详情框（⋯）新增一枚按钮，未安装时安装并启用直连插件，已安装时删除，本机与远端节点均可用，并提供一键重启网关。
- 修改中继密码后，持旧令牌的成员保持在线并显示「等待令牌」；30 天内最多三次换发均可恢复。
- 中继面板新增「重发中继令牌」按钮；中继未确认的写入会给出告警。
- 新增恢复命令：`vibeterm hub trust refresh`、`hub ca fingerprint|rotate`、`hub urls list|add|remove`、`mesh keylog status`、`mesh reset-identity`、`tls reset`、`relay pack upload`。
- 节点页在 Hub 证书变更、Hub 不再准入本节点、两个 Hub 同时活动时给出恢复提示；主密钥无法解密节点身份时登录页与应用外壳显示提示。

### 改进

- kick 模式改密与踢出租户在有已准入成员离线时拒绝执行（需显式强制），并说明恢复步骤。
- 破坏性命令（`hub user passwd --full-reset`、`mesh reset-root`、`tls reset`）需要明确确认。
- `vibeterm upgrade --repair` 在 `install-meta.json` 损坏时也能恢复。
- 主密钥丢失不再拖垮整个网关：多节点功能停用，本机登录保持可用，日志给出恢复步骤。

### 修复

- 自签名 Hub 证书不再静默轮换；证书变更会被报告，而不是让所有节点的上联失效。
- 中继密封包只能用当前令牌写入，过期节点无法覆盖新的恢复包。
- 中继确认丢失后重试密钥日志写入，现在能正确确认。
- `mesh reset-identity` 之后的密码加入改为完整重新加入，不再失败。
