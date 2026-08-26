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
