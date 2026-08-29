import { describe, expect, test } from 'bun:test';

import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, encodePaneModes } from '@tmex/shared';

import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneHistoryCursor } from '../pane-history-reader';
import type { PaneIdentity, PaneScreenCheckpoint, PaneTerminalCursor } from '../pane-retention';
import {
  CanonicalScreenCapture,
  type CanonicalScreenCaptureHost,
  concatBytes,
  truncateUtf8Tail,
} from './canonical-screen-capture';
import {
  buildCanonicalCheckpoint,
  captureFrame,
  estimateHistoryLines,
} from './canonical-screen-checkpoint';

const EPOCH = new Uint8Array(16).fill(1);

function paneInfo(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    cols: 80,
    rows: 24,
    cursorX: 0,
    cursorY: 0,
    alternateScreen: false,
    currentCommand: null,
    ...overrides,
  };
}

function createHost(
  overrides: Partial<CanonicalScreenCaptureHost> = {}
): CanonicalScreenCaptureHost & { stored: PaneScreenCheckpoint[] } {
  const stored: PaneScreenCheckpoint[] = [];
  const identity: PaneIdentity = { paneId: '%1', paneEpoch: EPOCH };
  const cursor: PaneTerminalCursor = { paneEpoch: EPOCH, terminalSeq: 10n };
  const host: CanonicalScreenCaptureHost & { stored: PaneScreenCheckpoint[] } = {
    stored,
    getPaneIdentity: (paneId) => (paneId === '%1' ? identity : null),
    maxCheckpointBytesPerPane: () => 4096,
    findProjectedPane: () => ({ width: 80, height: 24 }),
    getLatestCursor: () => cursor,
    getPaneInfo: async () => paneInfo(),
    capturePaneText: async () => 'hello',
    getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
    createHistoryCursor: () => null,
    storeScreenCheckpoint: (checkpoint) => {
      stored.push(checkpoint);
      return true;
    },
    now: () => 1234,
    ...overrides,
  };
  return host;
}

describe('CanonicalScreenCapture', () => {
  test('returns null when the pane identity is unknown or the budget is tiny', async () => {
    const host = createHost();
    const capture = new CanonicalScreenCapture(host);
    await expect(capture.capture('%missing', 1024)).resolves.toBeNull();
    await expect(capture.capture('%1', 16)).resolves.toBeNull();
    expect(host.stored).toEqual([]);
  });

  test('deduplicates in-flight captures for the same pane', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createHost({
      capturePaneText: async () => {
        await gate;
        return 'hello';
      },
    });
    const capture = new CanonicalScreenCapture(host);
    const first = capture.capture('%1', 1024);
    const second = capture.capture('%1', 1024);
    expect(second).toBe(first);
    release?.();
    const checkpoint = await first;
    expect(checkpoint?.data).toBeInstanceOf(Uint8Array);
    expect(host.stored).toHaveLength(1);
  });

  test('fallback path encodes visible text and stores the checkpoint', async () => {
    const host = createHost();
    const capture = new CanonicalScreenCapture(host);
    const checkpoint = await capture.capture('%1', 1024);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.baseSeq).toBe(10n);
    expect(checkpoint?.rows).toBe(24);
    expect(checkpoint?.cols).toBe(80);
    expect(checkpoint?.capturedAt).toBe(1234);
    const text = new TextDecoder().decode(checkpoint?.data);
    expect(text.startsWith('\x1b[2J\x1b[H')).toBe(true);
    expect(text.includes('hello')).toBe(true);
    expect(host.stored).toHaveLength(1);
  });

  test('barrier path uses history text unless the pane is on the alt screen', async () => {
    const frame: AtomicPaneCapture = {
      text: 'visible',
      historyText: 'scrollback',
      cols: 80,
      rows: 24,
      cursorX: 1,
      cursorY: 2,
      alternateScreen: true,
      historySize: 10,
      modes: null,
    };
    const host = createHost({
      capturePaneFrameAtBarrier: async (_paneId, _lines, onBarrier) => {
        onBarrier();
        return frame;
      },
    });
    const capture = new CanonicalScreenCapture(host);
    const checkpoint = await capture.capture('%1', 1024);
    const text = new TextDecoder().decode(checkpoint?.data);
    expect(text.startsWith('\x1b[?1049h\x1b[2J\x1b[H')).toBe(true);
    expect(text.includes('scrollback')).toBe(false);
    expect(text.includes('visible')).toBe(true);
    expect(checkpoint?.historyCursor).toBeNull();
  });

  test('returns null when the pane epoch changes mid-capture', async () => {
    let calls = 0;
    const host = createHost({
      getPaneIdentity: () => {
        calls += 1;
        return {
          paneId: '%1',
          paneEpoch: new Uint8Array(16).fill(calls),
        };
      },
    });
    const capture = new CanonicalScreenCapture(host);
    await expect(capture.capture('%1', 1024)).resolves.toBeNull();
    expect(host.stored).toEqual([]);
  });
});

