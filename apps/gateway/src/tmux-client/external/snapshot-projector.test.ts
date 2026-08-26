import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@tmex/shared';

import {
  PANE_SNAPSHOT_FORMAT,
  SNAPSHOT_FIELD_SEPARATOR,
  WINDOW_SNAPSHOT_FORMAT,
} from '../snapshot-format';
import {
  SnapshotProjector,
  type SnapshotProjectorHost,
  discardInvalidSnapshot,
  emitSnapshot,
  getExpectedPaneIds,
  parseSnapshotPanes,
  parseSnapshotSession,
  parseSnapshotWindows,
} from './snapshot-projector';
import type { CommandResult } from './types';

const ctx = { logPrefix: '[test]', deviceId: 'dev-1', warnings: [] as string[] };

function warnCtx() {
  const warnings: string[] = [];
  return {
    logPrefix: '[test]',
    deviceId: 'dev-1',
    warn: (message: string) => {
      warnings.push(message);
    },
    warnings,
  };
}

describe('parseSnapshotSession', () => {
  test('parses the first non-empty session row', () => {
    const session = parseSnapshotSession(['', '  ', '$1|tmex-snapshot', '$2|ignored'], ctx);
    expect(session).toEqual({ id: '$1', name: 'tmex-snapshot' });
  });

  test('keeps empty session name and stops after the first data line', () => {
    expect(parseSnapshotSession(['$7|'], ctx)).toEqual({ id: '$7', name: '' });
  });

  test('warns and returns null for an invalid session id without reading further lines', () => {
    const local = warnCtx();
    const session = parseSnapshotSession(['bogus|tmex', '$1|tmex'], local);
    expect(session).toBeNull();
    expect(local.warnings).toEqual(['[test] ignoring invalid tmux session id on dev-1: bogus']);
  });
});

describe('parseSnapshotWindows', () => {
  test('parses windows, records the active window, and skips blank lines', () => {
    const local = warnCtx();
    const { windows, activeWindowId } = parseSnapshotWindows(
      [
        '',
        '@1|0|0|ba9d,80x24,0,0,1|main',
        '@3|2|1|7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}|zsh',
      ],
      local
    );

    expect(activeWindowId).toBe('@3');
    expect(Array.from(windows.keys())).toEqual(['@1', '@3']);
    expect(windows.get('@3')).toEqual({
      id: '@3',
      index: 2,
      name: 'zsh',
      active: true,
      layout: '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}',
      panes: [],
    });
  });

  test('preserves window names containing the field separator', () => {
    const { windows } = parseSnapshotWindows(['@1|0|1|ba9d,80x24,0,0,0|name|with|pipe'], ctx);
    expect(windows.get('@1')?.name).toBe('name|with|pipe');
  });

  test('warns and skips invalid window rows', () => {
    const local = warnCtx();
    const { windows } = parseSnapshotWindows(['bogus|0|1|ba9d,80x24,0,0,0|zsh'], local);
    expect(windows.size).toBe(0);
    expect(local.warnings[0]).toContain(
      '[test] ignoring invalid tmux window snapshot row on dev-1:'
    );
  });
});

describe('parseSnapshotPanes', () => {
  test('attaches panes, sorts by index, and records the active pane of the active window', () => {
    const windows = new Map<string, TmuxWindow>([
      ['@1', { id: '@1', index: 0, name: 'main', active: true, panes: [{ id: 'stale' } as never] }],
    ]);

    const { activePaneId, activeWindowId } = parseSnapshotPanes(
      [
        '%2|@1|1|0|40|24|40|0|1|right|zsh|/tmp',
        '',
        '%1|@1|0|1|40|24|0|0|1|bash|node|/home/user',
        '%9|@99|0|0|80|24|0|0|0|orphan|sh|/tmp',
      ],
      windows,
      ctx
    );

    expect(activePaneId).toBe('%1');
    expect(activeWindowId).toBe('@1');
    expect(windows.get('@1')?.panes.map((pane) => pane.id)).toEqual(['%1', '%2']);
    expect(windows.get('@1')?.panes[0]).toEqual({
      id: '%1',
      windowId: '@1',
      index: 0,
      title: 'bash',
      currentCommand: 'node',
      currentPath: '/home/user',
      active: true,
      width: 40,
      height: 24,
      left: 0,
      top: 0,
    });
  });

  test('does not promote a pane that is active only in an inactive window', () => {
    const windows = new Map<string, TmuxWindow>([
      ['@1', { id: '@1', index: 0, name: 'main', active: false, panes: [] }],
    ]);
    const update = parseSnapshotPanes(['%1|@1|0|1|80|24|0|0|0|bash|node|/home/user'], windows, ctx);
    expect(update.activePaneId).toBeUndefined();
    expect(update.activeWindowId).toBeUndefined();
  });

  test('coerces missing pane title to empty string and warns on invalid rows', () => {
    const local = warnCtx();
    const windows = new Map<string, TmuxWindow>([
      ['@1', { id: '@1', index: 0, name: 'main', active: true, panes: [] }],
    ]);
    parseSnapshotPanes(['not-a-pane', '%1|@1|0|1|80|24|0|0|1|||'], windows, local);
    expect(windows.get('@1')?.panes[0]?.title).toBe('');
    expect(local.warnings[0]).toContain('[test] ignoring invalid tmux pane snapshot row on dev-1:');
  });
});

