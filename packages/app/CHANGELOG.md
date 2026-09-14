# 2.5.0

_2026-09-14_

## English

### Removed

- **Hub mode is gone.** VibeTerm now has four roles: `standalone`, `node`, `relay`, `relay,node`. Multi-node setups connect through relays (blind forwarders) plus direct node-to-node links; there is no longer a trusted "hub" that reads your node list, key log or signalling. Everything hub-specific was removed: the `hub,node` role, `vibeterm hub …` commands, `vibeterm enroll`, the Hub setup wizard paths, the Hub uplink panel, multi-hub standby/promote/demote, hub badges, `/api/hub/*`, `/hub/uplink`, `GET /api/mesh/hubs`, `POST /api/setup/hub|join`, and the `VIBETERM_HUB_*` settings.

### Changes

- `vibeterm user add | passwd | totp` replaces `vibeterm hub user …` for managing the local account from the terminal.
- `vibeterm relay join <url> --token <r3.…>` is the only way to join with a join code (it used to be `vibeterm hub join --token`). Join commands shown in the app and by `vibeterm nodes enroll` now print this form, and `--ca-fingerprint` is honoured on the token path too.
- New `vibeterm relay trust refresh <url> --fingerprint <sha256>` re-pins the CA of a self-signed relay after it rotates its certificate; a join without a fingerprint clears any stale pin for that relay so a relay that moved to a public certificate connects again.
- A node that belongs to no relay shows a "join a relay" prompt instead of Hub status; HTTPS settings are now available on `node` machines too.
- Nodes that never left Hub mode keep starting: a leftover `VIBETERM_ROLES=hub,node` is read as `node` with a warning, and `vibeterm upgrade` rewrites `app.env` accordingly and removes the old `VIBETERM_HUB_*` keys (inside the upgrade transaction, with a copy kept under `backups/` and a notice printed). Such a machine no longer serves other nodes; every member must join a relay.
- Database: hub-only tables are dropped, `node_identity` loses its `hub_url` column, and pinned CAs of self-signed relays move from `hub_trust` to `relay_ca_pins` (data is copied). Historical `admit-hub` / `retire-hub` key-log records still verify but no longer have any effect.
- STUN source label `hub-custom` is now `relay-custom`; the relay uplink mode reported by `vibeterm relay status` is `relay` or `none`.

### Fixes

- Relay join now reports `relay_unreachable` (HTTP 502) instead of a hub-worded error when the relay cannot be reached.

---

## 中文

### 移除

- **Hub 模式已彻底移除。** 现在只有四种角色：`standalone`、`node`、`relay`、`relay,node`。多节点互联一律经中继（盲转发）与节点直连，不再有能读取节点清单、密钥日志与信令的「Hub」上级。与之相关的一切都已删除：`hub,node` 角色、`vibeterm hub …` 命令、`vibeterm enroll`、设置向导的 Hub 路径、Hub 上联面板、多 hub 主备 / 提升 / 降级、Hub 徽标、`/api/hub/*`、`/hub/uplink`、`GET /api/mesh/hubs`、`POST /api/setup/hub|join` 以及 `VIBETERM_HUB_*` 配置。

### 变更

- 终端里管理本机账号改用 `vibeterm user add | passwd | totp`（原 `vibeterm hub user …`）。
- 用加入码加入只剩 `vibeterm relay join <url> --token <r3.…>`（原 `vibeterm hub join --token`）；界面与 `vibeterm nodes enroll` 打印的加入命令同步改为该形式，`--ca-fingerprint` 在加入码路径同样生效。
- 新增 `vibeterm relay trust refresh <url> --fingerprint <sha256>`，自签中继换证书后用它重新钉扎 CA；不带指纹加入会清掉该中继的旧钉扎，换成公网证书的中继因此能重新连上。
- 尚未加入任何中继的节点显示「加入中继」提示而不是 Hub 状态；`node` 角色的机器现在也能配置 HTTPS。
- 仍停留在 Hub 模式的机器不会起不来：残留的 `VIBETERM_ROLES=hub,node` 按 `node` 读取并打一条警告，`vibeterm upgrade` 会在升级事务内改写 `app.env` 并删除旧的 `VIBETERM_HUB_*` 键（`backups/` 下留有副本并打印提示）。这台机器不再为其他节点提供服务，所有成员都需要接入中继。
- 数据库：删除 hub 专用表，`node_identity` 去掉 `hub_url` 列，自签中继的 CA 钉扎从 `hub_trust` 迁到 `relay_ca_pins`（数据自动搬迁）。历史 `admit-hub` / `retire-hub` 密钥日志记录仍可校验但不再产生任何效果。
- STUN 来源标识 `hub-custom` 改为 `relay-custom`；`vibeterm relay status` 报告的上联模式为 `relay` 或 `none`。

### 修复

- 加入中继失败时报 `relay_unreachable`（HTTP 502），不再出现 Hub 口径的错误文案。
