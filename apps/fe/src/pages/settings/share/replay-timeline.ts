// 分享日志的回放时间轴：把日志条目整理成「按 pane 分流、按相对时间排布」的事件序列，
// 并给出「跳到某一时刻要做哪些事」的纯计算。终端实例、定时器、DOM 都不在这里。
//
// 一条日志有四种条目：checkpoint（该 pane 的整屏快照 + 当时的行列数）、out（输出字节）、
// resize（行列变化）、in（被分享人的输入，只作标记展示，绝不写回终端）。
// 回放靠 checkpoint 做随机访问：跳到 t 时先回到 t 之前最后一个 checkpoint，再把中间的
// 事件快进一遍——所以 checkpoint 的下标要在建索引时就记下来。

import type { ShareLogEntry, ShareLogKind } from '@tmex/shared/share';

export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** 速度档位循环：1x → 2x → 4x → 8x → 1x。 */
export function nextReplaySpeed(current: ReplaySpeed): ReplaySpeed {
  const at = REPLAY_SPEEDS.indexOf(current);
  return REPLAY_SPEEDS[(at + 1) % REPLAY_SPEEDS.length];
}

export interface ReplayEvent {
  seq: number;
  /** 相对时间轴起点的毫秒数。 */
  t: number;
  kind: ShareLogKind;
  /** base64 载荷；resize 条目为空串。 */
  data: string;
  cols: number | null;
  rows: number | null;
  /** 解码后的字节数，用于挑默认 pane。 */
  bytes: number;
}

export interface ReplayPane {
  paneId: string;
  bytes: number;
  events: ReplayEvent[];
  /** events 中 checkpoint 的下标，升序。 */
  checkpoints: number[];
}

export interface ReplayTimeline {
  /** 时间轴起点（epoch ms）；空日志为 0。 */
  startAt: number;
  durationMs: number;
  /** 按字节数降序：默认选中内容最多的那个 pane。 */
  panes: ReplayPane[];
}

/** base64 串解码后的字节数（不解码，只算长度）。 */
export function base64ByteLength(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function toEvent(entry: ShareLogEntry, startAt: number): ReplayEvent {
  const data = entry.kind === 'resize' ? '' : entry.data;
  return {
    seq: entry.seq,
    t: Math.max(0, entry.at - startAt),
    kind: entry.kind,
    data,
    cols: entry.cols ?? null,
    rows: entry.rows ?? null,
    bytes: base64ByteLength(data),
  };
}

/**
 * 建时间轴。条目按 seq 升序（服务端保证），时间轴起点取最早的 `at`——
 * 个别条目时间戳回退时按 0 处理，不让进度条出现负数。
 */
export function buildReplayTimeline(entries: readonly ShareLogEntry[]): ReplayTimeline {
  if (entries.length === 0) return { startAt: 0, durationMs: 0, panes: [] };

  let startAt = entries[0].at;
  let endAt = entries[0].at;
  for (const entry of entries) {
    if (entry.at < startAt) startAt = entry.at;
    if (entry.at > endAt) endAt = entry.at;
  }

  const byPane = new Map<string, ReplayPane>();
  for (const entry of entries) {
    let pane = byPane.get(entry.paneId);
    if (!pane) {
      pane = { paneId: entry.paneId, bytes: 0, events: [], checkpoints: [] };
      byPane.set(entry.paneId, pane);
    }
    const event = toEvent(entry, startAt);
    if (event.kind === 'checkpoint') pane.checkpoints.push(pane.events.length);
    if (event.kind === 'out') pane.bytes += event.bytes;
    pane.events.push(event);
  }

  const panes = [...byPane.values()].sort(
    (a, b) => b.bytes - a.bytes || (a.paneId < b.paneId ? -1 : 1)
  );
  return { startAt, durationMs: Math.max(0, endAt - startAt), panes };
}

export function findReplayPane(timeline: ReplayTimeline, paneId: string | null): ReplayPane | null {
  if (paneId === null) return timeline.panes[0] ?? null;
  return timeline.panes.find((pane) => pane.paneId === paneId) ?? timeline.panes[0] ?? null;
}

/** t 时刻（含）之前最后一个 checkpoint 的下标；没有则 -1。 */
export function findCheckpointIndex(pane: ReplayPane, t: number): number {
  let found = -1;
  for (const index of pane.checkpoints) {
    if (pane.events[index].t > t) break;
    found = index;
  }
  return found;
}

/** t 时刻（含）之前的事件条数，也就是下一条待播事件的下标。 */
export function countEventsUntil(pane: ReplayPane, t: number): number {
  let low = 0;
  let high = pane.events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (pane.events[mid].t <= t) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface ReplaySeek {
  /** 需要先清空终端（往回跳，或换了 pane）。 */
  reset: boolean;
  /** 起始下标（含）。 */
  fromIndex: number;
  /** 结束下标（不含），同时是跳完之后的游标。 */
  toIndex: number;
}

/**
 * 跳到 `targetMs` 的执行计划。`cursor` 是当前已播到的下标；
 * 往前走就接着播，往回走（或传 `Number.POSITIVE_INFINITY` 强制重建）则从目标之前最后一个
 * checkpoint 起重放。
 */
export function planReplaySeek(pane: ReplayPane, targetMs: number, cursor: number): ReplaySeek {
  const toIndex = countEventsUntil(pane, targetMs);
  if (cursor <= toIndex && Number.isFinite(cursor)) {
    return { reset: false, fromIndex: Math.max(0, cursor), toIndex };
  }
  const checkpoint = findCheckpointIndex(pane, targetMs);
  return { reset: true, fromIndex: Math.max(0, checkpoint), toIndex };
}

export type ReplayOp =
  | { kind: 'resize'; cols: number; rows: number }
  /** 连续的输出合并成一条：base64 分片由调用方各自解码后拼接写入。 */
  | { kind: 'write'; chunks: string[] }
  | { kind: 'input'; t: number; data: string };

function pushWrite(ops: ReplayOp[], chunk: string): void {
  if (chunk === '') return;
  const last = ops[ops.length - 1];
  if (last && last.kind === 'write') last.chunks.push(chunk);
  else ops.push({ kind: 'write', chunks: [chunk] });
}

/** 把 `[fromIndex, toIndex)` 区间的事件翻译成终端操作，顺序即执行顺序。 */
export function collectReplayOps(pane: ReplayPane, fromIndex: number, toIndex: number): ReplayOp[] {
  const ops: ReplayOp[] = [];
  const start = Math.max(0, fromIndex);
  const end = Math.min(pane.events.length, toIndex);
  for (let index = start; index < end; index++) {
    const event = pane.events[index];
    if (event.kind === 'in') {
      ops.push({ kind: 'input', t: event.t, data: event.data });
      continue;
    }
    if (event.cols !== null && event.rows !== null) {
      ops.push({ kind: 'resize', cols: event.cols, rows: event.rows });
    }
    if (event.kind !== 'resize') pushWrite(ops, event.data);
  }
  return ops;
}

export function clampReplayTime(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, durationMs);
}

/** 进度时钟：不足一小时出 `m:ss`，超过出 `h:mm:ss`。 */
export function formatReplayClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
}
