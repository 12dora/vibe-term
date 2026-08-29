import { describe, expect, test } from 'bun:test';
import {
  GHOSTTY_MOUSE_BUTTON_LEFT,
  GHOSTTY_MOUSE_BUTTON_MIDDLE,
  GHOSTTY_MOUSE_BUTTON_RIGHT,
  type MouseDownInput,
  classifyMouseDown,
  isShiftReportingBypass,
  mouseButtonFromButtons,
  mouseButtonFromEvent,
} from './terminal-pointer-policy';

function input(overrides: Partial<MouseDownInput> = {}): MouseDownInput {
  return {
    reporting: false,
    shiftBypass: false,
    button: GHOSTTY_MOUSE_BUTTON_LEFT,
    platformModifier: false,
    hasLink: () => false,
    ...overrides,
  };
}

describe('pointer button mapping', () => {
  test('maps DOM buttons to ghostty codes', () => {
    expect(mouseButtonFromEvent({ button: 0 } as MouseEvent)).toBe(GHOSTTY_MOUSE_BUTTON_LEFT);
    expect(mouseButtonFromEvent({ button: 1 } as MouseEvent)).toBe(GHOSTTY_MOUSE_BUTTON_MIDDLE);
    expect(mouseButtonFromEvent({ button: 2 } as MouseEvent)).toBe(GHOSTTY_MOUSE_BUTTON_RIGHT);
    expect(mouseButtonFromEvent({ button: 3 } as MouseEvent)).toBeNull();
  });

  test('maps pressed button masks with left taking precedence', () => {
    expect(mouseButtonFromButtons(1)).toBe(GHOSTTY_MOUSE_BUTTON_LEFT);
    expect(mouseButtonFromButtons(4)).toBe(GHOSTTY_MOUSE_BUTTON_MIDDLE);
    expect(mouseButtonFromButtons(2)).toBe(GHOSTTY_MOUSE_BUTTON_RIGHT);
    expect(mouseButtonFromButtons(3)).toBe(GHOSTTY_MOUSE_BUTTON_LEFT);
    expect(mouseButtonFromButtons(0)).toBeNull();
  });
});

describe('shift reporting bypass', () => {
  test('only Shift + left button while reporting bypasses', () => {
    expect(isShiftReportingBypass(true, true, GHOSTTY_MOUSE_BUTTON_LEFT)).toBeTrue();
    expect(isShiftReportingBypass(false, true, GHOSTTY_MOUSE_BUTTON_LEFT)).toBeFalse();
    expect(isShiftReportingBypass(true, false, GHOSTTY_MOUSE_BUTTON_LEFT)).toBeFalse();
    expect(isShiftReportingBypass(true, true, GHOSTTY_MOUSE_BUTTON_RIGHT)).toBeFalse();
    expect(isShiftReportingBypass(true, true, null)).toBeFalse();
  });
});

describe('mousedown classification', () => {
  test('reporting wins over link activation', () => {
    expect(
      classifyMouseDown(input({ reporting: true, platformModifier: true, hasLink: () => true }))
    ).toEqual({
      kind: 'report',
      button: GHOSTTY_MOUSE_BUTTON_LEFT,
      recordBypass: false,
    });
  });

  test('reporting without shift never runs the link hit-test', () => {
    let probes = 0;
    const hasLink = (): boolean => {
      probes += 1;
      return true;
    };

    expect(classifyMouseDown(input({ reporting: true, platformModifier: true, hasLink }))).toEqual({
      kind: 'report',
      button: GHOSTTY_MOUSE_BUTTON_LEFT,
      recordBypass: false,
    });
    expect(
      classifyMouseDown(input({ reporting: true, button: null, platformModifier: true, hasLink }))
    ).toEqual({ kind: 'ignore', recordBypass: false });
    expect(probes).toBe(0);
  });

  test('the link hit-test is skipped without the platform modifier', () => {
    let probes = 0;
    const hasLink = (): boolean => {
      probes += 1;
      return true;
    };

    expect(classifyMouseDown(input({ hasLink }))).toEqual({
      kind: 'beginSelection',
      recordBypass: false,
    });
    expect(classifyMouseDown(input({ button: null, platformModifier: true, hasLink }))).toEqual({
      kind: 'ignore',
      recordBypass: false,
    });
    expect(probes).toBe(0);
  });

  test('reporting forwards non-left buttons', () => {
    expect(
      classifyMouseDown(input({ reporting: true, button: GHOSTTY_MOUSE_BUTTON_RIGHT }))
    ).toEqual({ kind: 'report', button: GHOSTTY_MOUSE_BUTTON_RIGHT, recordBypass: false });
  });

  test('reporting ignores unmappable buttons', () => {
    expect(classifyMouseDown(input({ reporting: true, button: null }))).toEqual({
      kind: 'ignore',
      recordBypass: false,
    });
  });

  test('shift bypass records the transition and falls back to local selection', () => {
    expect(classifyMouseDown(input({ reporting: true, shiftBypass: true }))).toEqual({
      kind: 'beginSelection',
      recordBypass: true,
    });
  });

  test('shift bypass still allows link activation with the platform modifier', () => {
    expect(
      classifyMouseDown(
        input({ reporting: true, shiftBypass: true, platformModifier: true, hasLink: () => true })
      )
    ).toEqual({ kind: 'activateLink', recordBypass: true });
  });

  test('link activation needs both the platform modifier and a hit', () => {
    expect(classifyMouseDown(input({ platformModifier: true, hasLink: () => true }))).toEqual({
      kind: 'activateLink',
      recordBypass: false,
    });
    expect(classifyMouseDown(input({ platformModifier: true, hasLink: () => false }))).toEqual({
      kind: 'beginSelection',
      recordBypass: false,
    });
    expect(classifyMouseDown(input({ platformModifier: false, hasLink: () => true }))).toEqual({
      kind: 'beginSelection',
      recordBypass: false,
    });
  });

  test('local mode ignores non-left buttons even over a link', () => {
    expect(
      classifyMouseDown(
        input({ button: GHOSTTY_MOUSE_BUTTON_MIDDLE, platformModifier: true, hasLink: () => true })
      )
    ).toEqual({ kind: 'ignore', recordBypass: false });
    expect(classifyMouseDown(input({ button: null }))).toEqual({
      kind: 'ignore',
      recordBypass: false,
    });
  });

  test('plain left click starts a local selection', () => {
    expect(classifyMouseDown(input())).toEqual({ kind: 'beginSelection', recordBypass: false });
  });
});