describe('discardInvalidSnapshot', () => {
  test('clears windows and focus when the session is missing', () => {
    const windows = new Map<string, TmuxWindow>([
      ['@1', { id: '@1', index: 0, name: 'main', active: true, panes: [] }],
    ]);
    const result = discardInvalidSnapshot(null, windows, ctx, '@1', '%1');
    expect(result).toEqual({
      session: null,
      windows: new Map(),
      activeWindowId: null,
      activePaneId: null,
    });
  });

  test('drops a session that has no valid windows', () => {
    const local = warnCtx();
    const result = discardInvalidSnapshot({ id: '$1', name: 'tmex' }, new Map(), local, '@1', '%1');
    expect(result.session).toBeNull();
    expect(result.activeWindowId).toBeNull();
    expect(result.activePaneId).toBeNull();
    expect(local.warnings).toEqual([
      '[test] ignoring tmux snapshot with no valid windows on dev-1',
    ]);
  });

  test('keeps a valid session and its windows', () => {
    const windows = new Map<string, TmuxWindow>([
      ['@1', { id: '@1', index: 0, name: 'main', active: true, panes: [] }],
    ]);
    const session = { id: '$1', name: 'tmex' };
    const result = discardInvalidSnapshot(session, windows, ctx, '@1', '%1');
    expect(result.session).toBe(session);
    expect(result.windows).toBe(windows);
    expect(result.activeWindowId).toBe('@1');
    expect(result.activePaneId).toBe('%1');
  });
});

describe('getExpectedPaneIds / emitSnapshot', () => {
  test('emits windows and pane ids in window index order', () => {
    const windows = new Map<string, TmuxWindow>([
      [
        '@2',
        {
          id: '@2',
          index: 2,
          name: 'late',
          active: false,
          panes: [
            { id: '%4', windowId: '@2', index: 0 } as TmuxWindow['panes'][number],
            { id: '%5', windowId: '@2', index: 1 } as TmuxWindow['panes'][number],
          ],
        },
      ],
      [
        '@1',
        {
          id: '@1',
          index: 0,
          name: 'main',
          active: true,
          panes: [{ id: '%1', windowId: '@1', index: 0 } as TmuxWindow['panes'][number]],
        },
      ],
    ]);

    expect(getExpectedPaneIds(windows)).toEqual(['%1', '%4', '%5']);

    const snapshots: unknown[] = [];
    emitSnapshot(
      {
        deviceId: 'dev-1',
        snapshotSession: { id: '$1', name: 'tmex' },
        snapshotWindows: windows,
        callbacks: {
          onSnapshot: (payload, baseRevision) => snapshots.push({ payload, baseRevision }),
        },
      },
      9n
    );

    expect(snapshots).toEqual([
      {
        payload: {
          deviceId: 'dev-1',
          session: {
            id: '$1',
            name: 'tmex',
            windows: [windows.get('@1'), windows.get('@2')],
          },
        },
        baseRevision: 9n,
      },
    ]);
  });

  test('emits a null session when snapshotSession is missing', () => {
    const snapshots: unknown[] = [];
    emitSnapshot({
      deviceId: 'dev-1',
      snapshotSession: null,
      snapshotWindows: new Map(),
      callbacks: {
        onSnapshot: (payload) => snapshots.push(payload),
      },
    });
    expect(snapshots).toEqual([{ deviceId: 'dev-1', session: null }]);
  });
});

