import { describe, expect, mock, test } from 'bun:test';
import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT, type TerminalThemeColors } from '@tmex/shared';
import {
  applyTerminalTheme,
  attachTerminalWithLatestTheme,
  resolveTerminalThemeProp,
} from './theme';
import type { TerminalTheme } from './types';

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

describe('attachTerminalWithLatestTheme', () => {
  test('建控制器期间换主题：实例就绪时补发最新配色', async () => {
    const setTheme = mock((_theme: TerminalThemeColors) => {});
    const terminal = { setTheme };
    const ref: { current: typeof terminal | null } = { current: null };
    const latestTheme: { current: TerminalTheme } = { current: TERMINAL_THEME_DARK };

    let ready: (value: typeof terminal) => void = () => {};
    const pending = new Promise<typeof terminal>((resolve) => {
      ready = resolve;
    });
    const boot = pending.then((value) => attachTerminalWithLatestTheme(ref, value, latestTheme));

    // 控制器还没建好时用户选了预设：增量 effect 此刻拿不到实例，空跑
    latestTheme.current = PRESET_COLORS;
    expect(applyTerminalTheme(ref.current, latestTheme.current)).toBe(false);

    ready(terminal);
    await boot;

    expect(ref.current).toBe(terminal);
    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme.mock.calls[0]?.[0]).toBe(PRESET_COLORS);
  });

  test('期间未换主题时下发建控制器时的配色', () => {
    const setTheme = mock((_theme: TerminalThemeColors) => {});
    const terminal = { setTheme };
    const ref: { current: typeof terminal | null } = { current: null };

    attachTerminalWithLatestTheme(ref, terminal, { current: TERMINAL_THEME_LIGHT });

    expect(ref.current).toBe(terminal);
    expect(setTheme.mock.calls[0]?.[0]).toBe(TERMINAL_THEME_LIGHT);
  });
});
