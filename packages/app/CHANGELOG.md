# 2.13.1

_2026-10-14_

## English

### Fixes

- Update checks and node upgrades no longer depend on the GitHub API, so they keep working when many machines share one network address. Previously, frequent checks could hit GitHub's hourly limit and every node upgrade failed with "release unavailable" until the limit reset.
- The one-line installer retries briefly when GitHub is slow to respond, instead of giving up.

---

## 中文

### 修复

- 检查更新与节点升级不再依赖 GitHub API，多台机器共用同一出口地址时也能正常使用。此前频繁检查可能触发 GitHub 每小时限额，导致所有节点升级都报「发行不可用」，要等限额恢复才能继续。
- 一键安装脚本在 GitHub 响应较慢时会自动重试，不再直接失败。