describe('SnapshotProjector.performSnapshot', () => {
  function ok(stdout: string): CommandResult {
    return { exitCode: 0, stdout, stderr: '' };
  }

  function fail(stderr: string): CommandResult {
    return { exitCode: 1, stdout: '', stderr };
  }

  type FakeHost = SnapshotProjectorHost & {
    calls: string[][];
    snapshots: unknown[];
    pruned: string[][];
    themePruned: string[][];
    restored: number;
    success: number;
    shutdowns: boolean[];
    unavailable: string[];
    closures: number;
    setResponse: (argv: string, result: CommandResult) => void;
  };

  function createHost(overrides: Partial<SnapshotProjectorHost> = {}): FakeHost {
    const responses = new Map<string, CommandResult>();
    const host: FakeHost = {
      calls: [],
      snapshots: [],
      pruned: [],
      themePruned: [],
      restored: 0,
      success: 0,
      shutdowns: [],
      unavailable: [],
      closures: 0,
      setResponse: (argv, result) => {
        responses.set(argv, result);
      },
      connected: true,
      manualDisconnect: false,
      deviceId: 'dev-1',
      sessionName: 'tmex',
      logPrefix: '[test]',
      snapshotSession: null,
      snapshotWindows: new Map(),
      activeWindowId: null,
      activePaneId: null,
      controlSubscription: {
        prunePanes(ids) {
          host.pruned.push(Array.from(ids));
        },
      },
      callbacks: {
        deviceId: 'dev-1',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: (payload, baseRevision) => host.snapshots.push({ payload, baseRevision }),
        onError: () => {},
        onClose: () => {},
        beginMetadataReconcile: () => 3n,
      },
      lifecycle: {
        emitSnapshotClosures: () => {
          host.closures += 1;
        },
        notifySessionClosed: () => {},
      },
      async runTmuxAllowFailure(argv) {
        host.calls.push(argv);
        return responses.get(argv.join(' ')) ?? ok('');
      },
      shouldAbortSnapshot: () => false,
      onSnapshotSuccess() {
        host.success += 1;
      },
      pruneThemeSubscriptions(ids) {
        host.themePruned.push(Array.from(ids));
      },
      restoreThemeSubscriptionsOnce() {
        host.restored += 1;
      },
      markDeviceTmuxUnavailable(message) {
        host.unavailable.push(message);
      },
      async shutdownInternal(notifyClose) {
        host.shutdowns.push(notifyClose);
      },
      ...overrides,
    };
    return host;
  }

  test('no-ops when disconnected', async () => {
    const host = createHost({ connected: false });
    await new SnapshotProjector(host).performSnapshot();
    expect(host.calls).toEqual([]);
  });

  test('fetches session/windows/panes in parallel, projects, then restores theme', async () => {
    const host = createHost();
    host.setResponse(
      `display-message -p -t tmex #{session_id}${SNAPSHOT_FIELD_SEPARATOR}#{session_name}`,
      ok('$1|tmex\n')
    );
    host.setResponse(
      `list-windows -t tmex -F ${WINDOW_SNAPSHOT_FORMAT}`,
      ok('@1|0|1|ba9d,80x24,0,0,1|main\n')
    );
    host.setResponse(
      `list-panes -s -t tmex -F ${PANE_SNAPSHOT_FORMAT}`,
      ok('%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n')
    );

    await new SnapshotProjector(host).performSnapshot();

    expect(host.calls).toEqual([
      [
        'display-message',
        '-p',
        '-t',
        'tmex',
        `#{session_id}${SNAPSHOT_FIELD_SEPARATOR}#{session_name}`,
      ],
      ['list-windows', '-t', 'tmex', '-F', WINDOW_SNAPSHOT_FORMAT],
      ['list-panes', '-s', '-t', 'tmex', '-F', PANE_SNAPSHOT_FORMAT],
    ]);
    expect(host.snapshotSession).toEqual({ id: '$1', name: 'tmex' });
    expect(host.activePaneId).toBe('%1');
    expect(host.activeWindowId).toBe('@1');
    expect(host.pruned).toEqual([['%1']]);
    expect(host.themePruned).toEqual([['%1']]);
    expect(host.restored).toBe(1);
    expect(host.success).toBe(1);
    expect(host.closures).toBe(1);
    expect(host.snapshots[0]).toEqual({
      payload: {
        deviceId: 'dev-1',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [host.snapshotWindows.get('@1')],
        },
      },
      baseRevision: 3n,
    });
  });

  test('aborts before parsing when shouldAbortSnapshot returns true', async () => {
    const host = createHost({ shouldAbortSnapshot: () => true });
    await new SnapshotProjector(host).performSnapshot();
    expect(host.snapshotSession).toBeNull();
    expect(host.success).toBe(0);
    expect(host.snapshots).toEqual([]);
  });

  test('shuts down when snapshot stderr shows a gone tmux server', async () => {
    const host = createHost();
    host.setResponse(
      `display-message -p -t tmex #{session_id}${SNAPSHOT_FIELD_SEPARATOR}#{session_name}`,
      fail("can't find session: tmex\n")
    );
    host.setResponse(`list-windows -t tmex -F ${WINDOW_SNAPSHOT_FORMAT}`, fail(''));
    host.setResponse(`list-panes -s -t tmex -F ${PANE_SNAPSHOT_FORMAT}`, fail(''));

    const closed: string[] = [];
    host.lifecycle.notifySessionClosed = (message) => {
      closed.push(message);
    };

    await new SnapshotProjector(host).performSnapshot();

    expect(host.unavailable).toEqual(["can't find session: tmex"]);
    expect(closed).toEqual(["can't find session: tmex"]);
    expect(host.shutdowns).toEqual([true]);
    expect(host.snapshots).toEqual([]);
  });

  test('emits a null snapshot when commands fail for a non-gone reason', async () => {
    const host = createHost();
    host.setResponse(
      `display-message -p -t tmex #{session_id}${SNAPSHOT_FIELD_SEPARATOR}#{session_name}`,
      fail('permission denied')
    );
    host.setResponse(`list-windows -t tmex -F ${WINDOW_SNAPSHOT_FORMAT}`, fail(''));
    host.setResponse(`list-panes -s -t tmex -F ${PANE_SNAPSHOT_FORMAT}`, fail(''));

    await new SnapshotProjector(host).performSnapshot();

    expect(host.unavailable).toEqual([]);
    expect(host.shutdowns).toEqual([]);
    expect(host.snapshots).toEqual([
      { payload: { deviceId: 'dev-1', session: null }, baseRevision: undefined },
    ]);
  });
});
