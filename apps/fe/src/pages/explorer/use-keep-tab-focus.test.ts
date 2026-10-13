import { describe, expect, test } from 'bun:test';
import { keepsTabFocus } from './use-keep-tab-focus';

describe('keepsTabFocus', () => {
  test('arrow keys keep moving between tabs', () => {
    expect(keepsTabFocus('ArrowLeft')).toBe(true);
    expect(keepsTabFocus('ArrowRight')).toBe(true);
  });

  test('any other key hands focus back to the browser', () => {
    for (const key of ['Tab', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'Escape', 'a']) {
      expect(keepsTabFocus(key)).toBe(false);
    }
  });
});
