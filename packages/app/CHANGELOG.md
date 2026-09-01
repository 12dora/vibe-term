# 1.1.9

_2026-09-01_

## English

### Fixes

- Remote mesh nodes no longer flicker offline: on 1.1.8 a node could briefly lose its device cards, show "Sign in to this node" and disconnect its terminals about once a second before recovering by itself, which also drove up latency to LAN nodes. The cause was 1.1.8 treating any forwarded 401 from a node as an expired sign-in; sign-in state is now decided only by the node list again. If you are on 1.1.8, upgrade as soon as possible. 1.1.8's other improvements (paused output for terminals hidden longer than a minute, slower heartbeat while the app is hidden, event-driven node list refresh) are unchanged.

---

## 中文

### 修复

- 远端 mesh 节点不再反复闪断：在 1.1.8 上，节点的设备卡片会每隔约一秒短暂消失、显示「登录此节点」、终端断开后又自行恢复，并把局域网节点的延迟拉高。原因是 1.1.8 把节点转发回来的任何 401 都当作登录过期处理；现在登录态重新只由节点列表决定。如果你正在使用 1.1.8，请尽快升级。1.1.8 的其它改进（切走超过一分钟的终端暂停接收输出、应用隐藏时放慢心跳、节点列表事件驱动刷新）保持不变。
