// WINDOW_MEMORY（0x0107）载荷：systemd tmux-spawn pane scope 内存按窗口聚合。
// 参考: docs/architecture/ws-borsh-v1-spec.md

import { b } from '@zorsh/zorsh';

// 拥有设备的网关按周期读取每个 pane 的 tmux-spawn-*.scope cgroup 内存文件，按窗口求和后下发；
// 0 表示未设限（cgroup 值为 max）。宿主不支持（非 Linux / 无 cgroup v2 / 无 systemd --user）时不发。
export const WindowMemorySchema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  /** memory.current 求和（字节）。 */
  current: b.u64(),
  /** memory.high（字节，0 = 未设限）。 */
  high: b.u64(),
  /** memory.max（字节，0 = 未设限）。 */
  max: b.u64(),
  /** memory.swap.max（字节，0 = 未设限）。 */
  swapMax: b.u64(),
  /** memory.events 的 oom_kill 求和。 */
  oomKills: b.u32(),
  /** 网关持久化的 OOM 粘性标记。 */
  oomFlag: b.bool(),
  /** 参与聚合的 pane 数。 */
  panes: b.u8(),
  /** 网关采样时刻（Unix ms）。 */
  sampledAt: b.u64(),
});

export type WindowMemoryWire = b.infer<typeof WindowMemorySchema>;
