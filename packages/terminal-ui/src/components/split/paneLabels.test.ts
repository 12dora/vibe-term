import { describe, expect, test } from 'bun:test';
import type { TmuxPane } from '@tmex/shared';
import { paneDisplayName, paneMetaText } from './paneLabels';

const pane = (partial: Partial<TmuxPane>): TmuxPane => partial as TmuxPane;

describe('paneDisplayName', () => {
  test('prefers the custom name, then the title, then a fallback', () => {
    expect(paneDisplayName(pane({ customName: ' build ', title: 'zsh' }))).toBe('build');
    expect(paneDisplayName(pane({ customName: '   ', title: ' zsh ' }))).toBe('zsh');
    expect(paneDisplayName(pane({}))).toBe('Pane');
    expect(paneDisplayName(undefined)).toBe('Pane');
  });
});

describe('paneMetaText', () => {
  test('joins command and path, and omits the path when absent', () => {
    expect(paneMetaText(pane({ currentCommand: 'vim', currentPath: '/tmp' }))).toBe('vim@/tmp');
    expect(paneMetaText(pane({ currentCommand: ' vim ', currentPath: '  ' }))).toBe('vim');
  });

  test('no command means no meta line', () => {
    expect(paneMetaText(pane({ currentPath: '/tmp' }))).toBeNull();
    expect(paneMetaText(undefined)).toBeNull();
  });
});
