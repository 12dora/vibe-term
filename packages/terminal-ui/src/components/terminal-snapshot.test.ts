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
  type HistoryRestoreTarget,
  NORMAL_SCREEN_PREFIX,
  resolveHistoryRestoreGeometry,
  startsWithBytes,
  terminalModesFromHistory,
  writeCanonicalSnapshot,
  writeLiveOutput,
  writeRestoredHistory,
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

    expect(target.writes).toEqual(['\x1b[2J\x1b[Hold\r\nlive']);
  });

  test('整屏重写只发一次 write：多页 history 按数组顺序拼在同一载荷里', () => {
    const target = createTarget();
    writeCanonicalSnapshot(target, snapshotOf('\x1b[2J\x1b[Hlive'), [
      pageOf('older\n'),
      pageOf('newer\n'),
    ]);

    expect(target.writes).toEqual(['\x1b[2J\x1b[Holder\r\nnewer\r\nlive']);
    expect(target.repaints).toBe(1);
  });

  test('页尾换行被补齐，空页只贡献一个换行', () => {
    const target = createTarget();
    writeCanonicalSnapshot(target, snapshotOf('\x1b[2J\x1b[Hlive'), [pageOf(''), pageOf('a\r\nb')]);

    expect(target.writes).toEqual(['\x1b[2J\x1b[H\r\na\r\nb\r\nlive']);
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

interface RecordingHistoryTarget extends HistoryRestoreTarget {
  ops: string[];
}

function createHistoryTarget(cols: number, rows: number): RecordingHistoryTarget {
  const size = { cols, rows };
  const target: RecordingHistoryTarget = {
    ops: [],
    liveOutputEndedWithCR: false,
    terminal: {
      get cols() {
        return size.cols;
      },
      get rows() {
        return size.rows;
      },
      reset: () => {
        target.ops.push('reset');
      },
      resize: (nextCols, nextRows) => {
        size.cols = nextCols;
        size.rows = nextRows;
        target.ops.push(`resize:${nextCols}x${nextRows}`);
      },
      write: (data) => {
        target.ops.push(`write:${typeof data === 'string' ? data : decoder.decode(data)}`);
      },
      restoreModeSnapshot: () => {
        target.ops.push('modes');
      },
      forceFullRepaint: () => {
        target.ops.push('repaint');
      },
    },
  };
  return target;
}

describe('resolveHistoryRestoreGeometry', () => {
  test('returns the remote geometry when it differs from the terminal', () => {
    expect(resolveHistoryRestoreGeometry({ cols: 120, rows: 45 }, { cols: 112, rows: 35 })).toEqual(
      {
        cols: 120,
        rows: 45,
      }
    );
  });

  test('returns null when the geometry already matches or is unusable', () => {
    expect(resolveHistoryRestoreGeometry({ cols: 112, rows: 35 }, { cols: 112, rows: 35 })).toBe(
      null
    );
    expect(resolveHistoryRestoreGeometry(null, { cols: 112, rows: 35 })).toBe(null);
    expect(resolveHistoryRestoreGeometry({ cols: 0, rows: 45 }, { cols: 112, rows: 35 })).toBe(
      null
    );
    expect(resolveHistoryRestoreGeometry({ cols: 120, rows: 1 }, { cols: 112, rows: 35 })).toBe(
      null
    );
    expect(resolveHistoryRestoreGeometry({ cols: 120.5, rows: 45 }, { cols: 112, rows: 35 })).toBe(
      null
    );
  });
});

describe('writeRestoredHistory', () => {
  // 回归（切窗往返只剩提示符）：legacy TERM_HISTORY 的行数与末尾光标恢复序列都以
  // tmux pane 高度为基准。写进更矮的终端会把顶部挤进 scrollback，切窗回来只看得到
  // 最后一行。canonical 路径靠 snapshot 自带的 rows/cols 对齐，legacy 路径必须在
  // 写入前按 tmux 快照的 pane 尺寸对齐，且 resize 必须早于 write。
  test('resizes to the tmux pane geometry before writing the capture', () => {
    const target = createHistoryTarget(112, 35);

    writeRestoredHistory(
      target,
      { data: 'PANE1_READY\nsh-3.2$ \n\x1b[43A\x1b[9G', alternateScreen: false, modes: 0 },
      { cols: 120, rows: 45 }
    );

    expect(target.ops[0]).toBe('resize:120x45');
    expect(target.ops.indexOf('resize:120x45')).toBeLessThan(
      target.ops.findIndex((op) => op.startsWith('write:'))
    );
    expect(target.terminal.rows).toBe(45);
    expect(target.ops.at(-1)).toBe('repaint');
  });

  test('does not resize when the terminal already matches the pane geometry', () => {
    const target = createHistoryTarget(120, 45);

    writeRestoredHistory(
      target,
      { data: 'a\nb', alternateScreen: false, modes: 0 },
      {
        cols: 120,
        rows: 45,
      }
    );

    expect(target.ops.some((op) => op.startsWith('resize:'))).toBe(false);
  });

  test('writes without resizing when the pane geometry is unknown', () => {
    const target = createHistoryTarget(112, 35);

    writeRestoredHistory(target, { data: 'a\nb', alternateScreen: false, modes: 0 }, null);

    expect(target.ops.some((op) => op.startsWith('resize:'))).toBe(false);
    expect(target.ops.some((op) => op.startsWith('write:'))).toBe(true);
  });

  test('aligns alt-screen restores too', () => {
    const target = createHistoryTarget(112, 35);

    writeRestoredHistory(
      target,
      { data: 'tui', alternateScreen: true, modes: 0 },
      {
        cols: 120,
        rows: 45,
      }
    );

    expect(target.ops[0]).toBe('resize:120x45');
  });
});
