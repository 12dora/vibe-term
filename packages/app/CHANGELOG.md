# 2.2.1

_2026-09-12_

## English

### Fixes

- **Direct links between two nodes could get stuck forever.** A node that was "cooling down" after failed direct-connection attempts also refused to *answer* the other side's attempts, so the other side timed out, cooled down in turn, and the two never lined up. Answering an incoming attempt now always goes ahead, and waiting for an offer that never came no longer counts as a failure. After upgrading both sides, nodes that showed `relay` for hours should switch to `dc` within a couple of minutes.
- **Proxy fake-IP addresses are no longer advertised as node endpoints.** Machines running Surge / Clash in TUN mode advertised `198.18.0.1`, and every other node then dialled its own proxy and failed. Such addresses are excluded from the advertised list and skipped when an older node still sends them.
- **Relay meshes are now manageable from the CLI.** `vibeterm nodes enroll` prints an `r3.` join code on a relay mesh (it used to hit the hub API and fail), `vibeterm nodes meta-key admit <node>` / `rotate` re-issue the tenant member key (the fix for a node that was admitted but stays read-only, showing its raw id as its name), and `vibeterm nodes allow <node>` delivers that key to an already-admitted member. All three sign with your account password (`VIBETERM_PASSWORD` or a prompt).
- **A newly admitted relay member no longer gets stuck without its member key.** Approving from the node table (or a resend) skipped the follow-up that hands the new node the tenant member key, so it stayed read-only: its name showed as a raw id, renaming failed, and the only retry lived in one browser tab's session. The relay status now reports members whose key is behind, every admission path delivers the key, and the settings page / connect panel show a banner with a one-click "deliver member key" action; clicking confirm twice no longer errors. Requires the entry node to be on 2.2.1.
- **`vibeterm nodes upgrade` now works from the CLI.** Pushing an upgrade to a node through the entry needs that node's session; the CLI only sent the entry's, so it reported `NODE_LOGIN_REQUIRED` even after `vibeterm login --all-nodes`, and `--all` found nothing to upgrade. The CLI now sends the target node's session along and counts its own logins when choosing targets.

### Upgrade notes

- The direct-link fix needs 2.2.1 on **both** nodes of a pair; the hub / relay does not need to change for it.

---

## 中文

### 修复

- **两台节点之间的直连可能永远建不起来。** 直连多次失败后进入冷却的节点，连对方发起的尝试也一并拒绝应答，于是对方超时、轮到对方冷却，两边永远对不上。现在收到对方的尝试一律应答，等一个始终没来的 offer 也不再记为失败。两侧都升级后，长期显示 `relay` 的节点应在一两分钟内切到 `dc`。
- **代理的 fake-IP 地址不再作为节点端点广播。** 开着 Surge / Clash TUN 模式的机器会把 `198.18.0.1` 广播出去，其他节点随即去拨自己的代理并失败。这类地址已从广播列表剔除，老节点仍发来时拨号侧直接跳过。
- **中继制 mesh 现在可以用 CLI 管理。** `vibeterm nodes enroll` 在中继 mesh 上直接出 `r3.` 加入码（以前打 Hub 接口报错），`vibeterm nodes meta-key admit <节点>` / `rotate` 补发或轮换租户成员密钥（修复「已准入却一直只读、名字显示为一串 id」的节点），`vibeterm nodes allow <节点>` 给已准入成员补发该密钥。三者都用账户密码签名（`VIBETERM_PASSWORD` 或交互输入）。
- **新准入的中继成员不再卡在「没有成员密钥」。** 从节点表批准（或重发）时跳过了给新节点下发租户成员密钥的收尾，节点只能只读：名字显示为一串 id、改名报错，唯一的重试入口只存在于某一个浏览器标签页。现在中继状态会列出成员密钥落后的节点，所有准入入口都会下发密钥，设置页与接入面板有告警条和一键「补发成员密钥」；重复点确认也不再报错。入口节点需升到 2.2.1。
- **`vibeterm nodes upgrade` 现在能用了。** 经入口向节点推送升级需要该节点的会话，而 CLI 只带了入口自己的，于是 `vibeterm login --all-nodes` 之后仍报 `NODE_LOGIN_REQUIRED`，`--all` 也选不出目标。CLI 现在会附带目标节点的会话，并把自己的登录计入可升级判定。

### 升级说明

- 直连修复需要一对节点**两侧**都升到 2.2.1；hub / 中继不需要为此改动。
