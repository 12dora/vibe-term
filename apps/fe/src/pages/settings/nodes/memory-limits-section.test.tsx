// 「内存限额」段：静态渲染只到「读取中」（无 DOM 测试环境，effect 不跑），
// 因此这里钉住两件事：挂载不炸、以及用到的每一个 i18n key 三语齐全。

import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import enUS from '@vibeterm/shared/i18n/locales/en_US.json';
import jaJP from '@vibeterm/shared/i18n/locales/ja_JP.json';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryLimitsFields } from './management/memory-limits-fields';
import { memoryLimitsDraft } from './memory-limits-form';
import { MemoryLimitsSection } from './memory-limits-section';
import {
  MemoryLimitsUnsupportedNotice,
  memoryLimitsUnsupportedLines,
} from './memory-limits-unsupported';

const API = {
  get: async () => WINDOW_MEMORY_SETTINGS_DEFAULTS,
  put: async () => WINDOW_MEMORY_SETTINGS_DEFAULTS,
};

const MEMORY_KEYS = [
  'title',
  'description',
  'modeLabel',
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
  'limitsUnsupported',
  'limitsUnsupportedHint',
  'notReleased',
  'staleSample',
] as const;

const WINDOW_KEYS = [
  'memory',
  'memoryOom',
  'memoryLimitHigh',
  'memoryLimitMax',
  'memorySwapMax',
  'memoryScope',
  'memoryLimitUnavailable',
  'memorySourceRss',
  'memoryStale',
] as const;

describe('MemoryLimitsSection', () => {
  test('读取完成前只有一个转圈，不渲染半截表单', () => {
    const html = renderToStaticMarkup(<MemoryLimitsSection api={API} />);
    expect(html).toContain('data-testid="memory-limits-loading"');
    expect(html).not.toContain('data-testid="memory-limits-form"');
  });
});

describe('MemoryLimitsFields', () => {
  const custom = memoryLimitsDraft(WINDOW_MEMORY_SETTINGS_DEFAULTS);

  test('方式二选一是一组单选，带无障碍名', () => {
    const html = renderToStaticMarkup(
      <MemoryLimitsFields draft={custom} errors={{}} idPrefix="memory" onChange={() => {}} />
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="settings.nodes.memory.modeLabel"');
    expect(html).toContain('data-testid="memory-mode-unlimited-input"');
    expect(html).toContain('data-testid="memory-mode-custom-input"');
    expect(html).toContain('id="memory-memoryHighMb"');
  });

  test('额度字段的提示写明「0 只取消这一项」', () => {
    const html = renderToStaticMarkup(
      <MemoryLimitsFields draft={custom} errors={{}} idPrefix="memory" onChange={() => {}} />
    );
    expect(html).toContain('settings.nodes.memory.unlimitedHint');
  });

  test('方式还没选（批量框初始）：两项都不选中，额度输入框不出现', () => {
    const html = renderToStaticMarkup(
      <MemoryLimitsFields
        draft={custom}
        errors={{}}
        idPrefix="bulk"
        mode={null}
        onModeChange={() => {}}
        onChange={() => {}}
      />
    );
    expect(html).not.toContain('data-selected="true"');
    expect(html).not.toContain('bulk-memoryHighMb');
    expect(html).toContain('data-testid="bulk-sampleIntervalSec"');
  });
});

describe('MemoryLimitsUnsupportedNotice', () => {
  // 全量跑时另有测试用 `mock.module` 顶掉了 react-i18next，SSR 里的 `t()` 只会原样回 key，
  // 所以文案装配单独按纯函数断言，SSR 只钉结构。
  const t = (key: string, options?: Record<string, unknown>) =>
    options && 'devices' in options ? `${key}:${options.devices}` : key;

  test('设备名连成一行接进文案', () => {
    expect(memoryLimitsUnsupportedLines(t, ['mac-mini', 'ubuntu-24'])).toEqual([
      'settings.nodes.memory.limitsUnsupported:mac-mini、ubuntu-24',
      'settings.nodes.memory.limitsUnsupportedHint',
    ]);
  });

  test('有受影响的设备就渲染一条警示 Notice', () => {
    const html = renderToStaticMarkup(<MemoryLimitsUnsupportedNotice deviceNames={['mac-mini']} />);
    expect(html).toContain('data-testid="memory-limits-unsupported"');
    expect(html).toContain('settings.nodes.memory.limitsUnsupportedHint');
  });

  test('没有受影响的设备就什么都不渲染', () => {
    expect(renderToStaticMarkup(<MemoryLimitsUnsupportedNotice deviceNames={[]} />)).toBe('');
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
      expect(memory.limitsUnsupported).toContain('{{devices}}');
      for (const mode of ['unlimited', 'custom']) {
        expect(typeof memory.mode[mode].title).toBe('string');
        expect(typeof memory.mode[mode].description).toBe('string');
      }
      expect(memory.notReleased).toContain('{{windows}}');
      expect(memory.staleSample).toContain('{{ago}}');
      expect(window.memoryStale).toContain('{{ago}}');
      expect(typeof bundle.translation.nodes.memory.chooseMode).toBe('string');
    });
  }
});
