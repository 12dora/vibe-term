import { describe, expect, test } from 'bun:test';
import {
  EMPTY_PANE_MODE_FLAGS,
  PANE_MODE_ALT_SCREEN,
  PANE_MODE_FLAGS_PRESENT,
  encodePaneModes,
} from '@tmex/shared';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import type { GhosttyTerminalModeSnapshot } from 'ghostty-terminal';
import {
  type CanonicalSnapshotTarget,
  NORMAL_SCREEN_PREFIX,
  startsWithBytes,
  terminalModesFromHistory,
  writeCanonicalSnapshot,
  writeLiveOutput,
} from './terminal-snapshot';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RecordingTarget extends CanonicalSnapshotTarget {
  writes: string[];
  resets: number;
  repaints: number;
  sizes: Array<{ cols: number; rows: number }>;
  modes: GhosttyTerminalModeSnapshot[];
}

function createTarget(): RecordingTarget {
  const target: RecordingTarget = {
    writes: [],
    resets: 0,
    repaints: 0,
    sizes: [],
    modes: [],
    liveOutputEndedWithCR: true,
    terminal: {
      reset: () => {
        target.resets += 1;
      },
      resize: (cols, rows) => {
        target.sizes.push({ cols, rows });
      },
      write: (data) => {
        target.writes.push(typeof data === 'string' ? data : decoder.decode(data));
      },
      restoreModeSnapshot: (snapshot) => {
        target.modes.push(snapshot);
      },
      forceFullRepaint: () => {
        target.repaints += 1;
      },
    },
  };
  return target;
}

function snapshotOf(body: string, modes = PANE_MODE_FLAGS_PRESENT): GatewayPaneScreenSnapshot {
  return {
    deviceId: 'device-1',
    paneId: '%1',
    paneEpoch: new Uint8Array([1]),
    baseSeq: 0n,
    rows: 24,
    cols: 80,
    modes,
    data: encoder.encode(body),
    historyCursor: null,
  };
}

function pageOf(body: string): GatewayPaneHistoryPage {
  return {
    deviceId: 'device-1',
    paneId: '%1',
    paneEpoch: new Uint8Array([1]),
    historyEpoch: new Uint8Array([2]),
    lineStart: 0,
    lineEnd: 1,
    truncated: false,
    data: encoder.encode(body),
    nextCursor: null,
  };
}

describe('startsWithBytes', () => {
  test('matches a prefix and rejects shorter or differing input', () => {
    expect(startsWithBytes(encoder.encode('\x1b[2J\x1b[Hbody'), NORMAL_SCREEN_PREFIX)).toBe(true);
    expect(startsWithBytes(encoder.encode('\x1b[2J'), NORMAL_SCREEN_PREFIX)).toBe(false);
    expect(startsWithBytes(encoder.encode('body'), NORMAL_SCREEN_PREFIX)).toBe(false);
    expect(startsWithBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('terminalModesFromHistory', () => {
  test('maps tmux mouse flags and leaves untracked modes off', () => {
    const modes = terminalModesFromHistory(
      encodePaneModes({
        ...EMPTY_PANE_MODE_FLAGS,
        mouseStandard: true,
        mouseAll: true,
        mouseSgr: true,
      }),
      false
    );
    expect(modes).toEqual({
      mouseX10: false,
      mouseNormal: true,
      mouseButton: false,
      mouseAny: true,
      mouseUtf8: false,
      mouseSgr: true,
      mouseSgrPixels: false,
      mouseUrxvt: false,
      altScroll: false,
      altScreen1047: false,
      altScreen1049: false,
    });
  });

  test('enables altScroll on alternate screen without touching altScreen1049', () => {
    const modes = terminalModesFromHistory(0, true);
    expect(modes.altScroll).toBe(true);
    expect(modes.altScreen1049).toBe(false);
  });
});

describe('writeCanonicalSnapshot', () => {
  test('resets, resizes and writes the CR-normalized body without history', () => {
    const target = createTarget();
    writeCanonicalSnapshot(target, snapshotOf('a\nb'), []);

    expect(target.resets).toBe(1);
    expect(target.sizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(target.liveOutputEndedWithCR).toBe(false);
    expect(target.writes).toEqual(['a\r\nb']);
    expect(target.repaints).toBe(1);
  });

  test('restores mouse modes only when the flags-present bit is set', () => {
    const present = createTarget();
    writeCanonicalSnapshot(
      present,
      snapshotOf(
        'x',
        PANE_MODE_FLAGS_PRESENT |
          PANE_MODE_ALT_SCREEN |
          encodePaneModes({ ...EMPTY_PANE_MODE_FLAGS, mouseSgr: true })
      ),
      []
    );
    expect(present.modes).toHaveLength(1);
    expect(present.modes[0]?.mouseSgr).toBe(true);
    expect(present.modes[0]?.altScroll).toBe(true);

    const legacy = createTarget();
    writeCanonicalSnapshot(
      legacy,
      snapshotOf('x', encodePaneModes({ ...EMPTY_PANE_MODE_FLAGS, mouseStandard: true })),
      []
    );
    expect(legacy.modes).toHaveLength(0);
  });

  test('emits history pages between the clear prefix and the snapshot body', () => {
    const target = createTarget();
    writeCanonicalSnapshot(target, snapshotOf('\x1b[2J\x1b[Hlive'), [pageOf('old\n')]);

    expect(target.writes).toEqual(['\x1b[2J\x1b[H', 'old', '\r\n', 'live']);
  });

  test('keeps the snapshot clear prefix when the body carries no history', () => {
    const target = createTarget();
    writeCanonicalSnapshot(target, snapshotOf('\x1b[2J\x1b[Hlive'), []);

    expect(target.writes).toEqual(['\x1b[2J\x1b[Hlive']);
  });
});

describe('writeLiveOutput', () => {
  test('carries the trailing CR state across chunks', () => {
    const target = createTarget();
    target.liveOutputEndedWithCR = false;

    writeLiveOutput(target, encoder.encode('one\r'));
    expect(target.liveOutputEndedWithCR).toBe(true);
    writeLiveOutput(target, encoder.encode('\ntwo\n'));

    expect(target.writes).toEqual(['one\r', '\ntwo\r\n']);
    expect(target.liveOutputEndedWithCR).toBe(false);
  });
});
