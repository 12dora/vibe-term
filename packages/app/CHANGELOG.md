# 1.1.15

_2026-09-02_

## English

### Fixes

- Node management no longer reports "Cannot connect to the hub" after the primary hub changes. The browser had never signed in to the new primary, so its first request was rejected and the page gave up. It now signs in to that hub silently and retries, and if the primary is still unavailable it falls back to another online hub (standby hubs forward changes to the primary).

---

## 中文

### 修复

- 主 hub 切换后，节点管理不再误报「无法连接到 Hub」。原因是浏览器从未登录过新的主 hub，首个请求被拒后页面直接放弃。现在会先对该 hub 静默登录并重试；主 hub 仍不可用时改用其它在线 hub（备用 hub 会把变更转发给主 hub）。