describe('estimateHistoryLines', () => {
  test('caps extra history lines by byte budget and projected size', () => {
    expect(estimateHistoryLines({ width: 8, height: 4 }, 4096)).toBeGreaterThan(0);
    expect(estimateHistoryLines({ width: 80, height: 24 }, 64)).toBe(0);
    expect(estimateHistoryLines(undefined, 4096)).toBe(
      estimateHistoryLines({ width: 80, height: 24 }, 4096)
    );
  });
});

describe('captureFrame', () => {
  test('barrier path records the cursor at the barrier callback', async () => {
    const cursor: PaneTerminalCursor = { paneEpoch: EPOCH, terminalSeq: 7n };
    const frame: AtomicPaneCapture = {
      text: 'visible',
      historyText: 'scroll',
      cols: 40,
      rows: 12,
      cursorX: 3,
      cursorY: 4,
      alternateScreen: false,
      historySize: 8,
      modes: null,
    };
    let barrierCalls = 0;
    const host = createHost({
      getLatestCursor: () => cursor,
      capturePaneFrameAtBarrier: async (_paneId, historyLines, onBarrier) => {
        expect(historyLines).toBe(3);
        onBarrier();
        barrierCalls += 1;
        return frame;
      },
    });
    const captured = await captureFrame(host, '%1', 3);
    expect(captured.frame).toBe(frame);
    expect(captured.baseCursor).toEqual(cursor);
    expect(barrierCalls).toBe(1);
  });

  test('fallback path zeros history on alt screen and leaves historyText null', async () => {
    const host = createHost({
      getPaneInfo: async () => paneInfo({ alternateScreen: true, cols: 10, rows: 5 }),
      capturePaneText: async (_paneId, opts) => {
        expect(opts?.historyLines).toBe(0);
        return 'alt';
      },
      getPaneHistoryCaptureInfo: async () => ({ historySize: 9, cols: 10 }),
    });
    const captured = await captureFrame(host, '%1', 12);
    expect(captured.frame).toEqual({
      text: 'alt',
      historyText: null,
      cols: 10,
      rows: 5,
      cursorX: 0,
      cursorY: 0,
      alternateScreen: true,
      historySize: 9,
      modes: null,
    });
    expect(captured.baseCursor?.terminalSeq).toBe(10n);
  });
});

