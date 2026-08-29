import { describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import {
  buildPaneRoutePath,
  canInteractWithPane,
  hasEnabledWatchRule,
  isWatchRulesQueryEnabled,
  resolveCurrentPane,
  resolveSelectedWindow,
  shouldShowPaneSwitcher,
} from './device-console-action-rules';

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: false, width: 80, height: 24 };
}

function tmuxWindow(id: string, paneIds: string[]): TmuxWindow {
  return { id, name: id, index: 0, active: false, panes: paneIds.map(pane) };
}

const windows = [tmuxWindow('@1', ['%1', '%2']), tmuxWindow('@2', ['%3'])];

describe('resolveSelectedWindow', () => {
  test('finds the window by id', () => {
    expect(resolveSelectedWindow('@2', windows)?.id).toBe('@2');
  });

  test('returns undefined without a window id or window list', () => {
    expect(resolveSelectedWindow(undefined, windows)).toBeUndefined();
    expect(resolveSelectedWindow('@1', undefined)).toBeUndefined();
  });

  test('returns undefined for an unknown window id', () => {
    expect(resolveSelectedWindow('@9', windows)).toBeUndefined();
  });
});

describe('resolveCurrentPane', () => {
  test('finds the pane inside the selected window', () => {
    expect(resolveCurrentPane('%2', windows[0])?.id).toBe('%2');
  });

  test('returns undefined when the pane belongs to another window', () => {
    expect(resolveCurrentPane('%3', windows[0])).toBeUndefined();
  });

  test('returns undefined without a pane id or selected window', () => {
    expect(resolveCurrentPane(undefined, windows[0])).toBeUndefined();
    expect(resolveCurrentPane('%1', undefined)).toBeUndefined();
  });
});

describe('buildPaneRoutePath', () => {
  test('encodes the pane id segment', () => {
    expect(buildPaneRoutePath('dev-1', '@1', '%25')).toBe('/devices/dev-1/windows/@1/panes/%2525');
  });

  test('keeps plain pane ids readable', () => {
    expect(buildPaneRoutePath('dev-1', '@1', '%1')).toBe('/devices/dev-1/windows/@1/panes/%251');
  });
});

describe('canInteractWithPane', () => {
  test('requires both a pane id and a connected device', () => {
    expect(canInteractWithPane('%1', true)).toBe(true);
    expect(canInteractWithPane('%1', false)).toBe(false);
    expect(canInteractWithPane(undefined, true)).toBe(false);
  });
});

describe('isWatchRulesQueryEnabled', () => {
  test('requires the feature flag, device and pane', () => {
    expect(isWatchRulesQueryEnabled(true, 'dev-1', '%1')).toBe(true);
    expect(isWatchRulesQueryEnabled(false, 'dev-1', '%1')).toBe(false);
    expect(isWatchRulesQueryEnabled(true, undefined, '%1')).toBe(false);
    expect(isWatchRulesQueryEnabled(true, 'dev-1', undefined)).toBe(false);
  });
});

describe('hasEnabledWatchRule', () => {
  const rule = (enabled: boolean) => ({ enabled });

  test('is true when any rule is enabled', () => {
    expect(hasEnabledWatchRule([rule(false), rule(true)])).toBe(true);
  });

  test('is false for empty or fully disabled lists', () => {
    expect(hasEnabledWatchRule([])).toBe(false);
    expect(hasEnabledWatchRule([rule(false)])).toBe(false);
    expect(hasEnabledWatchRule(undefined)).toBe(false);
  });
});

describe('shouldShowPaneSwitcher', () => {
  test('shows only on mobile for a multi-pane window with a resolved pane', () => {
    expect(shouldShowPaneSwitcher(true, '%1', windows[0])).toBe(true);
    expect(shouldShowPaneSwitcher(false, '%1', windows[0])).toBe(false);
    expect(shouldShowPaneSwitcher(true, '%3', windows[1])).toBe(false);
    expect(shouldShowPaneSwitcher(true, undefined, windows[0])).toBe(false);
    expect(shouldShowPaneSwitcher(true, '%1', undefined)).toBe(false);
  });
});
