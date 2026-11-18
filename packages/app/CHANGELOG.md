# 2.18.2

_2026-11-19_

## English

### Bug Fixes

- **Remote upgrades no longer fail with POP_REQUIRED**: upgrading another node from Settings → Nodes or with `vibeterm nodes upgrade` could fail on some nodes with `POP_REQUIRED`. The entry now keeps your sign-in proof for the whole upgrade, so these nodes upgrade normally. If a node was signed in under an older session, the browser signs it in again and retries. A sign-in problem during an upgrade now stops it right away with "Sign in to this node first" instead of a raw error code.
- **`vibeterm login --node` keeps other nodes working**: signing in to a single node (or redeeming a login command for some nodes) no longer breaks later operations on the other nodes. A full `vibeterm login` still issues a new session key for every node.
- **Removing a node asks for confirmation only once**: when this machine is connected to a relay, removing or uninstalling a node now asks for the account password once. That single confirmation also renews the relay credentials, and the dialog closes when the node is removed.

---

## 中文

### 问题修复

- **远程升级不再报 POP_REQUIRED**：在「设置 → 节点」或用 `vibeterm nodes upgrade` 升级其他节点时，部分节点会因 `POP_REQUIRED` 失败。现在入口在整个升级过程中都保留你的登录证明，这些节点可以正常升级。若某节点仍沿用较早的登录，浏览器会自动重新登录并重试一次。升级过程中出现登录问题时会立即停止，并提示「请先登录该节点」，不再显示原始错误码。
- **`vibeterm login --node` 不再影响其他节点**：单独登录某个节点（或兑换只含部分节点的登录命令）后，对其余节点的操作不再失败。完整执行 `vibeterm login` 仍会为全部节点更换会话密钥。
- **移除节点只需确认一次**：本机已加入中继时，移除或卸载节点只需输入一次账户密码，同时完成中继凭据更新，节点移除后确认框随即关闭。
