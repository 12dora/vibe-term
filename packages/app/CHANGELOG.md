# 1.1.11

_2026-09-01_

## English

### New

- Nodes page: an **Upgrade all** button next to **Add** upgrades every node that is behind the latest release — ordinary nodes first (three at a time), then the remote hub, then this machine — and finishes with a single summary toast (succeeded / failed). Per-row **Upgrade** buttons are greyed out when a node is already on the latest version, or when it is too old (before 1.1.0) to be upgraded remotely, with the reason shown on hover.
- Remote upgrades no longer require the target machine to reach GitHub: the node you are using downloads the release, verifies it against `SHA256SUMS`, pushes it to the target over the mesh link and the target upgrades from the staged package. Targets older than 1.1.11 still download on their own; a target that cannot self-update (no service manager, container) now says so plainly.
- Multi-hub (phase 1): a joined node can become a **standby hub** (`tmex hub standby --public-url …`) that the active hub authorises with `tmex hub allow <node-id>`. Nodes learn the hub set from the active hub, fail over in order when the active hub is unreachable, and switch back automatically (about a minute) when it returns. A standby serves reads and relays but refuses management writes (`HUB_NOT_WRITER`) until it is explicitly promoted (`tmex hub promote`); hubs fence each other by writer epoch, including across restarts. The Nodes page shows the hub set, which hub this entry is attached to, and the current writer.

### Fixes

- Large transfers between nodes over a relayed or direct WebSocket link could be cut off at 1 MiB (the server socket's backpressure limit); the link now paces itself against the socket buffer.

---

## 中文

### 新增

- 节点页新增「全部升级」按钮（位于「添加」左侧）：把所有落后于最新版的节点依次升级——先普通节点（并发 3），再远端 hub，最后本机——结束后只弹一条「成功 X，失败 Y」汇总。行内「升级」按钮在节点已是最新、或版本过旧（低于 1.1.0）无法远程升级时置灰，悬停可见原因。
- 远程升级不再要求目标机器能访问 GitHub：由你正在使用的节点下载发行包、按 `SHA256SUMS` 校验，经 mesh 链路推送到目标节点，目标从暂存包完成升级。1.1.11 之前的旧目标仍自行下载；无法自更新的安装（无服务管理器、容器）现在会明确提示。
- 多 hub（第一阶段）：已加入的节点可用 `tmex hub standby --public-url …` 变为**备用 hub**，由主 hub 执行 `tmex hub allow <节点 id>` 授权。各节点从主 hub 学到 hub 集合，主 hub 不可达时按序切换到备用 hub，主 hub 恢复后约一分钟内自动切回。备用 hub 提供读取与中继，但在显式 `tmex hub promote` 之前拒绝管理写入（`HUB_NOT_WRITER`）；hub 之间按写者 epoch 互相围栏，重启后依然有效。节点页展示 hub 集合、当前入口挂载的 hub 与当前写者。

### 修复

- 节点间经中继或直连 WebSocket 链路传输大文件时可能在 1 MiB 处被掐断（服务端 socket 背压上限）；链路现在按 socket 缓冲量自行节流。
