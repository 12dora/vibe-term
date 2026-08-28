import { describe, expect, mock, test } from 'bun:test';
import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT, type TerminalThemeColors } from '@tmex/shared';
import { applyTerminalTheme, resolveTerminalThemeProp } from './theme';

const PRESET_COLORS: TerminalThemeColors = {
  ...TERMINAL_THEME_DARK,
  background: '#282a36',
  foreground: '#f8f8f2',
};

describe('resolveTerminalThemeProp', () => {
  test("legacy 'light' / 'dark' 映射到 seoul256 双主题", () => {
    expect(resolveTerminalThemeProp('light')).toBe(TERMINAL_THEME_LIGHT);
    expect(resolveTerminalThemeProp('dark')).toBe(TERMINAL_THEME_DARK);
  });

  test('已解析色板原样透传（引用不变，避免 effect 空转）', () => {
    expect(resolveTerminalThemeProp(PRESET_COLORS)).toBe(PRESET_COLORS);
  });

  test('同一字面量多次解析返回同一引用', () => {
    expect(resolveTerminalThemeProp('dark')).toBe(resolveTerminalThemeProp('dark'));
  });
});

describe('applyTerminalTheme', () => {
  test('把预设色板下发给已挂载实例', () => {
    const setTheme = mock((_theme: TerminalThemeColors) => {});
    expect(applyTerminalTheme({ setTheme }, PRESET_COLORS)).toBe(true);
    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme.mock.calls[0]?.[0]).toBe(PRESET_COLORS);
  });

  test('legacy 字面量先解析再下发', () => {
    const setTheme = mock((_theme: TerminalThemeColors) => {});
    applyTerminalTheme({ setTheme }, 'light');
    expect(setTheme.mock.calls[0]?.[0]).toBe(TERMINAL_THEME_LIGHT);
  });

  test('实例缺失或引擎不支持 setTheme 时静默跳过', () => {
    expect(applyTerminalTheme(null, 'dark')).toBe(false);
    expect(applyTerminalTheme(undefined, 'dark')).toBe(false);
    expect(applyTerminalTheme({}, 'dark')).toBe(false);
  });
});
