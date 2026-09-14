# 2.5.1

_2026-09-14_

## English

### New

- Access password on the connection details: any node in the tenant now shows the relay access password (masked, with reveal and copy) and can change it right there — enter the current password and a new one; the relay verifies the current password before rotating, and existing member tokens stay valid unless you choose to sign old links out. The node keeps its own encrypted copy after enrolling or re-entering the password, so the row reads "not recorded" on machines that never sent it.

### Changes

- This machine → Relay: the panel is now labelled "Relay" instead of "Upstream", the role badges read "Primary / Secondary", and a relay row shows only its latency by default; the preference index, peers online, TURN probe results and path probe sit behind "More" (hover, focus or tap). The score is now explained as a preference index (lower is better) instead of a misleading millisecond value, and member probe counts say what they count (reports within 30 minutes, excluding this machine).
- Relay operations: the TURN tile is now "TURN Server" under a "NAT Traversal" heading, shows allocations with a unit and the allocation limit (for example `12 / 49 allocations`), and its explanation, endpoint, member probe results and the exact UDP ports to open are listed beside the tile instead of underneath it.

### Fixes

- Tooltips no longer wrap word by word when anchored to a narrow control.
- Access password rotation from a node: a relay that has no access password yet refuses the change with a clear message (the operator sets the first one); rate-limited attempts return a retry hint; when the relay rejects the password this machine had stored, the stored copy is dropped and the dialog asks for the current password; the "members offline" refusal shows how many members are online.
- The upgrade notice for leftover Hub settings no longer claims the role was rewritten when only stale `VIBETERM_HUB_*` keys were removed.

---

## 中文

### 新增

- 链接详情新增「接入密码」：租户内任意节点都能看到中继接入密码（掩码显示，可查看、复制）并直接修改——输入当前密码与新密码，中继核对当前密码后轮换；除非选择「踢出旧令牌」，已有成员保持在线。节点在接入或重新输入密码后会用主密钥加密留存一份，从未发送过密码的机器显示「本机未记录」。

### 变更

- 多节点互联 → 本机：「上级」改为「中继」，角色徽标改为「主 / 副」；中继行默认只显示延迟，优选指数、在线对端、TURN 成员探测与路径探测折进「更多」（悬停、聚焦或点击查看）。「打分 xx ms」改为「优选指数（越低越好）」，成员探测计数说明清楚统计口径（30 分钟内上报、不含本机）。
- 中继运营：TURN 磁贴改为「内网穿透 · TURN 服务器」，分配数带单位并显示上限（如 `12 / 49 分配`）；说明、地址、成员探测与需放行的 UDP 端口列在磁贴右侧。

### 修复

- tooltip 在窄锚点上不再逐字换行。
- 节点侧修改接入密码：中继尚未设置接入密码时明确拒绝（首个密码由运营者设置）；触发限频时返回重试提示；本机留存的旧密码被中继拒绝后自动清掉并改为手输当前密码；「成员离线」的拒绝会显示在线人数。
- 升级时若只是清理残留的 `VIBETERM_HUB_*` 键，提示不再声称改写了角色。
