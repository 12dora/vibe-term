# 1.1.16

_2026-09-02_

## English

### New

- Changing the password no longer wipes your other sign-in methods. A routine change keeps registered passkeys, two-step verification and the session you are using; only a new checkbox, "Also remove all passkeys and two-step verification and sign out everywhere", performs the old full reset for a password that may have been exposed. The same applies to `tmex hub user passwd` (use `--full-reset` for the old behaviour). All nodes must run 1.1.16 or newer before the first such change; the UI lists nodes that still need an upgrade.
- Settings → Nodes: the "This machine" card now shows the hub it is actually attached to (primary / standby, and the writer when they differ) plus the list of known hubs; the address entered at join time is shown separately as "Join Address".

### Improvements

- Account security actions explain hub problems in plain words: the primary hub did not confirm the change, the current hub is a standby, or some nodes are too old.

### Fixes

- Compatibility checks for new key-log record types now consider every node with a valid certificate, not only nodes that have already reported their status.
- Unused join codes are invalidated as part of every root-key rotation, including on standby hubs replaying the log.

---

## 中文

### 新增

- 改密码不再清掉其它登录方式。常规改密会保留已注册的通行密钥、两步验证和当前正在使用的会话；只有勾选新的「同时移除所有通行密钥、两步验证并注销全部会话」才执行原来的全量重置（用于密码可能已泄露的情况）。命令行 `tmex hub user passwd` 同样默认保留，`--full-reset` 走原行为。首次使用前须把所有节点升级到 1.1.16 及以上，界面会列出仍需升级的节点。
- 设置 → 多节点互联：「本机」卡片显示实际挂载的 Hub（主 / 备，主备不一致时同时显示写者）与已知 Hub 列表；加入时填写的地址单独显示为「加入地址」。

### 改进

- 账号安全操作遇到 Hub 问题时给出明确说明：主 Hub 未确认修改、当前 Hub 为备用、或有节点版本过旧。

### 修复

- 新记录类型的兼容检查现在覆盖所有持有有效证书的节点，而不只是已上报状态的节点。
- 每次根钥轮换都会在持久化时作废未使用的加入码，备用 Hub 回放日志时同样生效。
