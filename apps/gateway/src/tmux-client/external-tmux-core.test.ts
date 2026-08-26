import { describe, expect, test } from 'bun:test';

import { hasRenderableTerminalContent, isTmuxServerGoneMessage } from './external-tmux-core';

describe('external tmux core helpers', () => {
  test('hasRenderableTerminalContent ignores empty and whitespace-only screens', () => {
    expect(hasRenderableTerminalContent('')).toBe(false);
    expect(hasRenderableTerminalContent('   \n\t')).toBe(false);
    expect(hasRenderableTerminalContent(' $ ')).toBe(true);
  });

  test('isTmuxServerGoneMessage classifies tmux disappearance strings', () => {
    expect(isTmuxServerGoneMessage("can't find session: tmex")).toBe(true);
    expect(isTmuxServerGoneMessage('no server running on /tmp/tmux-1000/default')).toBe(true);
    expect(isTmuxServerGoneMessage('lost server')).toBe(true);
    expect(isTmuxServerGoneMessage('session not found')).toBe(true);
    expect(isTmuxServerGoneMessage('no such session')).toBe(true);
    expect(isTmuxServerGoneMessage('no sessions')).toBe(true);
    expect(isTmuxServerGoneMessage("can't find pane: %1")).toBe(false);
    expect(isTmuxServerGoneMessage('permission denied')).toBe(false);
  });
});
