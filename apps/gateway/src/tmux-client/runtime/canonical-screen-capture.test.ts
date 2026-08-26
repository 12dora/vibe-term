import { describe, expect, test } from 'bun:test';

import type { PaneInfo } from '../capture-history';
import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneIdentity, PaneScreenCheckpoint, PaneTerminalCursor } from '../pane-retention';
import {
  CanonicalScreenCapture,
  type CanonicalScreenCaptureHost,
  concatBytes,
  truncateUtf8Tail,
} from './canonical-screen-capture';

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
