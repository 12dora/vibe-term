# 2.11.1

_2026-10-12_

## English

### Improvements

- `vibeterm relay join` with a join code now waits for approval and ends with a clear result: "Joined." on success, or "Join failed: …" with the reason. Add `--no-wait` to return immediately.
- Confirming a new machine is now a single two-step flow with visible progress. When a passkey is used, you are told up front that it will be asked twice, and "Node joined" appears only once both steps are done.
- The node settings page keeps the result of each join (joined, member key pending, expired) instead of the row silently disappearing, and failures stay on the row with a retry action.
- Clearer errors when joining: an expired or mistyped join code, a wrong password, or an unreachable relay each get a plain explanation.

### Fixes

- Fixed flags such as `--no-wait` and `--no-restart` being ignored when placed before the relay address.

---

## 中文

### 改进

- 使用加入码执行 `vibeterm relay join` 时会等待批准，并以明确结果结束：成功显示「加入成功。」，失败显示「加入失败：…」及原因。加 `--no-wait` 可立即返回。
- 确认新机器加入改为一次两步操作并显示进度；使用通行密钥时会事先提示需验证两次，两步都完成后才提示「节点已加入」。
- 节点设置页会保留每次加入的结果（已加入、成员密钥待补发、已过期），不再直接消失；失败原因留在该行并可重试。
- 加入失败的提示更清楚：加入码过期或输错、密码错误、中继无法连接等情况都有直白说明。

### 修复

- 修复 `--no-wait`、`--no-restart` 等开关写在中继地址之前时被忽略的问题。
