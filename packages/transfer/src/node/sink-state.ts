// `.part` 的命名与「已收区间」旁挂文件。
// 追加模式下已收区间就是文件长度，用不上旁挂；并行乱序写入才需要位图，
// 且必须能跨进程重启恢复，所以落在 `<part>.rx` 里而不是只放内存。

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeRanges } from '../ranges';
import type { ByteRange } from '../types';

/** 半成品保留期：超过这个时长没人接着传就当垃圾清掉。 */
export const PART_TTL_MS = 24 * 60 * 60 * 1000;

const PART_MARK = '.part-';
const RANGES_SUFFIX = '.rx';

export function partToken(key: string): string {
  const trimmed = key.trim();
  if (/^[0-9a-f]{16,}$/i.test(trimmed)) return trimmed.slice(0, 16).toLowerCase();
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
}

/** `.part` 名按内容寻址键确定，续传才找得回上一次写到哪。 */
export function deterministicPartPath(destPath: string, key: string): string {
  return `${destPath}${PART_MARK}${partToken(key)}`;
}

export function isPartFileName(name: string): boolean {
  return name.includes(PART_MARK) && !name.endsWith(RANGES_SUFFIX);
}

export function rangesSidecarPath(partPath: string): string {
  return `${partPath}${RANGES_SUFFIX}`;
}

export function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function fileExpired(path: string, now: number, ttlMs: number): boolean {
  try {
    return now - statSync(path).mtimeMs > ttlMs;
  } catch {
    return true;
  }
}

// 乱序写入时多条流会同时改位图，读-改-写必须串起来；泵字节本身在锁外，不影响并行度。
const partLocks = new Map<string, Promise<unknown>>();

export function withPartLock<T>(partPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = partLocks.get(partPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  partLocks.set(partPath, settled);
  void settled.then(() => {
    if (partLocks.get(partPath) === settled) partLocks.delete(partPath);
  });
  return next;
}

/** 记一段已收区间并返回合并后的全集（在锁内完成读-改-写）。 */
export function recordReceivedRange(partPath: string, range: ByteRange): Promise<ByteRange[]> {
  return withPartLock(partPath, async () => {
    const merged = normalizeRanges([...(await readReceivedRanges(partPath)), range]);
    await writeReceivedRanges(partPath, merged);
    return merged;
  });
}

export async function readReceivedRanges(partPath: string): Promise<ByteRange[]> {
  try {
    const raw = await readFile(rangesSidecarPath(partPath), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ranges: ByteRange[] = [];
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [offset, length] = item as [unknown, unknown];
      if (typeof offset !== 'number' || typeof length !== 'number') continue;
      ranges.push({ offset, length });
    }
    return normalizeRanges(ranges);
  } catch {
    return [];
  }
}

export async function writeReceivedRanges(
  partPath: string,
  ranges: readonly ByteRange[]
): Promise<void> {
  const payload = JSON.stringify(normalizeRanges(ranges).map((r) => [r.offset, r.length]));
  await writeFile(rangesSidecarPath(partPath), payload, { mode: 0o600 }).catch(() => {});
}

export async function removeReceivedRanges(partPath: string): Promise<void> {
  await rm(rangesSidecarPath(partPath), { force: true }).catch(() => {});
}

/** 清掉目录里过期的 `.part-*` 及其旁挂；返回删掉的半成品个数。 */
export async function sweepPartFiles(
  dir: string,
  now: number,
  ttlMs = PART_TTL_MS
): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isPartFileName(name)) continue;
    const full = join(dir, name);
    if (!fileExpired(full, now, ttlMs)) continue;
    await rm(full, { force: true }).catch(() => {});
    await removeReceivedRanges(full);
    removed += 1;
  }
  return removed;
}
