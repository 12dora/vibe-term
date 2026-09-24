import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS, type WindowMemorySettings } from '@vibeterm/shared';

import {
  APPLIED_TRIPLE_LIMIT,
  WINDOW_MEMORY_APPLIED_KV_KEY,
  bytesMatchField,
  createKvAppliedTripleBook,
  createMemoryAppliedTripleBook,
  observedMatchesAny,
  rememberTriple,
  tripleFromSettings,
} from './applied-triples';
import { MIB_BYTES } from './constants';
import { createWindowMemorySettingsStore } from './settings-store';

const defaults = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS };

function triple(high: number, max: number, swap: number) {
  return { memoryHighMb: high, memoryMaxMb: max, memorySwapMaxMb: swap };
}

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    kv: {
      get: (key: string) => data.get(key) ?? null,
      set: (key: string, value: string) => {
        data.set(key, value);
      },
    },
  };
}

describe('applied limit triples', () => {
  test('keeps the last 8 distinct triples, newest at the end', () => {
    let triples = rememberTriple([], triple(1, 2, 3));
    triples = rememberTriple(triples, triple(1, 2, 3));
    expect(triples).toEqual([triple(1, 2, 3)]);
    for (let i = 0; i < APPLIED_TRIPLE_LIMIT + 2; i++) {
      triples = rememberTriple(triples, triple(i + 10, i + 20, 0));
    }
    expect(triples).toHaveLength(APPLIED_TRIPLE_LIMIT);
    expect(triples[0]).toEqual(triple(12, 22, 0));
    expect(triples.at(-1)).toEqual(triple(19, 29, 0));
  });

  test('matches the MB-to-bytes conversion, plus one page, and not a zero field', () => {
    const applied = triple(8192, 12288, 0);
    expect(bytesMatchField(8192 * MIB_BYTES, 8192)).toBe(true);
    expect(bytesMatchField(8192 * MIB_BYTES + 4096, 8192)).toBe(true);
    expect(bytesMatchField(8192 * MIB_BYTES + 8192, 8192)).toBe(false);
    expect(bytesMatchField(4096, 0)).toBe(false);
    expect(bytesMatchField(0, 0)).toBe(true);
    expect(
      observedMatchesAny({ high: 8192 * MIB_BYTES + 4096, max: 12288 * MIB_BYTES, swapMax: 0 }, [
        applied,
      ])
    ).toBe(true);
    expect(
      observedMatchesAny({ high: 2048 * MIB_BYTES, max: 4096 * MIB_BYTES, swapMax: 0 }, [applied])
    ).toBe(false);
  });

  test('all-zero settings are not a triple', () => {
    const zero: WindowMemorySettings = {
      ...defaults,
      memoryHighMb: 0,
      memoryMaxMb: 0,
      memorySwapMaxMb: 0,
    };
    expect(tripleFromSettings(zero)).toBeNull();
    expect(tripleFromSettings({ ...defaults, enabled: false })).toEqual(triple(8192, 12288, 4096));
  });

  test('settings store records a saved finite triple and keeps it when zeroed', () => {
    const { data, kv } = memoryKv();
    const store = createWindowMemorySettingsStore(kv);
    const custom: WindowMemorySettings = {
      ...defaults,
      memoryHighMb: 1024,
      memoryMaxMb: 2048,
      memorySwapMaxMb: 512,
    };
    store.set(custom);
    expect(JSON.parse(data.get(WINDOW_MEMORY_APPLIED_KV_KEY) ?? '')).toEqual([
      triple(1024, 2048, 512),
    ]);
    store.set({ ...custom, memoryHighMb: 0, memoryMaxMb: 0, memorySwapMaxMb: 0 });
    expect(JSON.parse(data.get(WINDOW_MEMORY_APPLIED_KV_KEY) ?? '')).toEqual([
      triple(1024, 2048, 512),
    ]);
  });

  test('first save of all-zero does not invent the in-memory defaults', () => {
    const { data, kv } = memoryKv();
    const store = createWindowMemorySettingsStore(kv);
    store.set({ ...defaults, enabled: false, memoryHighMb: 0, memoryMaxMb: 0, memorySwapMaxMb: 0 });
    expect(data.has(WINDOW_MEMORY_APPLIED_KV_KEY)).toBe(false);
  });

  test('kv book reads back what the tracker remembers, including disabled-with-numbers', () => {
    const { kv } = memoryKv();
    const book = createKvAppliedTripleBook(kv);
    book.remember({ ...defaults, enabled: false });
    const again = createKvAppliedTripleBook(kv);
    expect(again.list()).toEqual([triple(8192, 12288, 4096)]);
    const memory = createMemoryAppliedTripleBook();
    memory.remember(defaults);
    memory.remember({ ...defaults, memoryHighMb: 0, memoryMaxMb: 0, memorySwapMaxMb: 0 });
    expect(memory.list()).toEqual([triple(8192, 12288, 4096)]);
  });
});
