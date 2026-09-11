# 2.2.4

_2026-09-12_

## English

### Fixes

- **Remote upgrade of a far-away node no longer times out.** Pushing the release package through the relay to a node with a long round-trip (for example Shanghai → Tokyo) failed with `NODE_UNREACHABLE http head timeout`: the forwarder started waiting for the node's response before the package had even finished uploading. The response-header wait now starts only after the request body is fully sent, and the overall budget grows with the body size.

### Upgrade notes

- Only the entry node (the one you run `vibeterm nodes upgrade` from, or click "upgrade" on) needs this release.

---

## 中文

### 修复

- **远端节点的远程升级不再超时。** 经中继向往返延迟很高的节点（例如上海 → 东京）推送发行包时会报 `NODE_UNREACHABLE http head timeout`：转发层在包还没上传完就开始等对方的响应。现在等待响应头的计时只在请求体发完后才开始，总预算也随包体大小增长。

### 升级说明

- 只有入口节点（你执行 `vibeterm nodes upgrade` 或在网页点「升级」的那台）需要这个版本。
