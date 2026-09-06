// 区间集合运算：接收端的已收位图、推送端的缺口切分都用这一套。

import { type ByteRange, rangeEnd } from './types';

/** 排序 + 合并相邻/重叠区间；长度 ≤ 0 的丢弃。 */
export function normalizeRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r.offset) && Number.isFinite(r.length) && r.length > 0)
    .map((r) => ({ offset: Math.max(0, Math.trunc(r.offset)), length: Math.trunc(r.length) }))
    .sort((a, b) => a.offset - b.offset);
  const out: ByteRange[] = [];
  for (const range of valid) {
    const last = out[out.length - 1];
    if (last && range.offset <= rangeEnd(last)) {
      last.length = Math.max(rangeEnd(last), rangeEnd(range)) - last.offset;
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

export function coveredBytes(ranges: readonly ByteRange[]): number {
  return normalizeRanges(ranges).reduce((sum, r) => sum + r.length, 0);
}

/** `[0, total)` 里没被覆盖的部分。 */
export function complementRanges(total: number, ranges: readonly ByteRange[]): ByteRange[] {
  if (total <= 0) return [];
  const out: ByteRange[] = [];
  let cursor = 0;
  for (const range of normalizeRanges(ranges)) {
    if (range.offset >= total) break;
    if (range.offset > cursor) out.push({ offset: cursor, length: range.offset - cursor });
    cursor = Math.max(cursor, Math.min(total, rangeEnd(range)));
  }
  if (cursor < total) out.push({ offset: cursor, length: total - cursor });
  return out;
}

export function rangesCover(total: number, ranges: readonly ByteRange[]): boolean {
  return total <= 0 || complementRanges(total, ranges).length === 0;
}

/** 把区间再按上限切碎（每次 PUT 的体积上限、进度粒度）。 */
export function chopRanges(ranges: readonly ByteRange[], maxLength: number): ByteRange[] {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return [...ranges];
  const out: ByteRange[] = [];
  for (const range of ranges) {
    if (range.length <= maxLength) {
      out.push({ ...range });
      continue;
    }
    let offset = range.offset;
    const end = rangeEnd(range);
    while (offset < end) {
      const length = Math.min(maxLength, end - offset);
      out.push({ offset, length });
      offset += length;
    }
  }
  return out;
}

/**
 * 把缺口按 `parts` 份等分切开，供并行推送。切出的区间互不相交且完整覆盖缺口；
 * 缺口本身就碎成多段时不再细分——并发度由调用方的工作池控制，不靠段数硬凑。
 */
export function splitRanges(missing: readonly ByteRange[], parts: number): ByteRange[] {
  const normalized = normalizeRanges(missing);
  const count = Math.max(1, Math.trunc(parts));
  if (count === 1 || normalized.length === 0 || normalized.length >= count) return normalized;
  const total = normalized.reduce((sum, r) => sum + r.length, 0);
  const target = Math.max(1, Math.ceil(total / count));
  const out: ByteRange[] = [];
  for (const range of normalized) {
    let offset = range.offset;
    const end = rangeEnd(range);
    while (offset < end) {
      const length = Math.min(target, end - offset);
      out.push({ offset, length });
      offset += length;
    }
  }
  return out;
}
