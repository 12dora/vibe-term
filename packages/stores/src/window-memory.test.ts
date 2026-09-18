import { describe, expect, test } from 'bun:test';
import {
  WINDOW_MEMORY_STALE_MS,
  type WindowMemoryEvent,
  type WindowMemoryMap,
  acceptsWindowMemory,
  applyWindowMemory,
  composeWindowMemorySample,
  dropWindowMemoryForDevice,
  freshWindowMemory,
  pruneWindowMemoryWindows,
  selectWindowMemoryField,
  windowMemoryExpiryDelayMs,
} from './window-memory';

const NOW = 1_700_000_000_000;

function frame(overrides: Partial<WindowMemoryEvent> = {}): WindowMemoryEvent {
  return {
    type: 'window-memory',
    deviceId: 'device-a',
    windowId: '@1',
    current: 1_073_741_824,
    high: 8_589_934_592,
    max: 12_884_901_888,
    swapMax: 0,
    oomKills: 0,
    oomFlag: false,
    panes: 2,
    sampledAt: NOW,
    source: 'cgroup',
    ...overrides,
  };
}

describe('applyWindowMemory', () => {
  test('按 deviceId → windowId 落地，并本地盖章 receivedAt', () => {
    const map = applyWindowMemory({}, frame(), 5_000);
    expect(map['device-a']?.['@1']).toEqual({
      current: 1_073_741_824,
      high: 8_589_934_592,
      max: 12_884_901_888,
      swapMax: 0,
      oomKills: 0,
      oomFlag: false,
      panes: 2,
      sampledAt: NOW,
      receivedAt: 5_000,
      source: 'cgroup',
    });
  });

  test('同一设备的多个窗口互不覆盖', () => {
    const first = applyWindowMemory({}, frame(), 5_000);
    const second = applyWindowMemory(first, frame({ windowId: '@2', current: 42 }), 6_000);
    expect(Object.keys(second['device-a'] ?? {})).toEqual(['@1', '@2']);
    expect(second['device-a']?.['@2']?.current).toBe(42);
  });

  test('读数不变但采样时刻前进的心跳帧也要落地：它是「还在上报」的唯一证据', () => {
    const first = applyWindowMemory({}, frame(), 5_000);
    const second = applyWindowMemory(first, frame({ sampledAt: NOW + 30_000 }), 35_000);
    expect(second).not.toBe(first);
    expect(second['device-a']?.['@1']?.receivedAt).toBe(35_000);
  });

  test('乱序旧帧与完全重复的帧都不写（返回同一引用）', () => {
    const first = applyWindowMemory({}, frame(), 5_000);
    expect(applyWindowMemory(first, frame({ sampledAt: NOW - 1, current: 99 }), 9_000)).toBe(first);
    expect(applyWindowMemory(first, frame(), 9_000)).toBe(first);
  });

  test('同一采样时刻读数变了算新消息', () => {
    const first = applyWindowMemory({}, frame(), 5_000);
    const second = applyWindowMemory(first, frame({ current: 2_000 }), 9_000);
    expect(second['device-a']?.['@1']?.current).toBe(2_000);
    expect(second['device-a']?.['@1']?.receivedAt).toBe(9_000);
  });
});

describe('acceptsWindowMemory', () => {
  test('oomFlag / panes 的变化同样算新读数', () => {
    const sample = applyWindowMemory({}, frame(), 5_000)['device-a']?.['@1'];
    if (!sample) throw new Error('sample missing');
    expect(acceptsWindowMemory(sample, frame({ oomFlag: true }))).toBe(true);
    expect(acceptsWindowMemory(sample, frame({ panes: 3 }))).toBe(true);
    expect(acceptsWindowMemory(sample, frame({ source: 'rss' }))).toBe(true);
    expect(acceptsWindowMemory(sample, frame())).toBe(false);
  });
});

