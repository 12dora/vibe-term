// 分享日志的回放时间轴：把日志条目整理成「按 pane 分流、按相对时间排布」的事件序列，
// 并给出「跳到某一时刻要做哪些事」的纯计算。终端实例、定时器、DOM 都不在这里。
//
// 一条日志有四种条目：checkpoint（该 pane 的整屏快照 + 当时的行列数）、out（输出字节）、
// resize（行列变化）、in（被分享人的输入，只作标记展示，绝不写回终端）。
// 回放靠 checkpoint 做随机访问：跳到 t 时先回到 t 之前最后一个 checkpoint，再把中间的
// 事件快进一遍——所以 checkpoint 的下标要在建索引时就记下来。

import { DEFAULT_LOCALE, type LocaleCode, formatDate, toBCP47 } from '@vibeterm/shared';
import type { ShareLogEntry, ShareLogKind } from '@vibeterm/shared/share';

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
  /** 带行列数的事件（checkpoint / resize）的下标与网格，升序；供 `replayGridAt` 二分。 */
  grids: ReplayGridAt[];
}

export interface ReplayGridAt {
  index: number;
  cols: number;
  rows: number;
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

function logSpan(entries: readonly ShareLogEntry[]): { startAt: number; endAt: number } {
  let startAt = entries[0].at;
  let endAt = entries[0].at;
  for (const entry of entries) {
    if (entry.at < startAt) startAt = entry.at;
    if (entry.at > endAt) endAt = entry.at;
  }
  return { startAt, endAt };
}

function paneFor(byPane: Map<string, ReplayPane>, paneId: string): ReplayPane {
  const existing = byPane.get(paneId);
  if (existing) return existing;
  const pane: ReplayPane = { paneId, bytes: 0, events: [], checkpoints: [], grids: [] };
  byPane.set(paneId, pane);
  return pane;
}

/**
 * 把一条事件并进 pane，顺手记下 checkpoint 与网格的下标。
 *
 * 时间戳回退的条目按同 pane 的前一条拉平：`countEventsUntil` 与 `replayGridAt` 都在 `t` 上二分，
 * 序列一旦非单调，二分给出的答案就是错的。
 */
function appendPaneEvent(pane: ReplayPane, event: ReplayEvent): void {
  const prev = pane.events[pane.events.length - 1];
  if (prev && event.t < prev.t) event.t = prev.t;
  if (event.kind === 'checkpoint') pane.checkpoints.push(pane.events.length);
  if (event.cols !== null && event.rows !== null) {
    pane.grids.push({ index: pane.events.length, cols: event.cols, rows: event.rows });
  }
  if (event.kind === 'out') pane.bytes += event.bytes;
  pane.events.push(event);
}

/** 建时间轴。条目按 seq 升序（服务端保证），时间轴起点取最早的 `at`。 */
export function buildReplayTimeline(entries: readonly ShareLogEntry[]): ReplayTimeline {
  if (entries.length === 0) return { startAt: 0, durationMs: 0, panes: [] };

  const { startAt, endAt } = logSpan(entries);
  const byPane = new Map<string, ReplayPane>();
  for (const entry of entries) {
    appendPaneEvent(paneFor(byPane, entry.paneId), toEvent(entry, startAt));
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

export interface ReplayGrid {
  cols: number;
  rows: number;
}

/**
 * t 时刻（含）之前最后一条带行列数的事件（checkpoint / resize）给出的网格；没有则 null。
 *
 * 只有 checkpoint 与 resize 带行列数，而 checkpoint 通常只在 pane 首次纳入时打一次：
 * 线性回扫在长录像的片尾要从末尾一路扫回 0，改在 `pane.grids` 上二分。
 */
export function replayGridAt(pane: ReplayPane, t: number): ReplayGrid | null {
  const limit = countEventsUntil(pane, t) - 1;
  if (limit < 0) return null;
  let low = 0;
  let high = pane.grids.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (pane.grids[mid].index <= limit) low = mid + 1;
    else high = mid;
  }
  const found = pane.grids[low - 1];
  return found ? { cols: found.cols, rows: found.rows } : null;
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

/** 拖动/键盘改进度后，预览标签延迟这么久再收起。 */
export const REPLAY_PREVIEW_HIDE_MS = 800;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const REPLAY_TICK_STEPS_MS = [
  1_000,
  5_000,
  10_000,
  30_000,
  60_000,
  300_000,
  900_000,
  HOUR_MS,
  2 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  7 * DAY_MS,
] as const;
const REPLAY_TICK_HARD_CAP = 24;
const REPLAY_MINOR_TICK_CAP = 60;

function replayLocaleCode(language: string | undefined): LocaleCode {
  if (!language) return DEFAULT_LOCALE;
  const compact = language.replace('-', '_');
  if (compact === 'zh_CN' || compact === 'en_US' || compact === 'ja_JP') return compact;
  return DEFAULT_LOCALE;
}

/** 墙钟 `HH:mm:ss`（24 小时制，本地时区）。非法时间出空串。 */
export function formatReplayWallClock(epochMs: number, language?: string): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat(toBCP47(replayLocaleCode(language)), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const second = parts.find((part) => part.type === 'second')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

/** 跨日时在起点下补的日期；非法时间出空串。 */
export function formatReplayDate(epochMs: number, language?: string): string {
  return formatDate(epochMs, replayLocaleCode(language));
}

export function replayCrossesCalendarDay(startAt: number, durationMs: number): boolean {
  const start = new Date(startAt);
  const end = new Date(startAt + Math.max(0, durationMs));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return start.toDateString() !== end.toDateString();
}

export function replayPreviewRatio(ms: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return clampReplayTime(ms, durationMs) / durationMs;
}

function replayTickCap(widthPx?: number): number {
  if (widthPx === undefined || !Number.isFinite(widthPx) || widthPx <= 0) return 12;
  return Math.max(4, Math.min(12, Math.floor(widthPx / 48)));
}

function replayFallbackStepMs(duration: number, cap: number): number {
  const raw = Math.ceil(duration / cap);
  return Math.max(HOUR_MS, Math.ceil(raw / HOUR_MS) * HOUR_MS);
}

/** 选 ~4–12 个主刻度；档位用尽时按时长/上限向上取整到整小时，硬上限 24。 */
export function planReplayTicks(
  durationMs: number,
  widthPx?: number
): { stepMs: number; ticks: number[] } {
  const duration = Math.max(0, durationMs);
  if (duration <= 0) return { stepMs: REPLAY_TICK_STEPS_MS[0], ticks: [0] };

  const cap = replayTickCap(widthPx);
  let stepMs: number | null = null;
  for (const step of REPLAY_TICK_STEPS_MS) {
    if (Math.floor(duration / step) + 1 <= cap) {
      stepMs = step;
      break;
    }
  }
  if (stepMs === null) stepMs = replayFallbackStepMs(duration, cap);

  const ticks: number[] = [];
  for (let t = 0; t <= duration && ticks.length < REPLAY_TICK_HARD_CAP; t += stepMs) {
    ticks.push(t);
  }
  return { stepMs, ticks };
}

/** 主刻度之间的次刻度；1 秒档太密，超过 60 个也不画。 */
export function planReplayMinorTicks(durationMs: number, stepMs: number): number[] {
  if (durationMs <= 0 || stepMs < 5_000) return [];
  const minor = stepMs / 5;
  if (minor < 1_000) return [];
  const ticks: number[] = [];
  for (let t = minor; t < durationMs; t += minor) {
    if (t % stepMs !== 0) ticks.push(t);
    if (ticks.length > REPLAY_MINOR_TICK_CAP) return [];
  }
  return ticks;
}

export function replayScrubPositionToMs(
  clientX: number,
  rect: { left: number; width: number },
  durationMs: number
): number {
  if (!Number.isFinite(rect.width) || rect.width <= 0) return 0;
  const ratio = (clientX - rect.left) / rect.width;
  return clampReplayTime(ratio * durationMs, durationMs);
}

/** 预览标签中心的像素位置，夹在轨道内不溢出。 */
export function clampReplayPreviewX(ratio: number, trackWidth: number, labelWidth: number): number {
  const width = Math.max(0, trackWidth);
  if (width <= 0) return 0;
  const t = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const half = Math.max(0, labelWidth) / 2;
  if (width <= labelWidth) return width / 2;
  return Math.min(width - half, Math.max(half, t * width));
}
