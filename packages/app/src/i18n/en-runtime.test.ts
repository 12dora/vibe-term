import { afterEach, describe, expect, test } from 'bun:test';
import { en } from './en';
import { enRuntime } from './en-runtime';
import { setLang, t } from './index';
import { zhCN } from './zh-cn';

afterEach(() => {
  setLang('en');
});

describe('enRuntime', () => {
  test('是 CLI 全量英文表的子集，且中文表有对应键', () => {
    for (const [key, value] of Object.entries(enRuntime)) {
      expect(en[key]).toBe(value);
      expect(zhCN[key]).toBeString();
    }
  });

  test('运行时键与 CLI 键在两种语言下都能取到', () => {
    setLang('en');
    expect(t('runtime.started', { url: 'http://127.0.0.1:1' })).toBe(
      'Service started on http://127.0.0.1:1'
    );
    expect(t('cli.error.unknownCommand', { command: 'x' })).toBe(
      (en['cli.error.unknownCommand'] ?? '').replace('{{command}}', 'x')
    );
    setLang('zh-CN');
    expect(t('runtime.notFound')).toBe(zhCN['runtime.notFound'] ?? '');
    expect(t('missing.key')).toBe('missing.key');
  });
});
