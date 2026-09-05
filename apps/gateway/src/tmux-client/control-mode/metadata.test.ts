import { describe, expect, test } from 'bun:test';
import { ControlModeMetadataBridge } from './metadata';

describe('ControlModeMetadataBridge', () => {
  test('parses layout, rename, pane and subscription metadata', () => {
    const bridge = new ControlModeMetadataBridge();
    expect(bridge.parse({ type: 'layout-change', args: '@1 x y !', raw: '' })).toEqual({
      type: 'layout-change',
      windowId: '@1',
      layout: 'x',
    });
    expect(bridge.parse({ type: 'window-renamed', args: '@1 zsh', raw: '' })).toEqual({
      type: 'window-renamed',
      windowId: '@1',
      name: 'zsh',
    });
    expect(bridge.parse({ type: 'unlinked-window-close', args: '@2', raw: '' })).toEqual({
      type: 'window-close',
      windowId: '@2',
    });
    expect(
      bridge.parse({
        type: 'subscription-changed',
        args: 'tmex-cwd $1 @1 0 %7 : /work/tree with spaces',
        raw: '',
      })
    ).toEqual({ type: 'pane-current-path', paneId: '%7', currentPath: '/work/tree with spaces' });
  });

  test('session-renamed uses session-changed id when tmux only sends the name', () => {
    const bridge = new ControlModeMetadataBridge();
    expect(bridge.parse({ type: 'session-renamed', args: 'new-name', raw: '' })).toBeNull();
    expect(bridge.parse({ type: 'session-changed', args: '$0 t1', raw: '' })).toBeNull();
    expect(bridge.parse({ type: 'session-renamed', args: 'new-name', raw: '' })).toEqual({
      type: 'session-renamed',
      sessionId: '$0',
      name: 'new-name',
    });
    expect(bridge.parse({ type: 'session-renamed', args: 'my new name', raw: '' })).toEqual({
      type: 'session-renamed',
      sessionId: '$0',
      name: 'my new name',
    });
  });

  test('session-renamed treats a leading $N token as the name, not a session id', () => {
    const bridge = new ControlModeMetadataBridge();
    expect(bridge.parse({ type: 'session-renamed', args: '$3 renamed', raw: '' })).toBeNull();
    expect(bridge.parse({ type: 'session-changed', args: '$0 old', raw: '' })).toBeNull();
    expect(bridge.parse({ type: 'session-renamed', args: '$3 renamed', raw: '' })).toEqual({
      type: 'session-renamed',
      sessionId: '$0',
      name: '$3 renamed',
    });
  });
});

describe('parking window events never reach the frontend', () => {
  function bridgeWithParking(windowId = '@9'): ControlModeMetadataBridge {
    const bridge = new ControlModeMetadataBridge();
    bridge.noteParkingWindow(windowId);
    return bridge;
  }

  test('activating the parking window is not reported', () => {
    const bridge = bridgeWithParking();
    expect(bridge.parse({ type: 'session-window-changed', args: '$0 @9', raw: '' })).toBeNull();
    expect(bridge.parse({ type: 'session-window-changed', args: '$0 @1', raw: '' })).toEqual({
      type: 'session-window-changed',
      sessionId: '$0',
      windowId: '@1',
    });
  });

  test('closing the parking window is not reported and forgets its id', () => {
    const bridge = bridgeWithParking();
    expect(bridge.isParkingWindow('@9')).toBe(true);
    expect(bridge.parse({ type: 'window-close', args: '@9', raw: '' })).toBeNull();
    expect(bridge.isParkingWindow('@9')).toBe(false);
    expect(bridge.parse({ type: 'window-close', args: '@1', raw: '' })).toEqual({
      type: 'window-close',
      windowId: '@1',
    });
  });

  test('a rename to the parking name is swallowed and learns the id', () => {
    const bridge = new ControlModeMetadataBridge();
    expect(bridge.parse({ type: 'window-renamed', args: '@7 tmex-park', raw: '' })).toBeNull();
    expect(bridge.isParkingWindow('@7')).toBe(true);
    expect(bridge.parse({ type: 'window-renamed', args: '@7 zsh', raw: '' })).toBeNull();
  });

  test('only the most recent parking ids are remembered', () => {
    const bridge = new ControlModeMetadataBridge();
    for (const id of ['@1', '@2', '@3', '@4', '@5']) bridge.noteParkingWindow(id);
    expect(bridge.isParkingWindow('@1')).toBe(false);
    expect(bridge.isParkingWindow('@5')).toBe(true);
    bridge.noteParkingWindow(null);
    expect(bridge.isParkingWindow('@5')).toBe(true);
  });
});
