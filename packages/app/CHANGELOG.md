# 2.4.4

_2026-09-14_

## English

### New

- Multiple relays with automatic best-primary selection: enroll up to 16 relays; the node keeps a live link to every relay and, unless you pin one, automatically promotes the relay with the lowest uplink latency (with hysteresis, a 10-minute dwell and a health check, never while relay streams are in flight). "Set as primary" pins; the new "Unpin" (UI, `vibeterm relay unpin`, `vibeterm nodes relay unpin`) hands control back. `relay list` shows AUTO and SCORE columns. Turn off with `VIBETERM_RELAY_AUTO_SELECT=off`.
- With three or more relays advertising TURN, ICE now receives the two TURN servers with the lowest probe latency (previously the third relay's TURN was silently ignored).

### Fixes

- Share replay: the recorded screen is now drawn as a framed, centered "screen" on a darker mat with the recorded size shown next to the clock (for example `52×43`), so recordings made from a narrow phone viewer no longer look like half-lines glued to the right; the mat keeps a visible contrast on near-black themes.
- Relay list: the "Add relay" action explains the 16-relay limit instead of silently disabling.

### Changes

- `vibeterm nodes relay switch` now honours `--node`; scores are rounded; `unpin` reports `{ ok, unpinned }`.

---

## 中文

### 新增

- 多中继与自动优选主中继：最多可加入 16 条中继；节点对每一条都保持连接，未固定时自动把上联延迟最低的中继提升为主中继（带滞环、10 分钟驻留与健康检查，在途中继流未排空时不切换）。「设为主中继」即固定；新增「取消固定」（界面、`vibeterm relay unpin`、`vibeterm nodes relay unpin`）交还自动优选。`relay list` 新增 AUTO 与 SCORE 列。`VIBETERM_RELAY_AUTO_SELECT=off` 可关闭。
- 三条及以上中继广播 TURN 时，ICE 改为接收探测延迟最低的两条 TURN（此前第三条中继的 TURN 会被静默忽略）。

### 修复

- 分享回放：录制的屏幕现在以带边框、居中的「屏幕」画在更暗的衬底上，时钟旁显示录制尺寸（如 `52×43`），手机窄屏查看时录下的回放不再像半截行被贴到右边；近黑主题下衬底仍保持可见对比。
- 中继列表：「追加中继」达到 16 条上限时给出提示，而不是静默禁用。

### 变更

- `vibeterm nodes relay switch` 现在认 `--node`；打分取整；`unpin` 返回 `{ ok, unpinned }`。
