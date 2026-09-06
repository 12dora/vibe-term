// 同一个 `.part` 上的并发闸门。乱序并行写入下光锁位图不够：重叠的两次写入会互相覆盖
// 已确认的字节（位图仍然标记有效），落位时还开着的写入会继续改已经改名的文件。
// 这里给每次写入按区间发预约（重叠即拒），落位前先封住新预约、排空活跃写入，成功后封存该
// 半成品——之后再来的写入一律拒绝，重复落位直接返回第一次的结果。

import type { ByteRange } from '../types';
import { mergeReceivedRange, readReceivedRanges, withPartLock } from './sink-state';

export type WriteToken = { partPath: string; id: number; offset: number; end: number };

export type ReserveResult =
  | { ok: true; token: WriteToken }
  | { ok: false; code: 'sealed' | 'conflict' };

type Gate = {
  active: Map<number, WriteToken>;
  drain: Array<() => void>;
  /** 落位进行中：不再接受新预约。 */
  closing: boolean;
  /** 已落位：这个半成品的生命周期结束了。 */
  sealed: boolean;
  sealedAt: number;
  commit: Promise<unknown> | null;
  result: unknown;
};

const gates = new Map<string, Gate>();
/** 封存记录的保留期：只为挡住迟到的写入与重复落位，远超任何一次会话的时长即可。 */
const SEAL_TTL_MS = 60 * 60 * 1000;
const MAX_GATES = 2048;
let nextTokenId = 1;

function pruneGates(now: number): void {
  for (const [path, gate] of gates) {
    if (!gate.sealed || gate.active.size > 0 || gate.closing) continue;
    if (now - gate.sealedAt > SEAL_TTL_MS) gates.delete(path);
  }
  if (gates.size <= MAX_GATES) return;
  const sealed = [...gates.entries()]
    .filter(([, g]) => g.sealed && g.active.size === 0 && !g.closing)
    .sort((a, b) => a[1].sealedAt - b[1].sealedAt);
  for (const [path] of sealed.slice(0, gates.size - MAX_GATES)) gates.delete(path);
}

function gateOf(partPath: string): Gate {
  const existing = gates.get(partPath);
  if (existing) return existing;
  if (gates.size >= MAX_GATES) pruneGates(Date.now());
  const gate: Gate = {
    active: new Map(),
    drain: [],
    closing: false,
    sealed: false,
    sealedAt: 0,
    commit: null,
    result: undefined,
  };
  gates.set(partPath, gate);
  return gate;
}

function dropIfIdle(partPath: string, gate: Gate): void {
  if (gate.active.size > 0 || gate.closing || gate.sealed || gate.commit) return;
  if (gates.get(partPath) === gate) gates.delete(partPath);
}

function overlaps(a: { offset: number; end: number }, b: { offset: number; end: number }): boolean {
  if (a.end <= a.offset || b.end <= b.offset) return false;
  return a.offset < b.end && b.offset < a.end;
}

function conflictsWithAcknowledged(ranges: readonly ByteRange[], span: WriteToken): boolean {
  return ranges.some((r) => overlaps({ offset: r.offset, end: r.offset + r.length }, span));
}

/**
 * 申请写入区间。`checkAcknowledged` 为真时（乱序模式）还会拒绝与已确认区间重叠的写入——
 * 已经确认过的字节不允许再被改写，否则位图会给出「有效」的谎报。
 */
export function reserveWrite(
  partPath: string,
  range: ByteRange,
  checkAcknowledged: boolean
): Promise<ReserveResult> {
  return withPartLock(partPath, async (): Promise<ReserveResult> => {
    const gate = gateOf(partPath);
    if (gate.sealed) return { ok: false, code: 'sealed' };
    if (gate.closing) return { ok: false, code: 'conflict' };
    const length = Number.isFinite(range.length)
      ? Math.max(0, range.length)
      : Number.MAX_SAFE_INTEGER;
    const token: WriteToken = {
      partPath,
      id: nextTokenId++,
      offset: range.offset,
      end: range.offset + length,
    };
    if (length > 0) {
      for (const other of gate.active.values()) {
        if (overlaps(token, other)) return { ok: false, code: 'conflict' };
      }
      if (checkAcknowledged) {
        const acked = await readReceivedRanges(partPath);
        if (conflictsWithAcknowledged(acked, token)) return { ok: false, code: 'conflict' };
      }
    }
    gate.active.set(token.id, token);
    return { ok: true, token };
  });
}

function release(token: WriteToken): void {
  const gate = gates.get(token.partPath);
  if (!gate) return;
  gate.active.delete(token.id);
  if (gate.active.size === 0) {
    const waiters = gate.drain.splice(0);
    for (const resolve of waiters) resolve();
  }
  dropIfIdle(token.partPath, gate);
}

/** 写完（或写挂了）：在同一个临界区里落位图再释放预约，中间不能有别人插进来。 */
export function finishWrite(token: WriteToken, written: ByteRange | null): Promise<ByteRange[]> {
  return withPartLock(token.partPath, async () => {
    try {
      if (written && written.length > 0) return await mergeReceivedRange(token.partPath, written);
      return await readReceivedRanges(token.partPath);
    } finally {
      release(token);
    }
  });
}

/** 不需要位图的模式（追加写）只放预约。 */
export function releaseWrite(token: WriteToken): void {
  release(token);
}

function drain(gate: Gate): Promise<void> {
  if (gate.active.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => gate.drain.push(resolve));
}

/**
 * 串行化落位：同一个半成品的多次 commit 排队执行，第一次成功后封存，
 * 后续调用直接返回同一个结果（幂等）。落位前排空活跃写入，避免改名后还有人在写。
 */
export function serializeCommit<T>(
  partPath: string,
  place: () => Promise<T>,
  isSuccess: (result: T) => boolean
): Promise<T> {
  const gate = gateOf(partPath);
  const prev = gate.commit ?? Promise.resolve();
  const next = prev.then(async () => {
    if (gate.sealed) return gate.result as T;
    gate.closing = true;
    try {
      await drain(gate);
      const result = await place();
      if (isSuccess(result)) {
        gate.sealed = true;
        gate.sealedAt = Date.now();
        gate.result = result;
      }
      return result;
    } finally {
      gate.closing = false;
    }
  });
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  gate.commit = settled;
  void settled.then(() => {
    if (gate.commit === settled) {
      gate.commit = null;
      dropIfIdle(partPath, gate);
    }
  });
  return next;
}

/** 半成品被丢弃：闸门状态一并作废，同名新会话不会撞上旧的封存。 */
export function forgetPart(partPath: string): void {
  const gate = gates.get(partPath);
  if (!gate || gate.active.size > 0 || gate.closing || gate.commit) return;
  gates.delete(partPath);
}

/** 测试用：清空闸门状态。 */
export function resetPartGates(): void {
  gates.clear();
}
