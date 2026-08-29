import { describe, expect, test } from 'bun:test';
import type { GhosttyBindings } from './ghostty-wasm';
import { GHOSTTY_MODE_NORMAL_MOUSE } from './terminal-constants';
import { type InputBridgeHost, TerminalInputBridge } from './terminal-input-bridge';

type HostCallCounts = { cellDimensions: number; viewportRows: number; viewportCols: number };

function createBridge(): { bridge: TerminalInputBridge; counts: HostCallCounts } {
  const counts: HostCallCounts = { cellDimensions: 0, viewportRows: 0, viewportCols: 0 };

  const host: InputBridgeHost = {
    cellDimensions: () => {
      counts.cellDimensions += 1;
      return { width: 10, height: 20 };
    },
    // null 边界：emitMouseInput 立刻返回，宿主尺寸只会被手势换算读到
    screenBounds: () => null,
    isInputDisabled: () => false,
    emitData: () => undefined,
    viewportCols: () => {
      counts.viewportCols += 1;
      return 80;
    },
    viewportRows: () => {
      counts.viewportRows += 1;
      return 24;
    },
    scrollLines: () => undefined,
  };

  const bindings = {
    isTerminalModeEnabled: (_terminal: number, mode: number) => mode === GHOSTTY_MODE_NORMAL_MOUSE,
  } as unknown as GhosttyBindings;

  return {
    bridge: new TerminalInputBridge(
      bindings,
      { terminal: 1, keyEncoder: 2, mouseEncoder: 3 },
      host
    ),
    counts,
  };
}

describe('viewport gesture zero-axis short circuit', () => {
  test('a horizontal-only gesture never measures the vertical axis', () => {
    const { bridge, counts } = createBridge();

    bridge.handleViewportGesture({
      source: 'wheel',
      deltaX: 100,
      deltaY: 0,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
    });

    expect(counts.viewportRows).toBe(0);
    expect(counts.viewportCols).toBe(1);
    expect(counts.cellDimensions).toBe(1);
  });

  test('a vertical-only gesture never measures the horizontal axis', () => {
    const { bridge, counts } = createBridge();

    bridge.handleViewportGesture({
      source: 'wheel',
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
    });

    expect(counts.viewportCols).toBe(0);
    expect(counts.viewportRows).toBe(1);
    expect(counts.cellDimensions).toBe(1);
  });

  test('an omitted deltaX behaves like a zero horizontal axis', () => {
    const { bridge, counts } = createBridge();

    bridge.handleViewportGesture({
      source: 'touch',
      deltaY: 100,
      clientX: 0,
      clientY: 0,
    });

    expect(counts.viewportCols).toBe(0);
    expect(counts.cellDimensions).toBe(1);
  });
});
