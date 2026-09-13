# 2.4.3

_2026-09-14_

## English

### New

- Share replay uses the same read-only terminal widget as a normal terminal (font, size, line height, theme, copy). You can select and copy text, and pan a large recording instead of clipping the left columns. The scrubber is a tick-marked timeline that shows the real wall-clock time.
- If system DNS is broken (for example leftover VPN split-DNS), hub and relay dials fall back to DNS-over-HTTPS and reconnect by IP while still verifying the certificate against the hostname. Turn off with `VIBETERM_DIAL_DNS_FALLBACK=off`.

### Fixes

- After a relay failover the old primary can come back as a secondary; health probes run before waiting for in-flight streams to drain.
- A site URL that is really a relay / Hub / tunnel / public-IP origin is no longer offered again as a “self-hosted domain” candidate.
- Concurrent upgrade pushes no longer pin a zero package size.

### Changes

- `vibeterm exec` keeps long-silent commands alive, reports why a stream died, and adds `--script` / `--tail` / `--max-bytes` / `--stdout-file` / `--stderr-file`. `whoami` prints one line when you are not logged in; `login` skips unreachable nodes; `--node` no longer falls back to this machine when the device is missing. Session file path: `VIBETERM_SESSION_FILE`.

### Docs

- Architecture and operations docs cover replay, origin candidates, multi-relay failback, DNS fallback, upgrade `.total` pinning, and the follow-up for a short-lived exec token (KI-16).

---

## 中文

### 新增

- 分享回放改用与普通终端同一套只读组件（字体 / 字号 / 行高 / 主题 / 复制方式），可选区复制，大尺寸录像可平移而不再裁掉左侧列。进度条改为带刻度的时间轴，显示真实操作墙钟。
- 系统 DNS 解析失败时（例如 VPN 残留分流 DNS），上联 / 中继拨号改走 DNS over HTTPS，按 IP + SNI 重拨，证书仍按主机名校验。`VIBETERM_DIAL_DNS_FALLBACK=off` 可关。

### 修复

- 故障转移后原主中继能按退避重新挂成副中继；failback 先做健康检查再等在途流排空。
- 站点 URL 若等于中继 / Hub / 隧道 / 公网 IP 的 origin，不再重复出现成「自建域名」候选。
- 并发 ranged 升级推包不会再把包大小钉成 0。

### 变更

- `vibeterm exec` 为长静默命令保活，并报出断流原因；新增 `--script` / `--tail` / `--max-bytes` / `--stdout-file` / `--stderr-file`。`whoami` 未登录只打一行；`login` 跳过不可达节点；给了 `--node` 却匹配不到设备不再回落到本机。会话文件可用 `VIBETERM_SESSION_FILE` 指定。

### 文档

- 架构与运维文档已同步回放、候选地址去重、多中继 failback、DNS 回退、升级 `.total` 钉死，以及尚未实现的短时 exec 令牌（KI-16）。

