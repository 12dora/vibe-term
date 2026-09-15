import { describe, expect, test } from 'bun:test';
import {
  WINDOW_MEMORY_MB_MAX,
  WINDOW_MEMORY_SETTINGS_DEFAULTS,
  type WindowMemorySettings,
} from '@vibeterm/shared';
import {
  InvalidWindowMemorySettingsError,
  WINDOW_MEMORY_SETTINGS_KV_KEY,
  createWindowMemorySettingsStore,
} from './settings-store';

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    kv: {
      get(key: string): string | null {
        return data.get(key) ?? null;
      },
      set(key: string, value: string): void {
        data.set(key, value);
      },
    },
  };
}

const valid: WindowMemorySettings = {
  enabled: true,
  memoryHighMb: 1024,
  memoryMaxMb: 2048,
  memorySwapMaxMb: 512,
  sampleIntervalSec: 5,
};

describe('createWindowMemorySettingsStore', () => {
  test('缺省与非法落库值都回默认', () => {
    expect(createWindowMemorySettingsStore(memoryKv().kv).get()).toEqual(
      WINDOW_MEMORY_SETTINGS_DEFAULTS
    );
    expect(
      createWindowMemorySettingsStore(
        memoryKv({ [WINDOW_MEMORY_SETTINGS_KV_KEY]: 'not-json' }).kv
      ).get()
    ).toEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS);
    expect(
      createWindowMemorySettingsStore(
        memoryKv({ [WINDOW_MEMORY_SETTINGS_KV_KEY]: JSON.stringify({ enabled: 'yes' }) }).kv
      ).get()
    ).toEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS);
  });

  test('get 把部分 JSON 叠在默认值上', () => {
    const store = createWindowMemorySettingsStore(
      memoryKv({
        [WINDOW_MEMORY_SETTINGS_KV_KEY]: JSON.stringify({ enabled: false, memoryHighMb: 100 }),
      }).kv
    );
    expect(store.get()).toEqual({
      ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
      enabled: false,
      memoryHighMb: 100,
    });
  });

  test('set 写入 kv 并通知订阅者；同值不重复触发', () => {
    const { data, kv } = memoryKv();
    const store = createWindowMemorySettingsStore(kv);
    const seen: WindowMemorySettings[] = [];
    const off = store.subscribe((settings) => {
      seen.push(settings);
    });

    expect(store.set(valid)).toEqual(valid);
    expect(store.get()).toEqual(valid);
    expect(JSON.parse(data.get(WINDOW_MEMORY_SETTINGS_KV_KEY) ?? '')).toEqual(valid);
    expect(seen).toEqual([valid]);

    store.set(valid);
    expect(seen).toEqual([valid]);

    const next = { ...valid, enabled: false };
    store.set(next);
    expect(seen).toEqual([valid, next]);
    off();
    store.set(valid);
    expect(seen).toEqual([valid, next]);
  });

  test('非法值抛 InvalidWindowMemorySettingsError 且不落库', () => {
    const { data, kv } = memoryKv();
    const store = createWindowMemorySettingsStore(kv);
    expect(() => store.set({ ...valid, memoryHighMb: 1.5 })).toThrow(
      InvalidWindowMemorySettingsError
    );
    expect(() => store.set({ ...valid, memoryHighMb: -1 })).toThrow(
      InvalidWindowMemorySettingsError
    );
    expect(() => store.set({ ...valid, memoryHighMb: WINDOW_MEMORY_MB_MAX + 1 })).toThrow(
      InvalidWindowMemorySettingsError
    );
    expect(() => store.set({ ...valid, sampleIntervalSec: 1 })).toThrow(
      InvalidWindowMemorySettingsError
    );
    expect(() => store.set({ ...valid, sampleIntervalSec: 61 })).toThrow(
      InvalidWindowMemorySettingsError
    );
    expect(() => store.set({ ...valid, memoryHighMb: 200, memoryMaxMb: 100 })).toThrow(
      InvalidWindowMemorySettingsError
    );
    expect(() => store.set({ ...valid, enabled: 'yes' })).toThrow(InvalidWindowMemorySettingsError);
    expect(() => store.set({ enabled: true })).toThrow(InvalidWindowMemorySettingsError);
    expect(data.size).toBe(0);
  });

  test('high 或 max 为 0 时不校验 high <= max', () => {
    const store = createWindowMemorySettingsStore(memoryKv().kv);
    expect(store.set({ ...valid, memoryHighMb: 0, memoryMaxMb: 100 })).toMatchObject({
      memoryHighMb: 0,
      memoryMaxMb: 100,
    });
    expect(store.set({ ...valid, memoryHighMb: 200, memoryMaxMb: 0 })).toMatchObject({
      memoryHighMb: 200,
      memoryMaxMb: 0,
    });
  });

  test('读 kv 抛错时按默认处理', () => {
    const store = createWindowMemorySettingsStore({
      get() {
        throw new Error('kv down');
      },
      set() {},
    });
    expect(store.get()).toEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS);
  });
});
