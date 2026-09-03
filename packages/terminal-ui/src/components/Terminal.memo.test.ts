import { describe, expect, test } from 'bun:test';
import type { TerminalThemeColors } from '@tmex/shared';
import { Terminal, type TerminalComponentProps, terminalPropsEqual } from './Terminal';
import { applyTerminalRenderSuspension } from './hooks/useTerminalBootSurface';
import { SplitPaneView } from './split/SplitPaneView';

const theme = {} as TerminalThemeColors;
const onResize = (): void => {};
const onSync = (): void => {};

function terminalProps(snapshot: {
  deviceId: string;
  session: { windows: Array<{ id: string; panes: Array<{ id: string; title: string }> }> };
}): TerminalComponentProps {
  return {
    deviceId: snapshot.deviceId,
    paneId: snapshot.session.windows[0]!.panes[0]!.id,
    theme,
    inputMode: 'direct',
    deviceConnected: true,
    isSelectionInvalid: false,
    renderSuspended: false,
    onResize,
    onSync,
  };
}

describe('terminal component memoization', () => {
  test('a metadata-only snapshot patch does not re-render Terminal', () => {
    const before = {
      deviceId: 'dev-1',
      session: { windows: [{ id: '@1', panes: [{ id: '%1', title: 'before' }] }] },
    };
    const after = structuredClone(before);
    after.session.windows[0]!.panes[0]!.title = 'after';
    const memo = Terminal as unknown as {
      $$typeof: symbol;
      compare: typeof terminalPropsEqual;
    };
    let renderCount = 1;
    if (!memo.compare(terminalProps(before), terminalProps(after))) renderCount += 1;

    expect(memo.$$typeof).toBe(Symbol.for('react.memo'));
    expect(memo.compare).toBe(terminalPropsEqual);
    expect(renderCount).toBe(1);
  });

  test('a render-affecting prop invalidates Terminal memoization', () => {
    const snapshot = {
      deviceId: 'dev-1',
      session: { windows: [{ id: '@1', panes: [{ id: '%1', title: 'shell' }] }] },
    };
    const before = terminalProps(snapshot);

    expect(terminalPropsEqual(before, { ...before, renderSuspended: true })).toBe(false);
    expect(terminalPropsEqual(before, { ...before, deviceConnected: false })).toBe(false);
  });

  test('SplitPaneView is memoized as the outer metadata isolation boundary', () => {
    expect((SplitPaneView as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo')
    );
  });

  test('surface visibility transitions reach render-aware terminal controllers', () => {
    const transitions: boolean[] = [];
    const terminal = {
      setRenderSuspended: (suspended: boolean) => transitions.push(suspended),
    } as never;

    applyTerminalRenderSuspension(terminal, true);
    applyTerminalRenderSuspension(terminal, false);
    applyTerminalRenderSuspension(null, true);

    expect(transitions).toEqual([true, false]);
  });
});
