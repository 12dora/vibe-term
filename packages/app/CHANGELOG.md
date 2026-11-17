# 2.17.0

_2026-11-17_

## English

### One-time login command

- **Sign in an agent without typing a password or code in the terminal.** In Settings → Nodes, click **Login command** (or use **Login command** in a node's ⋯ menu), choose all nodes or one node, confirm with a two-step verification code or a passkey, and copy the generated `vibeterm login --code …`. Running it on the agent's machine gives the same sessions as `vibeterm login`.
- The command is valid for 10 minutes and each node accepts it once. The dialog shows the remaining time and whether each node has used it, and you can revoke it. A command for one node also signs in to the current entry, which the CLI needs to reach that node.
- Each node verifies your identity on its own when the command is generated, and only ever stores a hash of its own part of the code. Changing your password, removing a node or passkey, or signing out on a node voids unused commands.
- Use `vibeterm login --code -` to read the command from stdin. Nodes and the CLI need 2.17.0 or later; older or offline nodes are skipped and listed.
- If the page was reloaded after a password sign-in, the dialog asks for your password and code instead of the code alone.

### Fixes

- `vibeterm whoami` no longer reports other nodes as signed out when their sessions are valid.
- Login history shows **Login command** for sessions created this way.

---

## 中文

### 一次性登录命令

- **agent 免在终端输入密码与验证码即可登录**：在「设置 → 节点」点击「登录命令」（或节点 ⋯ 菜单中的「登录命令」），选择全部节点或指定节点，用两步验证码或通行密钥确认后，复制生成的 `vibeterm login --code …`。在 agent 所在机器执行，得到的会话与 `vibeterm login` 相同。
- 命令 10 分钟内有效，每台节点只能使用一次；对话框显示剩余时间与各节点使用状态，可随时作废。为指定节点生成时会同时包含当前入口（CLI 经入口访问该节点需要入口会话）。
- 生成时每台节点各自校验身份，只保存与自己相关部分的哈希。修改密码、移除节点或通行密钥、在节点上退出登录，都会使未使用的命令失效。
- `vibeterm login --code -` 可从标准输入读取命令。节点与 CLI 需 2.17.0 及以上；离线或版本过低的节点会被跳过并列出。
- 密码登录后若刷新过页面，生成时需输入密码与验证码，而非仅验证码。

### 修复

- `vibeterm whoami` 不再把会话有效的其他节点显示为未登录。
- 登录历史中，以此方式创建的会话显示为「登录命令」。
