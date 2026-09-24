// VibeTerm 实际套过的限额三元组（最近 8 档，落在 gateway KV）。
// 关掉或三项都是 0 时，只释放「当前字节数对得上其中一档」的 scope。
// 对不上的（drop-in、手工 set-property）一律不动。

import { WINDOW_MEMORY_MB_MAX, type WindowMemorySettings } from '@vibeterm/shared';
import { getGatewayKv, setGatewayKv } from '../db/kv';
import { APPLIED_BYTES_TOLERANCE, MIB_BYTES } from './constants';
import { isAllZeroLimits } from './scope-commands';

export const WINDOW_MEMORY_APPLIED_KV_KEY = 'windowMemory.appliedTriples';
export const APPLIED_TRIPLE_LIMIT = 8;

export interface AppliedLimitTriple {
  memoryHighMb: number;
  memoryMaxMb: number;
  memorySwapMaxMb: number;
}

export type AppliedTripleKv = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export interface AppliedTripleBook {
  list(): AppliedLimitTriple[];
  remember(settings: WindowMemorySettings): void;
}

export interface ObservedLimits {
  high: number;
  max: number;
  swapMax: number;
}

export function tripleFromSettings(settings: WindowMemorySettings): AppliedLimitTriple | null {
  if (isAllZeroLimits(settings)) return null;
  return {
    memoryHighMb: settings.memoryHighMb,
    memoryMaxMb: settings.memoryMaxMb,
    memorySwapMaxMb: settings.memorySwapMaxMb,
  };
}

export function tripleKey(triple: AppliedLimitTriple): string {
  return `${triple.memoryHighMb},${triple.memoryMaxMb},${triple.memorySwapMaxMb}`;
}

function isMb(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= WINDOW_MEMORY_MB_MAX
  );
}

function validTriple(value: unknown): AppliedLimitTriple | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!isMb(row.memoryHighMb) || !isMb(row.memoryMaxMb) || !isMb(row.memorySwapMaxMb)) {
    return null;
  }
  if (row.memoryHighMb === 0 && row.memoryMaxMb === 0 && row.memorySwapMaxMb === 0) return null;
  return {
    memoryHighMb: row.memoryHighMb,
    memoryMaxMb: row.memoryMaxMb,
    memorySwapMaxMb: row.memorySwapMaxMb,
  };
}

export function parseAppliedTriples(raw: string | null): AppliedLimitTriple[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return rememberMany([], parsed);
  } catch {
    return [];
  }
}

function rememberMany(
  base: readonly AppliedLimitTriple[],
  items: readonly unknown[]
): AppliedLimitTriple[] {
  let next = base.slice();
  for (const item of items) next = rememberTriple(next, validTriple(item));
  return next;
}

export function rememberTriple(
  triples: readonly AppliedLimitTriple[],
  next: AppliedLimitTriple | null
): AppliedLimitTriple[] {
  if (!next) return triples.slice();
  const key = tripleKey(next);
  const rest = triples.filter((triple) => tripleKey(triple) !== key);
  rest.push(next);
  return rest.slice(-APPLIED_TRIPLE_LIMIT);
}

function sameTriples(
  left: readonly AppliedLimitTriple[],
  right: readonly AppliedLimitTriple[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((triple, index) => tripleKey(triple) === tripleKey(right[index] ?? triple));
}

export function bytesMatchField(observed: number, expectedMb: number): boolean {
  const expected = expectedMb > 0 ? expectedMb * MIB_BYTES : 0;
  if (observed === expected) return true;
  if (expected === 0 || observed <= 0) return false;
  return Math.abs(observed - expected) <= APPLIED_BYTES_TOLERANCE;
}

export function observedMatchesTriple(
  observed: ObservedLimits,
  triple: AppliedLimitTriple
): boolean {
  return (
    bytesMatchField(observed.high, triple.memoryHighMb) &&
    bytesMatchField(observed.max, triple.memoryMaxMb) &&
    bytesMatchField(observed.swapMax, triple.memorySwapMaxMb)
  );
}

export function observedMatchesAny(
  observed: ObservedLimits,
  triples: readonly AppliedLimitTriple[]
): boolean {
  if (observed.high <= 0 && observed.max <= 0 && observed.swapMax <= 0) return false;
  return triples.some((triple) => observedMatchesTriple(observed, triple));
}

function readSafe(kv: AppliedTripleKv): { ok: boolean; triples: AppliedLimitTriple[] } {
  try {
    return { ok: true, triples: parseAppliedTriples(kv.get(WINDOW_MEMORY_APPLIED_KV_KEY)) };
  } catch {
    return { ok: false, triples: [] };
  }
}

export function rememberAppliedOnKv(
  kv: AppliedTripleKv,
  triple: AppliedLimitTriple | null
): AppliedLimitTriple[] {
  const loaded = readSafe(kv);
  const current = loaded.ok ? loaded.triples : [];
  const next = rememberTriple(current, triple);
  if (!loaded.ok || sameTriples(current, next)) return next;
  kv.set(WINDOW_MEMORY_APPLIED_KV_KEY, JSON.stringify(next));
  return next;
}

export function createMemoryAppliedTripleBook(
  initial: readonly AppliedLimitTriple[] = []
): AppliedTripleBook {
  let triples = initial.slice();
  return {
    list: () => triples.slice(),
    remember(settings) {
      triples = rememberTriple(triples, tripleFromSettings(settings));
    },
  };
}

export function createKvAppliedTripleBook(kv: AppliedTripleKv): AppliedTripleBook {
  let overlay: AppliedLimitTriple[] | null = null;
  return {
    list() {
      const loaded = readSafe(kv);
      if (loaded.ok) {
        overlay = loaded.triples;
        return loaded.triples.slice();
      }
      return (overlay ?? []).slice();
    },
    remember(settings) {
      const triple = tripleFromSettings(settings);
      const current = this.list();
      const next = rememberTriple(current, triple);
      overlay = next;
      if (sameTriples(current, next)) return;
      try {
        kv.set(WINDOW_MEMORY_APPLIED_KV_KEY, JSON.stringify(next));
      } catch {
        // 进程内 overlay 仍在；写失败只会少记一档，不会去动对不上的 scope。
      }
    },
  };
}

let singleton: AppliedTripleBook | null = null;

export function getAppliedTripleBook(): AppliedTripleBook {
  singleton ??= createKvAppliedTripleBook({ get: getGatewayKv, set: setGatewayKv });
  return singleton;
}

export function resetAppliedTripleBookForTests(): void {
  singleton = null;
}
