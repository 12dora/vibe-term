import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import {
  type MemoryLimitsDraft,
  memoryLimitsDraft,
  memoryLimitsEqual,
  parseMemoryLimitsDraft,
  submitMemoryLimits,
} from './memory-limits-form';

function draft(overrides: Partial<MemoryLimitsDraft> = {}): MemoryLimitsDraft {
  return { ...memoryLimitsDraft(WINDOW_MEMORY_SETTINGS_DEFAULTS), ...overrides };
}

describe('memoryLimitsDraft', () => {
  test('记录逐字段变成输入框里的字符串', () => {
    expect(memoryLimitsDraft(WINDOW_MEMORY_SETTINGS_DEFAULTS)).toEqual({
      enabled: true,
      memoryHighMb: '8192',
      memoryMaxMb: '12288',
      memorySwapMaxMb: '4096',
      sampleIntervalSec: '5',
    });
  });
});

describe('parseMemoryLimitsDraft', () => {
  test('合法草稿原样解析，0 表示不设该项', () => {
    const parsed = parseMemoryLimitsDraft(
      draft({ memoryHighMb: '0', memoryMaxMb: '0', memorySwapMaxMb: '0' })
    );
    expect(parsed.errors).toEqual({});
    expect(parsed.settings).toEqual({
      enabled: true,
      memoryHighMb: 0,
      memoryMaxMb: 0,
      memorySwapMaxMb: 0,
      sampleIntervalSec: 5,
    });
  });

  test('非整数 / 负数 / 超上限的 MB 都报错', () => {
    for (const value of ['', ' ', 'abc', '1.5', '-1', '1048577']) {
      const parsed = parseMemoryLimitsDraft(draft({ memoryHighMb: value }));
      expect(parsed.settings).toBeNull();
      expect(parsed.errors.memoryHighMb).toBe('settings.nodes.memory.invalidMb');
    }
    expect(
      parseMemoryLimitsDraft(draft({ memoryHighMb: '1048576', memoryMaxMb: '1048576' })).errors
    ).toEqual({});
  });

  test('采样周期只收 2–60 秒', () => {
    expect(parseMemoryLimitsDraft(draft({ sampleIntervalSec: '1' })).errors.sampleIntervalSec).toBe(
      'settings.nodes.memory.invalidInterval'
    );
    expect(
      parseMemoryLimitsDraft(draft({ sampleIntervalSec: '61' })).errors.sampleIntervalSec
    ).toBe('settings.nodes.memory.invalidInterval');
    expect(parseMemoryLimitsDraft(draft({ sampleIntervalSec: '2' })).errors).toEqual({});
    expect(parseMemoryLimitsDraft(draft({ sampleIntervalSec: '60' })).errors).toEqual({});
  });

  test('两边都设限时软限额不得大于硬限额；任一为 0 则不比较', () => {
    expect(
      parseMemoryLimitsDraft(draft({ memoryHighMb: '9000', memoryMaxMb: '8000' })).errors
        .memoryHighMb
    ).toBe('settings.nodes.memory.highAboveMax');
    expect(
      parseMemoryLimitsDraft(draft({ memoryHighMb: '9000', memoryMaxMb: '0' })).errors
    ).toEqual({});
    expect(
      parseMemoryLimitsDraft(draft({ memoryHighMb: '8000', memoryMaxMb: '8000' })).errors
    ).toEqual({});
  });
});

describe('memoryLimitsEqual', () => {
  test('逐字段比较', () => {
    expect(
      memoryLimitsEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS, { ...WINDOW_MEMORY_SETTINGS_DEFAULTS })
    ).toBe(true);
    expect(
      memoryLimitsEqual(WINDOW_MEMORY_SETTINGS_DEFAULTS, {
        ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
        enabled: false,
      })
    ).toBe(false);
  });
});

describe('submitMemoryLimits', () => {
  test('校验没过就一次请求都不发', async () => {
    let called = false;
    const result = await submitMemoryLimits(draft({ memoryHighMb: 'x' }), async (settings) => {
      called = true;
      return settings;
    });
    expect(called).toBe(false);
    expect(result.saved).toBeNull();
    expect(result.failure).toBeNull();
    expect(result.errors.memoryHighMb).toBe('settings.nodes.memory.invalidMb');
  });

  test('校验通过时整条 PUT，回写网关返回的记录', async () => {
    const sent: unknown[] = [];
    const result = await submitMemoryLimits(draft({ enabled: false }), async (settings) => {
      sent.push(settings);
      return { ...settings, memoryHighMb: 4096 };
    });
    expect(sent).toEqual([{ ...WINDOW_MEMORY_SETTINGS_DEFAULTS, enabled: false }]);
    expect(result.saved?.memoryHighMb).toBe(4096);
    expect(result.errors).toEqual({});
  });

  test('请求失败时把原因交给调用方弹 toast', async () => {
    const result = await submitMemoryLimits(draft(), async () => {
      throw new Error('boom');
    });
    expect(result.saved).toBeNull();
    expect(result.failure).toBe('boom');
  });
});
