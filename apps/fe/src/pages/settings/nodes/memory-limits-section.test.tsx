// 「内存限额」段：静态渲染只到「读取中」（无 DOM 测试环境，effect 不跑），
// 因此这里钉住两件事：挂载不炸、以及用到的每一个 i18n key 三语齐全。

import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import enUS from '@vibeterm/shared/i18n/locales/en_US.json';
import jaJP from '@vibeterm/shared/i18n/locales/ja_JP.json';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryLimitsSection } from './memory-limits-section';

const API = {
  get: async () => WINDOW_MEMORY_SETTINGS_DEFAULTS,
  put: async () => WINDOW_MEMORY_SETTINGS_DEFAULTS,
};

const MEMORY_KEYS = [
  'title',
  'description',
  'enabled',
  'high',
  'highHint',
  'max',
  'maxHint',
  'swapMax',
  'interval',
  'intervalHint',
  'unlimitedHint',
  'invalidMb',
  'invalidInterval',
  'highAboveMax',
  'loadFailed',
  'saveFailed',
  'saved',
] as const;

const WINDOW_KEYS = [
  'memory',
  'memoryOom',
  'memoryLimitHigh',
  'memoryLimitMax',
  'memorySwapMax',
  'memoryScope',
] as const;

describe('MemoryLimitsSection', () => {
  test('读取完成前只有一个转圈，不渲染半截表单', () => {
    const html = renderToStaticMarkup(<MemoryLimitsSection api={API} />);
    expect(html).toContain('data-testid="memory-limits-loading"');
    expect(html).not.toContain('data-testid="memory-limits-form"');
  });
});

describe('内存相关 i18n key 三语齐全', () => {
  const locales = { en_US: enUS, zh_CN: zhCN, ja_JP: jaJP } as Record<
    string,
    { translation: Record<string, any> }
  >;

  for (const [code, bundle] of Object.entries(locales)) {
    test(code, () => {
      const memory = bundle.translation.settings.nodes.memory;
      for (const key of MEMORY_KEYS) expect(typeof memory[key]).toBe('string');
      const window = bundle.translation.window;
      for (const key of WINDOW_KEYS) expect(typeof window[key]).toBe('string');
      expect(memory.intervalHint).toContain('{{min}}');
      expect(memory.invalidMb).toContain('{{max}}');
      expect(window.memoryOom).toContain('{{count}}');
    });
  }
});
