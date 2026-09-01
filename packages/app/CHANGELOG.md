# 1.1.12

_2026-09-02_

## English

### New

- Nodes page: an in-flight upgrade now survives a page refresh — the row picks up the current phase (downloading / installing) from the gateway and keeps tracking it.
- A **Stop** button appears while an upgrade is still downloading (on this machine, on the node you are using, or on the target). Stopping aborts the download and removes every partial file — the download cache, the staged package and the working directory are left as they were. Installing cannot be interrupted; the button is disabled with an explanation. Nodes older than 1.1.12 cannot be stopped remotely and say so.
- "Upgrade all" summaries now count stopped nodes separately (succeeded / failed / stopped).

### Fixes

- Interrupting a package push no longer leaves a half-written package on the target.

---

## 中文

### 新增

- 节点页：升级进行中刷新页面不再丢状态——行内会从网关取回当前阶段（下载中 / 安装中）并继续跟踪。
- 升级仍处于下载阶段时（本机、当前入口或目标节点）显示**停止**按钮。停止会中断下载并清理所有半成品：下载缓存、暂存包与工作目录都恢复到升级前的状态。安装阶段不可中断，按钮置灰并说明原因；1.1.12 之前的节点不支持远程停止，会明确提示。
- 「全部升级」汇总单独统计已停止的节点（成功 / 失败 / 已取消）。

### 修复

- 中断安装包推送时不再在目标节点留下写了一半的包。