describe('dropWindowMemoryForDevice / pruneWindowMemoryWindows', () => {
  const map: WindowMemoryMap = applyWindowMemory(
    applyWindowMemory({}, frame(), 5_000),
    frame({ windowId: '@2' }),
    5_000
  );

  test('断开的设备整条摘掉；没有记录时原样返回', () => {
    expect(dropWindowMemoryForDevice(map, 'device-a')['device-a']).toBeUndefined();
    expect(dropWindowMemoryForDevice(map, 'device-b')).toBe(map);
  });

  test('快照里没有的窗口摘掉，全在就不制造新引用', () => {
    expect(pruneWindowMemoryWindows(map, 'device-a', ['@1', '@2'])).toBe(map);
    const pruned = pruneWindowMemoryWindows(map, 'device-a', ['@2']);
    expect(Object.keys(pruned['device-a'] ?? {})).toEqual(['@2']);
    expect(pruneWindowMemoryWindows(map, 'device-a', [])['device-a']).toBeUndefined();
    expect(pruneWindowMemoryWindows(map, 'device-b', [])).toBe(map);
  });
});

describe('selectWindowMemoryField', () => {
  const map = applyWindowMemory({}, frame({ oomFlag: false, swapMax: 0 }), 5_000);

  test('逐字段读；0 / false 不被当成缺席', () => {
    expect(selectWindowMemoryField(map, 'device-a', '@1', 'current')).toBe(1_073_741_824);
    expect(selectWindowMemoryField(map, 'device-a', '@1', 'swapMax')).toBe(0);
    expect(selectWindowMemoryField(map, 'device-a', '@1', 'oomFlag')).toBe(false);
  });

  test('设备 / 窗口缺席或无记录一律 null', () => {
    expect(selectWindowMemoryField(map, undefined, '@1', 'current')).toBeNull();
    expect(selectWindowMemoryField(map, 'device-a', undefined, 'current')).toBeNull();
    expect(selectWindowMemoryField(map, 'device-a', '@9', 'current')).toBeNull();
    expect(selectWindowMemoryField(map, 'device-b', '@1', 'current')).toBeNull();
  });
});

describe('composeWindowMemorySample', () => {
  const fields = {
    current: 1,
    high: 0,
    max: 0,
    swapMax: 0,
    oomKills: 0,
    oomFlag: false,
    panes: 1,
    sampledAt: NOW,
    receivedAt: NOW,
    source: 'cgroup' as const,
  };

  test('字段齐了才装配得出样本', () => {
    expect(composeWindowMemorySample(fields)).toEqual(fields);
    expect(composeWindowMemorySample({ ...fields, current: null })).toBeNull();
    expect(composeWindowMemorySample({ ...fields, oomFlag: null })).toBeNull();
    expect(composeWindowMemorySample({ ...fields, receivedAt: null })).toBeNull();
    expect(composeWindowMemorySample({ ...fields, source: null })).toBeNull();
  });
});

describe('freshWindowMemory', () => {
  const sample = applyWindowMemory({}, frame(), NOW)['device-a']?.['@1'] ?? null;

  test('超过三次心跳没有新帧就当它不再上报', () => {
    expect(freshWindowMemory(sample, NOW + WINDOW_MEMORY_STALE_MS - 1)).toBe(sample);
    expect(freshWindowMemory(sample, NOW + WINDOW_MEMORY_STALE_MS)).toBeNull();
    expect(freshWindowMemory(null, NOW)).toBeNull();
  });

  test('到达时刻不可信时不判过期，也不安排定时器', () => {
    expect(windowMemoryExpiryDelayMs(null, NOW)).toBeNull();
    expect(windowMemoryExpiryDelayMs(0, NOW)).toBeNull();
    expect(windowMemoryExpiryDelayMs(Number.NaN, NOW)).toBeNull();
    expect(windowMemoryExpiryDelayMs(NOW, NOW + 1_000)).toBe(WINDOW_MEMORY_STALE_MS - 1_000);
  });
});
