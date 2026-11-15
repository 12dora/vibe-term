import { BELL_DEDUP_WINDOW_MS } from './external/constants';

export const BELL_DEDUP_PRUNE_EVERY_INSERTS = 32;

export interface BellDedupBook {
  entries: Map<string, number>;
  insertsSincePrune: number;
  lastPruneAt: number;
}

export function createBellDedupBook(): BellDedupBook {
  return { entries: new Map(), insertsSincePrune: 0, lastPruneAt: 0 };
}

export function pruneBellDedupEntries(
  entries: Map<string, number>,
  now: number,
  windowMs: number
): void {
  for (const [key, timestamp] of entries) {
    if (now - timestamp >= windowMs) {
      entries.delete(key);
    }
  }
}

export function noteBellDedup(
  book: BellDedupBook,
  key: string,
  now: number,
  windowMs: number = BELL_DEDUP_WINDOW_MS,
  pruneEveryInserts: number = BELL_DEDUP_PRUNE_EVERY_INSERTS
): boolean {
  const previous = book.entries.get(key) ?? 0;
  if (now - previous < windowMs) {
    return false;
  }

  book.entries.set(key, now);
  book.insertsSincePrune += 1;
  if (book.insertsSincePrune >= pruneEveryInserts || now - book.lastPruneAt >= windowMs) {
    pruneBellDedupEntries(book.entries, now, windowMs);
    book.insertsSincePrune = 0;
    book.lastPruneAt = now;
  }
  return true;
}
