// 侧边栏主题菜单：取值编码（外观项 vs 预设项）与 trigger 上的 e2e 契约属性。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-device-list 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import { THEME_PRESETS } from '@tmex/theme';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeMenuView, parseThemeMenuValue, themeMenuValue } from './theme-menu';

describe('themeMenuValue / parseThemeMenuValue', () => {
  test('无预设时取值编码为当前外观', () => {
    expect(themeMenuValue(null, 'light')).toBe('appearance:light');
    expect(themeMenuValue(null, 'dark')).toBe('appearance:dark');
  });

  test('有预设时取值即预设 id', () => {
    const preset = THEME_PRESETS[0];
    expect(themeMenuValue(preset, 'dark')).toBe(preset);
  });

  test('外观项解析为「清除预设 + 指定外观」', () => {
    expect(parseThemeMenuValue('appearance:light')).toEqual({ preset: null, appearance: 'light' });
    expect(parseThemeMenuValue('appearance:dark')).toEqual({ preset: null, appearance: 'dark' });
  });

  test('预设项解析为预设 id，非法取值返回 null', () => {
    for (const preset of THEME_PRESETS) {
      expect(parseThemeMenuValue(preset)).toEqual({ preset });
    }
    expect(parseThemeMenuValue('appearance:sepia')).toBeNull();
    expect(parseThemeMenuValue('not-a-preset')).toBeNull();
    expect(parseThemeMenuValue(null)).toBeNull();
  });
});

describe('ThemeMenuView', () => {
  test('trigger 带 e2e 契约的 testid 与当前预设/外观属性', () => {
    const preset = THEME_PRESETS[0];
    const html = renderToStaticMarkup(
      <ThemeMenuView appearance="dark" preset={preset} onSelect={() => {}} />
    );

    expect(html).toContain('data-testid="theme-menu-trigger"');
    expect(html).toContain(`data-theme-preset="${preset}"`);
    expect(html).toContain('data-theme-appearance="dark"');
  });

  test('未选预设时 trigger 的 data-theme-preset 为空串', () => {
    const html = renderToStaticMarkup(
      <ThemeMenuView appearance="light" preset={null} onSelect={() => {}} />
    );

    expect(html).toContain('data-theme-preset=""');
    expect(html).toContain('data-theme-appearance="light"');
  });
});
