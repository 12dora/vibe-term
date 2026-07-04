import { describe, expect, it } from 'bun:test';

import {
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  getOsc11ResponseColor,
  getTmuxWindowStyle,
} from './appearance';

describe('TERMINAL_THEME_DARK', () => {
  it('matches seoul256-dark reference values', () => {
    expect(TERMINAL_THEME_DARK.background).toBe('#262626');
    expect(TERMINAL_THEME_DARK.foreground).toBe('#d0d0d0');
    expect(TERMINAL_THEME_DARK.cursor).toBe('#c5c5c5');
    expect(TERMINAL_THEME_DARK.selectionBackground).toBe('rgba(197, 197, 197, 0.25)');
    expect(TERMINAL_THEME_DARK.black).toBe('#000000');
    expect(TERMINAL_THEME_DARK.brightWhite).toBe('#d0d0d0');
  });
});

describe('TERMINAL_THEME_LIGHT', () => {
  it('matches seoul256-light reference values', () => {
    expect(TERMINAL_THEME_LIGHT.background).toBe('#e1e1e1');
    expect(TERMINAL_THEME_LIGHT.foreground).toBe('#616161');
    expect(TERMINAL_THEME_LIGHT.cursor).toBe('#616161');
    expect(TERMINAL_THEME_LIGHT.selectionBackground).toBe('rgba(97, 97, 97, 0.25)');
    expect(TERMINAL_THEME_LIGHT.black).toBe('#171717');
    expect(TERMINAL_THEME_LIGHT.brightWhite).toBe('#f1f1f1');
  });
});

describe('getTmuxWindowStyle', () => {
  it('returns fg/bg from dark theme', () => {
    expect(getTmuxWindowStyle('dark')).toBe('fg=#d0d0d0,bg=#262626');
  });

  it('returns fg/bg from light theme', () => {
    expect(getTmuxWindowStyle('light')).toBe('fg=#616161,bg=#e1e1e1');
  });
});

describe('getOsc11ResponseColor', () => {
  it('returns 16-bit per channel rgb for dark background', () => {
    // #262626 -> 0x26 * 0x101 = 0x2626 per channel
    expect(getOsc11ResponseColor('dark')).toBe('rgb:2626/2626/2626');
  });

  it('returns 16-bit per channel rgb for light background', () => {
    // #e1e1e1 -> 0xe1 * 0x101 = 0xe1e1 per channel
    expect(getOsc11ResponseColor('light')).toBe('rgb:e1e1/e1e1/e1e1');
  });

  it('format matches OSC 11 reply spec (rgb:RRRR/GGGG/BBBB)', () => {
    expect(getOsc11ResponseColor('dark')).toMatch(/^rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}$/);
  });
});
