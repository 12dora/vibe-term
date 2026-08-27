import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@tmex/shared';

import type { TmuxConnectionOptions } from '../connection-types';
import { ControlModeCommandQueue } from '../control-mode-capture';
import { SNAPSHOT_FIELD_SEPARATOR } from '../snapshot-format';
import { TmuxTargetMissingError } from '../target-missing';
import { PARKING_WINDOW_NAME } from './constants';
import {
  type SessionCommandHost,
  SessionCommands,
  buildBreakPaneArgv,
  buildCreateWindowArgv,
  buildMovePaneArgv,
  buildResizePaneByIdArgv,
  buildSplitPaneArgv,
} from './session-commands';
import type { CommandResult } from './types';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string, exitCode = 1): CommandResult {
  return { exitCode, stdout: '', stderr };
}

function createCallbacks(): TmuxConnectionOptions {
  return {
    deviceId: 'dev-1',
    onEvent: () => {},
    onTerminalOutput: () => {},
    onTerminalHistory: () => {},
    onSnapshot: () => {},
    onError: () => {},
    onClose: () => {},
  };
}

describe('session command builders', () => {
  test('create-window argv includes cwd and optional name', () => {
    expect(buildCreateWindowArgv('tmex', '/tmp/work')).toEqual([
      'new-window',
      '-t',
      'tmex',
      '-c',
      '/tmp/work',
    ]);
    expect(buildCreateWindowArgv('tmex', '/tmp/work', 'docs')).toEqual([
      'new-window',
      '-t',
      'tmex',
      '-c',
      '/tmp/work',
      '-n',
      'docs',
    ]);
  });

  test('move-pane argv encodes axis and before-flag per position', () => {
    expect(buildMovePaneArgv('%1', '%2', 'right')).toEqual([
      'move-pane',
      '-h',
      '-s',
      '%1',
      '-t',
      '%2',
    ]);
    expect(buildMovePaneArgv('%1', '%2', 'left')).toEqual([
      'move-pane',
      '-h',
      '-b',
      '-s',
      '%1',
      '-t',
      '%2',
    ]);
    expect(buildMovePaneArgv('%1', '%2', 'bottom')).toEqual([
      'move-pane',
      '-v',
      '-s',
      '%1',
      '-t',
      '%2',
    ]);
    expect(buildMovePaneArgv('%1', '%2', 'top')).toEqual([
      'move-pane',
      '-v',
      '-b',
      '-s',
      '%1',
      '-t',
      '%2',
    ]);
  });

  test('split-pane and break-pane argv keep the snapshot separator format', () => {
    expect(buildSplitPaneArgv('%1', 'h', '/tmp')).toEqual([
      'split-window',
      '-h',
      '-t',
      '%1',
      '-c',
      '/tmp',
      '-P',
      '-F',
      `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
    ]);
    expect(buildSplitPaneArgv('%1', 'v', '/tmp')).toEqual([
      'split-window',
      '-v',
      '-t',
      '%1',
      '-c',
      '/tmp',
      '-P',
      '-F',
      `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
    ]);
    expect(buildBreakPaneArgv('%3', 'tmex')).toEqual([
      'break-pane',
      '-s',
      '%3',
      '-t',
      'tmex:',
      '-P',
      '-F',
      `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
    ]);
  });

  test('resize-pane-by-id argv is omitted when neither dimension is set', () => {
    expect(buildResizePaneByIdArgv('%1', {})).toBeNull();
    expect(buildResizePaneByIdArgv('%1', { cols: 80.9, rows: 24.2 })).toEqual([
      'resize-pane',
      '-t',
      '%1',
      '-x',
      '80',
      '-y',
      '24',
    ]);
  });
});

describe('SessionCommands', () => {
  function createHost(overrides: Partial<SessionCommandHost> = {}) {
    const calls: string[][] = [];
    const allowCalls: string[][] = [];
    const events: unknown[] = [];
    const snapshots: number[] = [];
    const failures: string[] = [];
    const shutdowns: boolean[] = [];
    const gone: string[] = [];
    const responses = new Map<string, CommandResult>();
    const host: SessionCommandHost = {
      deviceId: 'dev-1',
      sessionName: 'tmex',
      connected: true,
      manualDisconnect: false,
      logPrefix: '[test]',
      activeWindowId: '@1',
      activePaneId: '%1',
      snapshotWindows: new Map(),
      callbacks: {
        ...createCallbacks(),
        onEvent: (event) => events.push(event),
      },
      controlCommands: new ControlModeCommandQueue(),
      resolveDefaultWorkingDir: () => '/tmp/work',
      shouldInstallGhosttyTerminfo: async () => false,
      configureWindowStyle: async () => {
        allowCalls.push(['__configureWindowStyle__']);
      },
      getParkingCommand: () => 'sleep 30',
      runTmuxAllowFailure: async (argv) => {
        allowCalls.push(argv);
        return responses.get(argv.join(' ')) ?? ok();
      },
      requestSnapshotInternal: async () => {
        snapshots.push(1);
      },
      requestSnapshot: () => {
        snapshots.push(1);
      },
      reportTmuxCommandFailure: (message) => {
        failures.push(message);
      },
      onTmuxServerGone: (message) => {
        gone.push(message);
      },
      notifySessionClosed: () => {},
      shutdownInternal: async (notifyClose) => {
        shutdowns.push(notifyClose);
      },
      getControlWriter: () => null,
      getControlCommandTimeoutMs: () => 10_000,
      runHistoryQuery: async (argv) => {
        calls.push(argv);
        return ok();
      },
      runHistoryCapture: async () => '',
      ...overrides,
    };
    return { host, allowCalls, events, snapshots, failures, shutdowns, gone, responses, calls };
  }

  test('configureSessionOptions runs session flags, env, default-path, then window style', async () => {
    const { host, allowCalls } = createHost();
    await new SessionCommands(host).configureSessionOptions();
    expect(allowCalls.map((argv) => argv.join(' '))).toEqual([
      'set-option -t tmex -s allow-passthrough off',
      'set-option -t tmex -g extended-keys on',
      'set-option -t tmex -s extended-keys-format csi-u',
      'set-option -t tmex -g focus-events off',
      'set-option -t tmex destroy-unattached off',
      'set-environment -t tmex TERM_PROGRAM ghostty',
      'set-environment -t tmex COLORTERM truecolor',
      'set-option -t tmex default-path /tmp/work',
      '__configureWindowStyle__',
    ]);
  });

  test('ensureSession creates a detached session only when has-session fails', async () => {
    const createdHost = createHost();
    createdHost.responses.set('has-session -t tmex', fail("can't find session: tmex"));
    createdHost.responses.set('new-session -d -c /tmp/work -s tmex', ok());
    expect(await new SessionCommands(createdHost.host).ensureSession()).toEqual({ created: true });
    expect(createdHost.allowCalls.map((argv) => argv.join(' '))).toEqual([
      'has-session -t tmex',
      'new-session -d -c /tmp/work -s tmex',
    ]);

    const existing = createHost();
    expect(await new SessionCommands(existing.host).ensureSession()).toEqual({ created: false });
    expect(existing.allowCalls.map((argv) => argv.join(' '))).toEqual(['has-session -t tmex']);
  });

  test('createParkingWindow uses the parking name and command, and warns on failure', async () => {
    const failing = createHost();
    failing.responses.set(
      `new-window -t tmex -n ${PARKING_WINDOW_NAME} -P -F #{window_id} sleep 30`,
      fail('nope')
    );
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      expect(await new SessionCommands(failing.host).createParkingWindow()).toBeNull();
    } finally {
      console.warn = originalWarn;
    }
    expect(warns[0]).toBe(
      '[test] failed to create parking window on dev-1, attaching without focus shield'
    );

    const okHost = createHost();
    okHost.responses.set(
      `new-window -t tmex -n ${PARKING_WINDOW_NAME} -P -F #{window_id} sleep 30`,
      ok(' @99 \n')
    );
    expect(await new SessionCommands(okHost.host).createParkingWindow()).toBe('@99');
  });

  test('closeWindowInternal inserts a replacement window before killing the last one', async () => {
    const { host, allowCalls, snapshots, responses } = createHost();
    responses.set('display-message -p -t tmex #{session_windows}', ok('1\n'));
    responses.set('new-window -d -t tmex -c /tmp/work', ok());
    responses.set('kill-window -t @1', ok());
    await new SessionCommands(host).closeWindowInternal('@1');
    expect(allowCalls.map((argv) => argv.join(' '))).toEqual([
      'display-message -p -t tmex #{session_windows}',
      'new-window -d -t tmex -c /tmp/work',
      'kill-window -t @1',
    ]);
    expect(snapshots).toEqual([1]);
  });

  test('runTmux recovers from a missing target, silences, or classifies a gone server', async () => {
    const missing = createHost();
    missing.responses.set('select-pane -t %9', fail("can't find pane: %9"));
    const commands = new SessionCommands(missing.host);
    const recovered = await commands.runTmux(['select-pane', '-t', '%9'], true);
    expect(recovered.exitCode).toBe(1);
    expect(missing.host.activePaneId).toBeNull();
    expect(missing.snapshots).toEqual([1]);
    expect(missing.failures).toEqual([]);

    const silent = createHost();
    silent.responses.set('select-pane -t %9', fail("can't find pane: %9"));
    await expect(
      new SessionCommands(silent.host).runTmux(['select-pane', '-t', '%9'], 'silent')
    ).rejects.toBeInstanceOf(TmuxTargetMissingError);

    const gone = createHost();
    gone.responses.set('list-sessions', fail('no server running on /tmp/tmux-1000/default'));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await expect(new SessionCommands(gone.host).runTmux(['list-sessions'])).rejects.toThrow(
        'no server running on /tmp/tmux-1000/default'
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(gone.failures).toEqual(['no server running on /tmp/tmux-1000/default']);
    expect(gone.gone).toEqual(['no server running on /tmp/tmux-1000/default']);
    expect(gone.shutdowns).toEqual([true]);
  });

  test('splitPaneInternal emits pane-active from the formatted tmux response', async () => {
    const { host, events, snapshots, responses } = createHost();
    responses.set(
      `split-window -h -t %1 -c /tmp/work -P -F #{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
      ok(`@2${SNAPSHOT_FIELD_SEPARATOR}%8\n`)
    );
    await new SessionCommands(host).splitPaneInternal('%1', 'h');
    expect(host.activeWindowId).toBe('@2');
    expect(host.activePaneId).toBe('%8');
    expect(events).toEqual([{ type: 'pane-active', data: { windowId: '@2', paneId: '%8' } }]);
    expect(snapshots).toEqual([1]);
  });

  test('selectWindow treats missing window targets as benign and refreshes snapshot', async () => {
    const { host, allowCalls, snapshots, failures, responses } = createHost();
    const errors: Error[] = [];
    host.callbacks.onError = (error) => {
      errors.push(error);
    };
    responses.set('select-window -t @404', fail("can't find window: @404"));

    new SessionCommands(host).selectWindow('@404');
    await Bun.sleep(0);

    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
    expect(allowCalls.map((argv) => argv.join(' '))).toEqual(['select-window -t @404']);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(host.activeWindowId).toBeNull();
  });

  test('resizePane keeps window-size in manual mode instead of forcing latest', async () => {
    const { host, allowCalls, failures, responses } = createHost();
    host.snapshotWindows.set('@1', {
      id: '@1',
      index: 0,
      name: 'main',
      active: true,
      panes: [{ id: '%1' } as TmuxWindow['panes'][number]],
    });
    responses.set('resize-window -t @1 -x 137 -y 41', ok());

    new SessionCommands(host).resizePane('%1', 137, 41);
    await Bun.sleep(0);

    expect(failures).toEqual([]);
    expect(allowCalls.map((argv) => argv.join(' '))).toEqual(['resize-window -t @1 -x 137 -y 41']);
    expect(allowCalls.map((argv) => argv.join(' '))).not.toContain(
      'set-window-option -t @1 window-size latest'
    );
  });
});
