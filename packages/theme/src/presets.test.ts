import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { THEME_PRESETS, isThemePreset } from './presets';
import { TERMINAL_SHORTCUT_TOKENS } from './terminal-shortcut-tokens';

describe('THEME_PRESETS', () => {
  test('注册表与 themes.css 的 data-theme-preset 名单一致', () => {
    const css = fs.readFileSync(path.join(import.meta.dir, 'themes.css'), 'utf8');
    const inCss = new Set([...css.matchAll(/data-theme-preset="([a-z-]+)"/g)].map((m) => m[1]));
    expect(new Set(THEME_PRESETS)).toEqual(inCss);
  });

  test('isThemePreset 判定', () => {
    expect(isThemePreset('underground')).toBe(true);
    expect(isThemePreset('not-a-preset')).toBe(false);
    expect(isThemePreset(null)).toBe(false);
  });
});

describe('terminal shortcut tokens', () => {
  test('tokens.generated.css 与 TS 真源一致（重新生成后须复跑）', () => {
    const css = fs.readFileSync(path.join(import.meta.dir, 'tokens.generated.css'), 'utf8');
    expect(css).toContain(`--terminal-shortcut-fg: ${TERMINAL_SHORTCUT_TOKENS.light.fg};`);
    expect(css).toContain(`--terminal-shortcut-bg: ${TERMINAL_SHORTCUT_TOKENS.light.bg};`);
    expect(css).toContain(`--terminal-shortcut-fg: ${TERMINAL_SHORTCUT_TOKENS.dark.fg};`);
    expect(css).toContain(`--terminal-shortcut-bg: ${TERMINAL_SHORTCUT_TOKENS.dark.bg};`);
  });
});
