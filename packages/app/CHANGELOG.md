# 1.1.10

_2026-09-01_

## English

### Fixes

- Mixed-version meshes: the browser no longer sends the multi-client viewport frame to nodes older than 1.1.7, which used to log `gateway transport error: Unknown kind: 776` on every switch to a pane on such a node. Multi-client window sizing still requires the node itself to be on 1.1.7 or newer.
- A sign-in-required error returned through a relay hop is now attributed to the node you actually addressed, never to the relaying node; this closes the last path by which an unrelated node could have been shown as signed out (the 1.1.8 flicker was already stopped in 1.1.9).

---

## 中文

### 修复

- 混合版本 mesh：浏览器不再向 1.1.7 之前的旧节点发送多客户端视口帧，此前每次切到旧节点的 pane 都会在控制台打出 `gateway transport error: Unknown kind: 776`。多客户端窗口尺寸功能仍需节点本身 ≥ 1.1.7。
- 经中转返回的「需要登录」错误现在只记到你实际访问的节点上，不会记到中转节点头上；这堵住了「无关节点被显示为未登录」的最后一条路径（1.1.8 的闪断已在 1.1.9 止住）。
