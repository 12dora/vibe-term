import { describe, expect, test } from 'bun:test';
import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, encodePaneModes } from '@tmex/shared';

import type { AtomicPaneCapture } from '../control-mode-capture';
import type { PaneIdentity, PaneTerminalCursor } from '../pane-retention';
import {
  assembleScreenPayload,
  buildScreenCheckpoint,
  encodeScreenModes,
  estimateHistoryLines,
  historyCursorBeforeLine,
  resolveCaptureEpoch,
  truncateUtf8Tail,
} from './screen-checkpoint-builder';

const EPOCH_A = new Uint8Array(16).fill(1);
const EPOCH_B = new Uint8Array(16).fill(2);

function frame(overrides: Partial<AtomicPaneCapture> = {}): AtomicPaneCapture {
  return {
    text: 'visible',
    historyText: null,
    cols: 80,
    rows: 24,
    cursorX: 0,
    cursorY: 0,
    alternateScreen: false,
    historySize: 0,
    modes: null,
    ...overrides,
  };
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

describe('estimateHistoryLines', () => {
  test('returns no history when the visible grid already consumes the budget', () => {
    expect(estimateHistoryLines({ maxBytes: 4096, cols: 80, rows: 24 })).toBe(0);
  });

  test('caps extra history at 256 lines', () => {
    expect(estimateHistoryLines({ maxBytes: 10_000_000, cols: 80, rows: 24 })).toBe(256);
  });

  test('requests history when the budget covers extra lines', () => {
    expect(estimateHistoryLines({ maxBytes: 200, cols: 10, rows: 2 })).toBe(3);
  });

  test('uses a 16-byte floor per line for tiny widths', () => {
    expect(estimateHistoryLines({ maxBytes: 64, cols: 1, rows: 1 })).toBe(3);
  });

  test('defaults to 80x24 when dimensions are missing', () => {
    expect(estimateHistoryLines({ maxBytes: 4096 })).toBe(
      estimateHistoryLines({ maxBytes: 4096, cols: 80, rows: 24 })
    );
  });

  test('treats zero dimensions as one cell', () => {
    expect(estimateHistoryLines({ maxBytes: 64, cols: 0, rows: 0 })).toBe(
      estimateHistoryLines({ maxBytes: 64, cols: 1, rows: 1 })
    );
  });
});

describe('truncateUtf8Tail', () => {
  test('does not split a 2-byte codepoint at the cut', () => {
    const encoded = new TextEncoder().encode('éx');
    expect(decode(truncateUtf8Tail(encoded, 2))).toBe('x');
    expect(decode(truncateUtf8Tail(encoded, 3))).toBe('éx');
  });

  test('does not split a 3-byte CJK codepoint at the cut', () => {
    const encoded = new TextEncoder().encode('A你');
    expect(decode(truncateUtf8Tail(encoded, 2))).toBe('');
    expect(decode(truncateUtf8Tail(encoded, 3))).toBe('你');
    expect(decode(truncateUtf8Tail(encoded, 4))).toBe('A你');
  });

  test('does not split a 4-byte emoji at the cut', () => {
    const encoded = new TextEncoder().encode('A👍');
    expect(decode(truncateUtf8Tail(encoded, 3))).toBe('');
    expect(decode(truncateUtf8Tail(encoded, 4))).toBe('👍');
    expect(decode(truncateUtf8Tail(encoded, 5))).toBe('A👍');
  });

  test('keeps the tail when the cut lands on a character start', () => {
    const encoded = new TextEncoder().encode('AAA你好');
    expect(decode(truncateUtf8Tail(encoded, 3))).toBe('好');
    expect(decode(truncateUtf8Tail(encoded, 6))).toBe('你好');
  });

  test('returns empty when the limit is zero', () => {
    expect(truncateUtf8Tail(new TextEncoder().encode('hello'), 0).byteLength).toBe(0);
  });
});

describe('assembleScreenPayload', () => {
  test('prefixes a primary-screen snapshot and restores the cursor', () => {
    const payload = assembleScreenPayload(frame({ text: 'hello', cursorX: 1, cursorY: 2 }), {
      maxBytes: 1024,
      historyLines: 0,
    });
    expect(decode(payload.data)).toBe('\x1b[2J\x1b[Hhello\x1b[3;2H');
    expect(payload.textWasTruncated).toBe(false);
    expect(payload.embeddedHistoryLines).toBe(0);
  });

  test('uses the alt-screen DECSET prefix and never attaches scrollback', () => {
    const payload = assembleScreenPayload(
      frame({
        text: 'visible',
        historyText: 'scrollback',
        historySize: 10,
        alternateScreen: true,
        cursorX: null,
        cursorY: null,
      }),
      { maxBytes: 1024, historyLines: 8 }
    );
    const text = decode(payload.data);
    expect(text.startsWith('\x1b[?1049h\x1b[2J\x1b[H')).toBe(true);
    expect(text.includes('scrollback')).toBe(false);
    expect(text.includes('visible')).toBe(true);
    expect(payload.embeddedHistoryLines).toBe(0);
  });

  test('attaches history as a whole when it fits the text budget', () => {
    const payload = assembleScreenPayload(
      frame({ text: 'visible', historyText: 'scrollback', historySize: 4 }),
      { maxBytes: 1024, historyLines: 4 }
    );
    expect(decode(payload.data).includes('scrollback\nvisible')).toBe(true);
    expect(payload.embeddedHistoryLines).toBe(4);
    expect(payload.textWasTruncated).toBe(false);
  });

  test('drops history entirely when it would exceed the text budget', () => {
    const prefixAndCursor = new TextEncoder().encode('\x1b[2J\x1b[H\x1b[1;1H').byteLength;
    const payload = assembleScreenPayload(
      frame({ text: 'visible', historyText: 'scrollback', historySize: 4 }),
      { maxBytes: prefixAndCursor + 7, historyLines: 4 }
    );
    const text = decode(payload.data);
    expect(text.includes('scrollback')).toBe(false);
    expect(text.includes('visible')).toBe(true);
    expect(payload.embeddedHistoryLines).toBe(0);
    expect(payload.textWasTruncated).toBe(false);
  });

  test('truncates visible text from the tail without splitting a multi-byte character', () => {
    const prefixAndCursor = new TextEncoder().encode('\x1b[2J\x1b[H\x1b[1;1H').byteLength;
    const payload = assembleScreenPayload(frame({ text: 'AAA你好' }), {
      maxBytes: prefixAndCursor + 4,
      historyLines: 0,
    });
    expect(payload.textWasTruncated).toBe(true);
    expect(decode(payload.data).endsWith('好\x1b[1;1H')).toBe(true);
    expect(decode(payload.data).includes('AAA')).toBe(false);
  });

  test('counts fallback embedded history lines when historyText is null', () => {
    const payload = assembleScreenPayload(frame({ historyText: null }), {
      maxBytes: 1024,
      historyLines: 12,
    });
    expect(payload.embeddedHistoryLines).toBe(12);
  });
});

describe('historyCursorBeforeLine', () => {
  test('points at historySize when the visible payload was truncated', () => {
    expect(historyCursorBeforeLine(40, 8, true)).toBe(40);
  });

  test('subtracts embedded history when the snapshot is complete', () => {
    expect(historyCursorBeforeLine(40, 8, false)).toBe(32);
    expect(historyCursorBeforeLine(3, 8, false)).toBe(0);
  });
});

describe('encodeScreenModes', () => {
  test('sets alt-screen and present flags independently', () => {
    expect(encodeScreenModes(frame())).toBe(0);
    expect(encodeScreenModes(frame({ alternateScreen: true }))).toBe(PANE_MODE_ALT_SCREEN);
    const modes = {
      mouseStandard: true,
      mouseButton: false,
      mouseAll: false,
      mouseSgr: true,
      mouseUtf8: false,
    };
    expect(encodeScreenModes(frame({ modes }))).toBe(
      encodePaneModes(modes) | PANE_MODE_FLAGS_PRESENT
    );
  });
});

describe('resolveCaptureEpoch', () => {
  const identity: PaneIdentity = { paneId: '%1', paneEpoch: EPOCH_A };
  const cursor: PaneTerminalCursor = { paneEpoch: EPOCH_A, terminalSeq: 10n };

  test('returns seq and epoch when identity and cursor still match', () => {
    expect(resolveCaptureEpoch(identity, identity, cursor)).toEqual({
      paneEpoch: EPOCH_A,
      baseSeq: 10n,
    });
  });

  test('rejects a missing cursor, missing identity, or epoch drift', () => {
    expect(resolveCaptureEpoch(identity, identity, null)).toBeNull();
    expect(resolveCaptureEpoch(identity, null, cursor)).toBeNull();
    expect(resolveCaptureEpoch(identity, { paneId: '%1', paneEpoch: EPOCH_B }, cursor)).toBeNull();
    expect(
      resolveCaptureEpoch(identity, identity, { paneEpoch: EPOCH_B, terminalSeq: 10n })
    ).toBeNull();
  });
});

describe('buildScreenCheckpoint', () => {
  test('clamps rows and cols into the uint16 range', () => {
    const checkpoint = buildScreenCheckpoint({
      paneId: '%1',
      paneEpoch: EPOCH_A,
      baseSeq: 3n,
      frame: frame({ rows: 0, cols: 70_000 }),
      data: new Uint8Array([1]),
      historyCursor: null,
      capturedAt: 9,
    });
    expect(checkpoint.rows).toBe(1);
    expect(checkpoint.cols).toBe(0xffff);
    expect(checkpoint.paneId).toBe('%1');
    expect(checkpoint.baseSeq).toBe(3n);
    expect(checkpoint.capturedAt).toBe(9);
  });
});