describe('buildCanonicalCheckpoint', () => {
  const encoder = new TextEncoder();

  function checkpointInput(
    overrides: Partial<Parameters<typeof buildCanonicalCheckpoint>[0]> = {}
  ) {
    const frame: AtomicPaneCapture = {
      text: 'hello',
      historyText: null,
      cols: 80,
      rows: 24,
      cursorX: 0,
      cursorY: 0,
      alternateScreen: false,
      historySize: 0,
      modes: null,
      ...overrides.frame,
    };
    return {
      paneId: '%1',
      paneEpoch: EPOCH,
      baseSeq: 10n,
      maxBytes: 1024,
      historyLines: 4,
      capturedAt: 1234,
      createHistoryCursor: () => null,
      ...overrides,
      frame,
    };
  }

  test('prefixes a primary-screen clear and places the cursor', () => {
    const checkpoint = buildCanonicalCheckpoint(checkpointInput());
    const text = new TextDecoder().decode(checkpoint.data);
    expect(text.startsWith('\x1b[2J\x1b[H')).toBe(true);
    expect(text.endsWith('\x1b[1;1H')).toBe(true);
    expect(text.includes('hello')).toBe(true);
    expect(checkpoint.baseSeq).toBe(10n);
    expect(checkpoint.modes).toBe(0);
  });

  test('omits the cursor sequence when tmux reports a null cursor', () => {
    const checkpoint = buildCanonicalCheckpoint(
      checkpointInput({
        frame: {
          text: 'hello',
          historyText: null,
          cols: 80,
          rows: 24,
          cursorX: null,
          cursorY: null,
          alternateScreen: false,
          historySize: 0,
          modes: null,
        },
      })
    );
    const text = new TextDecoder().decode(checkpoint.data);
    expect(text).toBe('\x1b[2J\x1b[Hhello');
  });

  test('drops history as a whole when the byte budget cannot fit it', () => {
    const historyText = 'H'.repeat(200);
    const checkpoint = buildCanonicalCheckpoint(
      checkpointInput({
        maxBytes: 80,
        frame: {
          text: 'visible',
          historyText,
          cols: 80,
          rows: 24,
          cursorX: 0,
          cursorY: 0,
          alternateScreen: false,
          historySize: 10,
          modes: null,
        },
      })
    );
    const text = new TextDecoder().decode(checkpoint.data);
    expect(text.includes(historyText)).toBe(false);
    expect(text.includes('visible')).toBe(true);
  });

  test('includes history when it fits and advances the history cursor by captured lines', () => {
    const cursors: Array<[string, Uint8Array, number]> = [];
    const historyCursor: PaneHistoryCursor = {
      paneEpoch: EPOCH,
      historyEpoch: new Uint8Array(16).fill(9),
      beforeLine: 6,
    };
    const checkpoint = buildCanonicalCheckpoint(
      checkpointInput({
        historyLines: 4,
        createHistoryCursor: (paneId, paneEpoch, beforeLine) => {
          cursors.push([paneId, paneEpoch, beforeLine]);
          return historyCursor;
        },
        frame: {
          text: 'visible',
          historyText: 'scroll',
          cols: 80,
          rows: 24,
          cursorX: 1,
          cursorY: 2,
          alternateScreen: false,
          historySize: 10,
          modes: null,
        },
      })
    );
    const text = new TextDecoder().decode(checkpoint.data);
    expect(text.includes('scroll\nvisible')).toBe(true);
    expect(cursors).toEqual([['%1', EPOCH, 6]]);
    expect(checkpoint.historyCursor).toBe(historyCursor);
    expect(text.includes('\x1b[3;2H')).toBe(true);
  });

  test('never splices primary-grid history into an alt-screen snapshot', () => {
    const checkpoint = buildCanonicalCheckpoint(
      checkpointInput({
        createHistoryCursor: () => {
          throw new Error('alt screen must not create a history cursor');
        },
        frame: {
          text: 'tui',
          historyText: 'old-shell',
          cols: 80,
          rows: 24,
          cursorX: 0,
          cursorY: 0,
          alternateScreen: true,
          historySize: 10,
          modes: {
            mouseStandard: true,
            mouseButton: false,
            mouseAll: false,
            mouseSgr: true,
            mouseUtf8: false,
          },
        },
      })
    );
    const text = new TextDecoder().decode(checkpoint.data);
    expect(text.startsWith('\x1b[?1049h\x1b[2J\x1b[H')).toBe(true);
    expect(text.includes('old-shell')).toBe(false);
    expect(text.includes('tui')).toBe(true);
    expect(checkpoint.historyCursor).toBeNull();
    expect(checkpoint.modes).toBe(
      PANE_MODE_ALT_SCREEN |
        encodePaneModes({
          mouseStandard: true,
          mouseButton: false,
          mouseAll: false,
          mouseSgr: true,
          mouseUtf8: false,
        }) |
        PANE_MODE_FLAGS_PRESENT
    );
  });

  test('treats fallback text as already containing history and truncates on a UTF-8 boundary', () => {
    const cursors: number[] = [];
    const checkpoint = buildCanonicalCheckpoint(
      checkpointInput({
        maxBytes: 8,
        historyLines: 3,
        createHistoryCursor: (_paneId, _epoch, beforeLine) => {
          cursors.push(beforeLine);
          return null;
        },
        frame: {
          text: 'éx',
          historyText: null,
          cols: 80,
          rows: 24,
          cursorX: null,
          cursorY: null,
          alternateScreen: false,
          historySize: 5,
          modes: null,
        },
      })
    );
    expect(cursors).toEqual([5]);
    const prefix = encoder.encode('\x1b[2J\x1b[H');
    expect(checkpoint.data.byteLength).toBeLessThanOrEqual(8);
    expect(checkpoint.data.slice(0, prefix.byteLength)).toEqual(prefix);
  });
});

describe('utf8 capture helpers', () => {
  test('truncateUtf8Tail does not split a multi-byte codepoint', () => {
    const encoded = new TextEncoder().encode('éx');
    const truncated = truncateUtf8Tail(encoded, 2);
    expect(new TextDecoder().decode(truncated)).toBe('x');
  });

  test('concatBytes joins chunks in order', () => {
    const joined = concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]));
    expect([...joined]).toEqual([1, 2, 3]);
  });
});
