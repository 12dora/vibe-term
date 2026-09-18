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

/** 读数来源的 wire 值：cgroup 有限额，RSS 没有。 */
export const WINDOW_MEMORY_SOURCE_CGROUP = 0;
export const WINDOW_MEMORY_SOURCE_RSS = 1;

/**
 * v2 载荷：在 v1 十字段尾部追加 `source`。宿主没有 `tmux-spawn-*.scope`（tmux < 3.6 或没带 systemd 支持、
 * 以及 macOS）时网关回退到「pane 进程树 RSS 合计」，此时限额字段恒为 0 且不可用——`source` 是客户端
 * 区分「未设限」与「限不了」的唯一依据。borsh 解码容忍尾部多余字节，老客户端按 v1 schema 解此载荷仍然正确。
 */
export const WindowMemoryV2Schema = b.struct({
  deviceId: b.string(),
  windowId: b.string(),
  current: b.u64(),
  high: b.u64(),
  max: b.u64(),
  swapMax: b.u64(),
  oomKills: b.u32(),
  oomFlag: b.bool(),
  panes: b.u8(),
  sampledAt: b.u64(),
  /** 0 = cgroup（pane systemd scope），1 = 进程树 RSS 合计。 */
  source: b.u8(),
});

export type WindowMemoryV2Wire = b.infer<typeof WindowMemoryV2Schema>;
