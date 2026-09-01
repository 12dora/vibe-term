# 1.1.8

_2026-09-01_

## English

### Improvements

- Terminals you switched away from stop consuming bandwidth after a minute: recently used terminals stay warm for 60 seconds so switching back is instant; after that their live output is paused until you return, at which point the screen and scrollback are replayed in full. Useful on phones with a busy build or log running in a background pane.
- Less background network activity: while the tab or app is hidden, the connection heartbeat drops from every 5 seconds to every 30 seconds and returns to normal the moment you come back.
- Mesh node list refreshes on events instead of every 30 seconds: it now updates immediately when the mesh connection (re)connects, when a new node appears, when you return to the app, or when a node's session expires, with a 5-minute safety poll. Opening Settings → Nodes always fetches a fresh list.

### Fixes

- A node whose sign-in expired is now marked as signed out immediately (and the "Sign in to this node" action appears) instead of waiting for the next poll.

---

## 中文

### 改进

- 切走的终端一分钟后不再占用流量：最近用过的终端保持 60 秒热态，切回即时显示；超过后暂停接收实时输出，切回时完整重放画面与历史。手机上后台 pane 跑着编译或日志时尤其有用。
- 减少后台网络活动：标签页或应用隐藏期间，连接心跳从每 5 秒放慢到每 30 秒，回到前台立即恢复。
- mesh 节点列表改为事件驱动刷新：mesh 连接建立/重连、出现新节点、回到前台、节点会话失效时立即更新，并保留 5 分钟兜底轮询；打开「设置 → 节点」总会拉取最新列表。

### 修复

- 节点登录过期后立即标为未登录（并显示「登录此节点」），不再等待下一次轮询。
