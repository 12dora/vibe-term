# 1.1.39

_2026-09-06_

## English

### Security

- **Remote agent pane access now requires a grant.** A node can only send input to or read a pane on another node with a grant issued by that node for the specific pane, minted transparently when the agent session is created. A compromised node can no longer control panes elsewhere. Upgrade entry nodes first: an older entry cannot drive remote agent sessions on upgraded nodes until it is upgraded too.
- **Signed releases.** Release checksums are signed and every node verifies the signature offline before applying an upgrade pushed from another node, so a compromised entry cannot install arbitrary code. Remote upgrades to versions before 1.1.39 are refused; install older builds locally with `tmex upgrade --version`.
- **Notification sink is user-signed.** Receiving other nodes' notifications now requires a record signed with the account key when the switch is turned on; nodes ignore a sink that merely claims to be one, and queued events are dropped as soon as a sink is disabled.

### Changes

- **Mobile keyboard.** On touch devices the keyboard opens only when tapping the terminal's input row; tapping elsewhere scrolls or selects without raising the keyboard. A "Hide Keyboard" button appears in the shortcut bar while the keyboard is up.
- Non-standard port probing and setup forms from 1.1.37 received follow-up fixes (explicit `:443` is kept, relay discovery probes relay health).

---

## 中文

### 安全

- **远程 agent 访问窗格须持 grant。** 节点只能凭目标节点为该窗格签发的 grant 向其它节点的窗格发送输入或读屏；grant 在创建 agent 会话时自动换取。被攻破的节点不再能控制其它节点的窗格。请先升级入口节点：旧入口在升级前无法驱动已升级节点上的远程 agent 会话。
- **发行签名。** 发行包校验和带签名，节点在应用其它节点推来的升级包前离线验签，被攻破的入口无法推送任意代码。远程升级到 1.1.39 之前的版本会被拒绝；旧版本请在本机用 `tmex upgrade --version` 安装。
- **通知汇聚须账号签名。** 开启「接收其它节点的通知」时会用账号密钥签一条记录，节点不再信任仅自称汇聚点的节点；汇聚点被关闭后排队中的事件立即丢弃。

### 变更

- **移动端键盘。** 触屏设备只有点击终端输入行才会弹出键盘，点击其它区域只滚动或选择；键盘弹出时快捷栏显示「隐藏键盘」。
- 1.1.37 的非标端口探测与接入表单收到后续修复（显式 `:443` 保持不变、中继发现使用中继健康探针）。
