import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Device, StateSnapshotPayload } from '@vibeterm/shared';

import { createDevice as createDeviceRow, getDeviceById, getDeviceRuntimeStatus } from '../db';
import { runMigrations } from '../db/migrate';
import type { ControlModeCommandQueue } from './control-mode-capture';
import type { TmuxEvent } from './events';
import type { InputCommandWindow } from './input-command-window';
import { PIPELINED_INPUT_TIMEOUT_MS } from './input-encoder';
import {
  type ControlClientProcess,
  LocalExternalTmuxConnection,
  appendRollingTail,
  decodeRollingTail,
  defaultRun,
  readTextWithByteLimit,
  shouldIgnoreReaderAbortError,
} from './local-external-connection';
import { PaneInputPacer } from './pane-input-pacer';
import { TmuxTargetMissingError } from './target-missing';

const now = '2026-04-14T00:00:00.000Z';
const encoder = new TextEncoder();

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function createDevice(session = 'vibeterm-test'): Device {
  return {
    id: 'device-local',
    name: 'local',
    type: 'local',
    authMode: 'auto',
    session,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function isConfigureSessionOptionCommand(command: string, session: string): boolean {
  return (
    command === `set-option -t ${session} -s allow-passthrough off` ||
    command === `set-option -t ${session} -g extended-keys on` ||
    command === `set-option -t ${session} -s extended-keys-format csi-u` ||
    command === `set-option -t ${session} -g focus-events off` ||
    command === `set-option -t ${session} destroy-unattached off` ||
    command === `set-environment -t ${session} TERM_PROGRAM ghostty` ||
    command === `set-environment -t ${session} COLORTERM truecolor` ||
    command.startsWith(`set-option -t ${session} default-path `) ||
    command ===
      `set-hook -t ${session} after-new-window set-option -w window-style 'fg=#d0d0d0,bg=#262626'` ||
    command === 'set-option -w -t @1 window-style fg=#d0d0d0,bg=#262626'
  );
}

function createRunStub(
  session: string,
  options: {
    record?: string[][];
    overrides?: (command: string) => CommandResult | null;
  } = {}
) {
  return async (argv: string[]): Promise<CommandResult> => {
    options.record?.push(argv);
    const command = argv.slice(1).join(' ');
    const overridden = options.overrides?.(command);
    if (overridden) {
      return overridden;
    }
    if (command === '-V') {
      return ok('tmux 3.4\n');
    }
    if (command === `has-session -t ${session}`) {
      return ok();
    }
    if (command === 'show-options -gqv @vibeterm-server-epoch') {
      return ok('00112233445566778899aabbccddeeff\n');
    }
    if (command === `new-window -t ${session} -n vibeterm-park -P -F #{window_id} sleep 30`) {
      return ok('@99\n');
    }
    if (
      command.startsWith(`new-window -t ${session} -c `) ||
      command.startsWith(`new-window -d -t ${session} -c `)
    ) {
      return ok();
    }
    if (command === `last-window -t ${session}` || command === 'kill-window -t @99') {
      return ok();
    }
    if (
      isConfigureSessionOptionCommand(command, session) ||
      command === `set-option -t ${session} default-terminal xterm-ghostty`
    ) {
      return ok();
    }
    if (command.startsWith(`display-message -p -t ${session} #{session_id}`)) {
      return ok(`$1|${session}\n`);
    }
    if (command === `list-windows -t ${session} -F #{window_id}`) {
      return ok('@1\n');
    }
    if (command.startsWith(`list-windows -t ${session}`)) {
      return ok('@1|0|1|ba9d,80x24,0,0,1|main\n');
    }
    if (command.startsWith(`list-panes -s -t ${session}`)) {
      return ok('%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n');
    }
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
}

interface FakeControlProcess {
  proc: ControlClientProcess;
  pushStdout: (text: string) => void;
  closeStdout: () => void;
  exit: (code: number) => void;
  killed: () => boolean;
  writtenData: string[];
}

function createFakeControlProcess(): FakeControlProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;
  let killed = false;
  let closed = false;
  let commandId = 10;
  const writtenData: string[] = [];

  const close = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      stdoutController.close();
    } catch {
      /* already closed */
    }
    try {
      stderrController.close();
    } catch {
      /* already closed */
    }
    exitResolve(code);
  };

  return {
    proc: {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      exited: new Promise<number>((resolve) => {
        exitResolve = resolve;
      }),
      kill: () => {
        killed = true;
        close(0);
      },
      write: (data: string) => {
        writtenData.push(data);
        if (data.startsWith('refresh-client -B ') || data.startsWith('refresh-client -A ')) {
          const id = commandId++;
          queueMicrotask(() => {
            try {
              stdoutController.enqueue(encoder.encode(`%begin 1 ${id} 0\n%end 1 ${id} 0\n`));
            } catch {}
          });
        }
      },
    },
    pushStdout: (text) => stdoutController.enqueue(encoder.encode(text)),
    closeStdout: () => {
      try {
        stdoutController.close();
      } catch {
        /* already closed */
      }
    },
    exit: (code) => close(code),
    killed: () => killed,
    writtenData,
  };
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    await Bun.sleep(10);
  }
  throw new Error('waitFor timeout');
}

beforeAll(() => {
  runMigrations();
});

describe('readTextWithByteLimit', () => {
  test('returns the most recent bytes when stdout exceeds the capture byte cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('01234567'));
        controller.enqueue(encoder.encode('89ABCDEF'));
        controller.close();
      },
    });
    await expect(readTextWithByteLimit(stream, 10)).resolves.toBe('6789ABCDEF');
  });

  test('returns the decoded text when under the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ok'));
        controller.close();
      },
    });
    await expect(readTextWithByteLimit(stream, 16)).resolves.toBe('ok');
  });

  test('does not emit replacement chars when a multibyte UTF-8 char is split at the byte cap', async () => {
    const euro = encoder.encode('€');
    expect(euro.byteLength).toBe(3);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(euro);
        controller.close();
      },
    });
    const text = await readTextWithByteLimit(stream, 2);
    expect(text).toBe('');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  test('keeps a complete multibyte char that sits entirely inside the retained tail', async () => {
    const payload = encoder.encode('ab€');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    await expect(readTextWithByteLimit(stream, 4)).resolves.toBe('b€');
  });
});

describe('decodeRollingTail UTF-8 alignment', () => {
  test('drops leading continuation bytes left by a mid-sequence byte trim', () => {
    const euro = encoder.encode('€');
    const chunks: Uint8Array[] = [];
    const next = appendRollingTail(chunks, 0, euro, 2);
    expect(next.total).toBe(2);
    const text = decodeRollingTail(chunks, next.total);
    expect(text).toBe('');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  test('overflow 截在 3 字节 lead 之后不产出 U+FFFD', () => {
    const euro = encoder.encode('€');
    const payload = new Uint8Array([0x61, 0x62, 0x63, 0x64, euro[0]]);
    const chunks: Uint8Array[] = [];
    const next = appendRollingTail(chunks, 0, payload, 4);
    expect(next.total).toBe(4);
    const text = decodeRollingTail(chunks, next.total);
    expect(text).toBe('bcd');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  test('截在 3 字节序列中段不产出 U+FFFD', () => {
    const euro = encoder.encode('€');
    const buf = new Uint8Array([0x61, euro[0], euro[1]]);
    const text = decodeRollingTail([buf], buf.length);
    expect(text).toBe('a');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  test('截在 4 字节序列中段不产出 U+FFFD', () => {
    const grin = encoder.encode('😀');
    expect(grin.byteLength).toBe(4);
    const buf = new Uint8Array([0x61, grin[0], grin[1], grin[2]]);
    const text = decodeRollingTail([buf], buf.length);
    expect(text).toBe('a');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  test('overflow 截在 4 字节 lead 之后不产出 U+FFFD', () => {
    const grin = encoder.encode('😀');
    const payload = new Uint8Array([0x61, 0x62, 0x63, 0x64, grin[0]]);
    const chunks: Uint8Array[] = [];
    const next = appendRollingTail(chunks, 0, payload, 4);
    const text = decodeRollingTail(chunks, next.total);
    expect(text).toBe('bcd');
    expect(text.includes('\uFFFD')).toBe(false);
  });

  test('同时裁掉头部 continuation 与尾部不完整序列', () => {
    const euro = encoder.encode('€');
    const grin = encoder.encode('😀');
    const buf = new Uint8Array([euro[1], euro[2], 0x61, 0x62, grin[0], grin[1]]);
    const text = decodeRollingTail([buf], buf.length);
    expect(text).toBe('ab');
    expect(text.includes('\uFFFD')).toBe(false);
  });
});

describe('defaultRun history capture bound', () => {
  test('over-limit capture returns the tail, not an error', async () => {
    const payload = `${'H'.repeat(20)}TAIL`;
    const result = await defaultRun(['/bin/sh', '-c', `printf '%s' '${payload}'`], 8);
    expect(result.stdout).toBe(payload.slice(-8));
    expect(result.exitCode).toBe(0);
  });
});

describe('LocalExternalTmuxConnection', () => {
  test('shouldIgnoreReaderAbortError matches releaseLock abort noise', () => {
    expect(
      shouldIgnoreReaderAbortError({
        name: 'AbortError',
        code: 'ERR_STREAM_RELEASE_LOCK',
        message: 'Stream reader cancelled via releaseLock()',
      })
    ).toBe(true);

    expect(shouldIgnoreReaderAbortError(new Error('boom'))).toBe(false);
  });

  test('connect runs exact command sequence with control-mode session options', async () => {
    const calls: string[][] = [];
    const snapshots: StateSnapshotPayload[] = [];
    const device = createDevice('vibeterm-snapshot');
    device.defaultWorkingDir = '/tmp/vibeterm-test-cwd';
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: (payload) => snapshots.push(payload),
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub('vibeterm-snapshot', {
          record: calls,
          overrides: (command) => {
            if (command === 'has-session -t vibeterm-snapshot') {
              return { exitCode: 1, stdout: '', stderr: "can't find session: vibeterm-snapshot" };
            }
            if (command === 'new-session -d -c /tmp/vibeterm-test-cwd -s vibeterm-snapshot') {
              return ok();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();

    expect(calls.map((argv) => argv.join(' '))).toEqual([
      'tmux -V',
      'tmux has-session -t vibeterm-snapshot',
      'tmux new-session -d -c /tmp/vibeterm-test-cwd -s vibeterm-snapshot',
      'tmux list-windows -t vibeterm-snapshot -F #{window_id}|#{window_name}',
      'tmux show-options -gqv @vibeterm-server-epoch',
      'tmux set-option -t vibeterm-snapshot -s allow-passthrough off',
      'tmux set-option -t vibeterm-snapshot -g extended-keys on',
      'tmux set-option -t vibeterm-snapshot -s extended-keys-format csi-u',
      'tmux set-option -t vibeterm-snapshot -g focus-events off',
      'tmux set-option -t vibeterm-snapshot destroy-unattached off',
      'tmux set-environment -t vibeterm-snapshot TERM_PROGRAM ghostty',
      'tmux set-environment -t vibeterm-snapshot COLORTERM truecolor',
      'tmux set-option -t vibeterm-snapshot default-path /tmp/vibeterm-test-cwd',
      "tmux set-hook -t vibeterm-snapshot after-new-window set-option -w window-style 'fg=#d0d0d0,bg=#262626'",
      'tmux list-windows -t vibeterm-snapshot -F #{window_id}',
      'tmux set-option -w -t @1 window-style fg=#d0d0d0,bg=#262626',
      'tmux display-message -p -t vibeterm-snapshot #{session_id}|#{session_name}',
      'tmux list-windows -t vibeterm-snapshot -F #{window_id}|#{window_index}|#{window_active}|#{window_layout}|#{window_name}',
      'tmux list-panes -s -t vibeterm-snapshot -F #{pane_id}|#{window_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}|#{window_active}|#{pane_title}|#{pane_current_command}|#{pane_current_path}',
      'tmux list-panes -a -F #{pane_id}|#{@vibeterm_2031}|#{@tmex_2031}',
    ]);
    expect(snapshots).toEqual([
      {
        deviceId: 'device-local',
        session: {
          id: '$1',
          name: 'vibeterm-snapshot',
          windows: [
            {
              id: '@1',
              index: 0,
              name: 'main',
              active: true,
              layout: 'ba9d,80x24,0,0,1',
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  title: 'bash',
                  currentCommand: 'node',
                  currentPath: '/home/user',
                  active: true,
                  width: 80,
                  height: 24,
                  left: 0,
                  top: 0,
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  test('connect rejects when tmux is too old for control mode', async () => {
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-version'),
        run: createRunStub('vibeterm-version', {
          overrides: (command) => (command === '-V' ? ok('tmux 2.9a\n') : null),
        }),
        spawnControlClient: () => {
          throw new Error('should not spawn control client on old tmux');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow(/control mode requires tmux >= 3.0/);
  });

  test('control client subscription streams output, bell and notifications', async () => {
    const fake = createFakeControlProcess();
    const outputs: Array<{ paneId: string; text: string }> = [];
    const events: TmuxEvent[] = [];
    let snapshotCount = 0;

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: (event) => {
          events.push(event);
        },
        onTerminalOutput: (paneId, data) => {
          outputs.push({ paneId, text: new TextDecoder().decode(data) });
        },
        onTerminalHistory: () => {},
        onSnapshot: () => {
          snapshotCount += 1;
        },
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-stream'),
        run: createRunStub('vibeterm-stream'),
        spawnControlClient: (argv) => {
          expect(argv).toEqual(['tmux', '-C', 'attach-session', '-t', 'vibeterm-stream']);
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-stream\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();
    const baseSnapshots = snapshotCount;

    fake.pushStdout('%output %1 hello\\015\\012\n');
    fake.pushStdout('%output %1 \\007\n');
    fake.pushStdout('%output %1 \\033]9;notify body\\007\n');

    await waitFor(() => (outputs.length > 0 ? outputs : null));
    expect(outputs).toEqual([{ paneId: '%1', text: 'hello\r\n' }]);

    await waitFor(() => events.find((event) => event.type === 'bell') ?? null);
    const notification = await waitFor(
      () => events.find((event) => event.type === 'notification') ?? null
    );
    expect(notification.data).toEqual({
      paneId: '%1',
      source: 'osc9',
      body: 'notify body',
    });

    fake.pushStdout('%window-add @2\n');
    await waitFor(() => (snapshotCount > baseSnapshots ? snapshotCount : null));

    connection.disconnect();
    expect(fake.killed()).toBe(true);
  });

  test('control title updates stay on the realtime metadata path without tmux snapshots', async () => {
    const fake = createFakeControlProcess();
    const commands: string[][] = [];
    const snapshots: StateSnapshotPayload[] = [];
    const titles: string[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSourceMetadata: (event) => {
          if (event.type === 'pane-title') titles.push(event.title);
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-title'),
        run: createRunStub('vibeterm-title', { record: commands }),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-title\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();
    commands.length = 0;
    snapshots.length = 0;

    for (let index = 0; index < 50; index += 1) {
      fake.pushStdout(`%output %1 \\033]2;build-${index}\\007\n`);
    }

    await waitFor(() => (titles.length === 50 ? true : null));

    expect(
      commands.filter((argv) => {
        const command = argv.slice(1).join(' ');
        return (
          command.startsWith('display-message -p -t vibeterm-title') ||
          command.startsWith('list-windows -t vibeterm-title') ||
          command.startsWith('list-panes -s -t vibeterm-title')
        );
      })
    ).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(titles.at(-1)).toBe('build-49');

    fake.pushStdout('%output %1 \\033]2;build-49\\007\n');
    await waitFor(() => (titles.length === 51 ? true : null));
    expect(snapshots).toEqual([]);

    connection.disconnect();
  });

  test('canonical screen capture takes its sequence barrier before following live output', async () => {
    const fake = createFakeControlProcess();
    const outputs: string[] = [];
    const barrierOutputCounts: number[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: (_paneId, data) => outputs.push(new TextDecoder().decode(data)),
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-canonical-capture'),
        run: createRunStub('vibeterm-canonical-capture'),
        spawnControlClient: () => {
          fake.pushStdout(
            '%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-canonical-capture\n'
          );
          return fake.proc;
        },
      }
    );
    await connection.connect();
    await Bun.sleep(0);

    const capturePromise = connection.capturePaneFrameAtBarrier('%1', 10, () => {
      barrierOutputCounts.push(outputs.length);
    });
    fake.pushStdout(
      '%begin 2 20 0\n80|24|0|3|4|100\n%end 2 20 0\n' +
        '%begin 2 21 0\n%output literal screen row\n%end 2 21 0\n' +
        '%begin 2 22 0\nhistory row\n%end 2 22 0\n' +
        '%output %1 live-after-capture\n'
    );

    await expect(capturePromise).resolves.toMatchObject({
      text: '%output literal screen row',
      historyText: 'history row',
      cols: 80,
      rows: 24,
      historySize: 100,
    });
    await waitFor(() => (outputs.length === 1 ? true : null));
    expect(barrierOutputCounts).toEqual([0]);
    expect(outputs).toEqual(['live-after-capture']);
    connection.disconnect();
  });

  test('an unknown pane title is forwarded for projection-owned reconciliation', async () => {
    const fake = createFakeControlProcess();
    const session = 'vibeterm-pending-title';
    const commands: string[][] = [];
    const snapshots: StateSnapshotPayload[] = [];
    const titles: Array<{ paneId: string; title: string }> = [];
    let includeSecondPane = false;
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSourceMetadata: (event) => {
          if (event.type === 'pane-title')
            titles.push({ paneId: event.paneId, title: event.title });
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          record: commands,
          overrides: (command) => {
            if (command.startsWith(`list-panes -s -t ${session}`) && includeSecondPane) {
              return ok(
                '%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n%2|@1|1|0|80|24|0|0|1|stale|node|/home/user\n'
              );
            }
            return null;
          },
        }),
        spawnControlClient: () => {
          fake.pushStdout(`%begin 1 1 0\n%end 1 1 0\n%session-changed $1 ${session}\n`);
          return fake.proc;
        },
      }
    );

    await connection.connect();
    commands.length = 0;
    snapshots.length = 0;

    fake.pushStdout('%output %2 \\033]2;pending-title\\007\n');
    await waitFor(() => (titles.length === 1 ? true : null));
    expect(commands).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(titles).toEqual([{ paneId: '%2', title: 'pending-title' }]);

    includeSecondPane = true;
    fake.pushStdout('%window-add @2\n');
    await waitFor(() => (snapshots.length > 0 ? true : null));

    expect(snapshots[0]?.session?.windows[0]?.panes.find((pane) => pane.id === '%2')?.title).toBe(
      'stale'
    );

    connection.disconnect();
  });

  test('control client restarts after unexpected exit and resyncs snapshot', async () => {
    const fakes: FakeControlProcess[] = [];
    let snapshotCount = 0;

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {
          snapshotCount += 1;
        },
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-restart'),
        run: createRunStub('vibeterm-restart'),
        spawnControlClient: () => {
          const fake = createFakeControlProcess();
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-restart\n');
          fakes.push(fake);
          return fake.proc;
        },
      }
    );

    await connection.connect();
    expect(fakes).toHaveLength(1);

    const baseSnapshots = snapshotCount;
    fakes[0]?.exit(1);

    await waitFor(() => (fakes.length === 2 ? fakes : null));
    await waitFor(() => (snapshotCount > baseSnapshots ? snapshotCount : null));

    connection.disconnect();
  }, 10_000);

  test('control client exit tears down when session is gone', async () => {
    const fakes: FakeControlProcess[] = [];
    let closed = false;
    let sessionGone = false;

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {
          closed = true;
        },
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-gone'),
        run: createRunStub('vibeterm-gone', {
          overrides: (command) => {
            if (sessionGone && command === 'has-session -t vibeterm-gone') {
              return { exitCode: 1, stdout: '', stderr: "can't find session: vibeterm-gone" };
            }
            if (sessionGone && command.startsWith('display-message -p -t vibeterm-gone')) {
              return { exitCode: 1, stdout: '', stderr: "can't find session: vibeterm-gone" };
            }
            if (sessionGone && command.startsWith('list-windows -t vibeterm-gone')) {
              return { exitCode: 1, stdout: '', stderr: "can't find session: vibeterm-gone" };
            }
            if (sessionGone && command.startsWith('list-panes -s -t vibeterm-gone')) {
              return { exitCode: 1, stdout: '', stderr: "can't find session: vibeterm-gone" };
            }
            return null;
          },
        }),
        spawnControlClient: () => {
          const fake = createFakeControlProcess();
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-gone\n');
          fakes.push(fake);
          return fake.proc;
        },
      }
    );

    await connection.connect();
    sessionGone = true;
    fakes[0]?.exit(1);

    await waitFor(() => (closed ? true : null));
    expect(fakes).toHaveLength(1);
  }, 10_000);

  test('sendInput encodes payload as tmux send-keys -H chunks', async () => {
    const commands: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-input'),
        run: createRunStub('vibeterm-input', {
          record: commands,
          overrides: (command) => (command.startsWith('send-keys -H -t %1') ? ok() : null),
        }),
      }
    );

    await connection.connect();
    connection.sendInput('%1', 'A中');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.at(-1)).toEqual([
      'tmux',
      'send-keys',
      '-H',
      '-t',
      '%1',
      '41',
      'e4',
      'b8',
      'ad',
    ]);
  });

  test('sendInput serializes tmux send-keys calls to preserve character order', async () => {
    const commands: string[][] = [];
    const sendResolvers: Array<() => void> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-input-serial'),
        run: async (argv) => {
          commands.push(argv);
          const command = argv.slice(1).join(' ');
          if (command === 'send-keys -H -t %1 41' || command === 'send-keys -H -t %1 42') {
            await new Promise<void>((resolve) => {
              sendResolvers.push(resolve);
            });
            return ok();
          }
          return createRunStub('vibeterm-input-serial')(argv);
        },
      }
    );

    await connection.connect();
    connection.sendInput('%1', 'A');
    connection.sendInput('%1', 'B');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.map((argv) => argv.slice(1).join(' '))).toContain('send-keys -H -t %1 41');
    expect(commands.map((argv) => argv.slice(1).join(' '))).not.toContain('send-keys -H -t %1 42');

    sendResolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.map((argv) => argv.slice(1).join(' '))).toContain('send-keys -H -t %1 42');

    sendResolvers.shift()?.();
  });

  test('logs tmux command context when a non-target-missing command fails', async () => {
    const session = 'vibeterm-command-context';
    const errors: Error[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) =>
            command === 'rename-window -t @1 broken'
              ? { exitCode: 1, stdout: '', stderr: 'rename failed' }
              : null,
        }),
      }
    );

    try {
      await connection.connect();
      connection.renameWindow('@1', 'broken');
      await waitFor(() => (errors.length > 0 ? true : null));

      expect(
        warn.mock.calls.some((call) => {
          const text = call.map(String).join(' ');
          return (
            text.includes('[local] tmux command failed') &&
            text.includes('device-local') &&
            text.includes(session) &&
            text.includes('rename-window -t @1 broken') &&
            text.includes('exitCode=1')
          );
        })
      ).toBe(true);
    } finally {
      warn.mockRestore();
      connection.disconnect();
    }
  });

  test('applyStackedLayout serializes resize-window before select-layout', async () => {
    const commands: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-stacked-layout'),
        run: createRunStub('vibeterm-stacked-layout', {
          record: commands,
          overrides: (command) => {
            if (command === 'resize-window -t @1 -x 85 -y 24') return ok();
            if (command === 'select-layout -t @1 even-horizontal') return ok();
            return null;
          },
        }),
      }
    );

    await connection.connect();
    (connection as any).applyStackedLayout('@1', 85, 24);

    await waitFor(() => {
      const names = commands.map((argv) => argv.slice(1).join(' '));
      return names.includes('select-layout -t @1 even-horizontal') ? names : null;
    });

    const names = commands.map((argv) => argv.slice(1).join(' '));
    expect(names.indexOf('resize-window -t @1 -x 85 -y 24')).toBeLessThan(
      names.indexOf('select-layout -t @1 even-horizontal')
    );
  });

  test('capturePaneHistory falls back to normal capture when alternate capture is visually empty', async () => {
    const histories: Array<{
      paneId: string;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen, modes) => {
          histories.push({ paneId, data, alternateScreen, modes });
        },
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-alt-fallback'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (
            command ===
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}'
          ) {
            return ok('1 8 3 40 0 0 0 0 0\n');
          }
          if (command === 'capture-pane -t %1 -S -4096 -E - -e -J -N -p') {
            return ok('VIM SCREEN\n');
          }
          if (command === 'capture-pane -t %1 -a -S -4096 -E - -e -J -N -p -q') {
            return ok('\n\n\n');
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'VIM SCREEN\x1b[4;9H',
        alternateScreen: true,
        modes: 0,
      },
    ]);
  });

  test('capturePaneHistory prefers current visible capture when pane is in alternate screen', async () => {
    const histories: Array<{
      paneId: string;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen, modes) => {
          histories.push({ paneId, data, alternateScreen, modes });
        },
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-alt-visible'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (
            command ===
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}'
          ) {
            return ok('1 2 1 40 0 1 0 1 0\n');
          }
          if (command === 'capture-pane -t %1 -S -4096 -E - -e -J -N -p') {
            return ok('VISIBLE TUI\n');
          }
          if (command === 'capture-pane -t %1 -a -S -4096 -E - -e -J -N -p -q') {
            return ok('sh-3.2$ opencode .\n');
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'VISIBLE TUI\x1b[2;3H',
        alternateScreen: true,
        modes: 10,
      },
    ]);
  });

  test('capturePaneHistory appends relative cursor restore for normal screen', async () => {
    const histories: Array<{
      paneId: string;
      data: string;
      alternateScreen: boolean;
      modes: number;
    }> = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: (paneId, data, alternateScreen, modes) => {
          histories.push({ paneId, data, alternateScreen, modes });
        },
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-normal-cursor'),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (
            command ===
            'display-message -p -t %1 #{alternate_on} #{cursor_x} #{cursor_y} #{pane_height} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}'
          ) {
            // 光标在可见区域倒数第 3 行（如 Claude Code 输入行），列 8
            return ok('0 8 1 4 0 0 0 0 0\n');
          }
          if (command === 'capture-pane -t %1 -S -4096 -E - -e -J -N -p') {
            return ok('sh-3.2$ \n> input   \nstatus bar\n\n');
          }
          if (command === 'capture-pane -t %1 -a -S -4096 -E - -e -J -N -p -q') {
            return ok('');
          }
          throw new Error(`unexpected command: ${command}`);
        },
      }
    );

    await (connection as any).capturePaneHistory('%1');

    expect(histories).toEqual([
      {
        paneId: '%1',
        data: 'sh-3.2$ \n> input   \nstatus bar\n\x1b[2A\x1b[9G',
        alternateScreen: false,
        modes: 0,
      },
    ]);
  });

  test('setWindowStyle re-applies client style to hook and existing windows', async () => {
    const session = 'vibeterm-style';
    const lightStyle = 'fg=#616161,bg=#e1e1e1';
    const calls: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          record: calls,
          overrides: (command) => {
            if (
              command ===
                `set-hook -t ${session} after-new-window set-option -w window-style '${lightStyle}'` ||
              command === `set-option -w -t @1 window-style ${lightStyle}`
            ) {
              return ok();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.setWindowStyle(lightStyle);
    await waitFor(() => (calls.length >= 3 ? true : null));

    expect(calls.map((argv) => argv.join(' '))).toEqual([
      `tmux set-hook -t ${session} after-new-window set-option -w window-style '${lightStyle}'`,
      `tmux list-windows -t ${session} -F #{window_id}`,
      `tmux set-option -w -t @1 window-style ${lightStyle}`,
    ]);
  });

  test('setWindowStyle ignores style with unsafe characters', async () => {
    const session = 'vibeterm-style-bad';
    const calls: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.setWindowStyle("fg=#ffffff' ; kill-server #");
    await Bun.sleep(50);

    expect(calls).toEqual([]);
  });

  test('capturePaneText pane missing throws TmuxTargetMissingError without polluting device status', async () => {
    const deviceId = 'device-local-capture-missing';
    const session = 'vibeterm-capture-missing';
    const device = { ...createDevice(session), id: deviceId };
    createDeviceRow(device);

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId,
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub(session, {
          overrides: (command) => {
            if (command === 'capture-pane -t %1 -p -J') {
              return ok('screen text\n');
            }
            if (command === 'capture-pane -t %404 -p -J') {
              return { exitCode: 1, stdout: '', stderr: "can't find pane: %404" };
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    await expect(connection.capturePaneText('%1')).resolves.toBe('screen text\n');

    let captured: unknown = null;
    try {
      await connection.capturePaneText('%404');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TmuxTargetMissingError);

    // 静默形态不得污染设备运行状态（connect 成功时写入的健康状态保持不变）
    const status = getDeviceRuntimeStatus(deviceId);
    expect(status.tmuxAvailable).toBe(true);
    expect(status.lastError).toBeNull();

    connection.disconnect();
  });

  test('createWindow uses homedir when defaultWorkingDir is empty', async () => {
    const session = 'vibeterm-cwd-empty';
    const calls: string[][] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.createWindow();
    await Bun.sleep(50);

    const homedir = require('node:os').homedir();
    const createCmd = calls.find((argv) => argv.includes('new-window'));
    expect(createCmd).toBeDefined();
    expect(createCmd).toContain('-c');
    expect(createCmd).toContain(homedir);
  });

  test('createWindow uses custom dir when defaultWorkingDir is set', async () => {
    const session = 'vibeterm-cwd-custom';
    const calls: string[][] = [];
    const device = createDevice(session);
    device.defaultWorkingDir = '/custom/path';

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          throw error;
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => device,
        run: createRunStub(session, { record: calls }),
      }
    );

    await connection.connect();
    calls.length = 0;

    connection.createWindow('test-win');
    await Bun.sleep(50);

    const createCmd = calls.find((argv) => argv.includes('new-window'));
    expect(createCmd).toBeDefined();
    expect(createCmd).toContain('-c');
    expect(createCmd).toContain('/custom/path');
    expect(createCmd).toContain('-n');
    expect(createCmd).toContain('test-win');
  });

  test('heartbeat sends display-message via write', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-heartbeat'),
        run: createRunStub('vibeterm-heartbeat'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-heartbeat\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    (connection as any).sendHeartbeat();

    expect(fake.writtenData).toContain('display-message -p "vibeterm-hb"\n');

    connection.disconnect();
  });

  test('heartbeat response clears pending state', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-hb-response'),
        run: createRunStub('vibeterm-hb-response'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-hb-response\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    (connection as any).sendHeartbeat();
    expect((connection as any).heartbeatPending).toBe(true);

    fake.pushStdout('%begin 2 2 0\nvibeterm-hb\n%end 2 2 0\n');

    await waitFor(() => (!(connection as any).heartbeatPending ? true : null));

    expect((connection as any).heartbeatPending).toBe(false);
    expect((connection as any).heartbeatTimeoutTimer).toBeNull();
    expect(fake.killed()).toBe(false);

    connection.disconnect();
  });

  test('heartbeat timeout kills process', async () => {
    const fakes: FakeControlProcess[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-hb-timeout'),
        run: createRunStub('vibeterm-hb-timeout'),
        spawnControlClient: () => {
          const f = createFakeControlProcess();
          f.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-hb-timeout\n');
          fakes.push(f);
          return f.proc;
        },
      }
    );

    await connection.connect();
    const target = fakes[0];
    if (!target) throw new Error('control process was not created');

    (connection as any).sendHeartbeat();
    expect(target.writtenData).toContain('display-message -p "vibeterm-hb"\n');

    // Replace the 10s timeout with a short one to avoid slow test.
    // The replacement replicates the same guard logic from sendHeartbeat.
    clearTimeout((connection as any).heartbeatTimeoutTimer);
    (connection as any).heartbeatTimeoutTimer = setTimeout(() => {
      const c = connection as any;
      if (!c.heartbeatPending || !c.connected || c.manualDisconnect) {
        return;
      }
      c.controlProcess?.kill();
    }, 50);

    await waitFor(() => (target.killed() ? true : null), 2000);
    expect(target.killed()).toBe(true);

    connection.disconnect();
  });

  test('%pause triggers continue command', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-pause'),
        run: createRunStub('vibeterm-pause'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-pause\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    fake.pushStdout('%pause %1\n');

    await waitFor(() => (fake.writtenData.some((d) => d.includes('refresh-client')) ? true : null));

    expect(fake.writtenData).toContain('refresh-client -A %1:continue\n');

    connection.disconnect();
  });

  test('pump stdout ending unexpectedly kills process', async () => {
    const fakes: FakeControlProcess[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-stdout-end'),
        run: createRunStub('vibeterm-stdout-end'),
        spawnControlClient: () => {
          const f = createFakeControlProcess();
          f.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-stdout-end\n');
          fakes.push(f);
          return f.proc;
        },
      }
    );

    await connection.connect();
    const target = fakes[0];
    if (!target) throw new Error('control process was not created');

    target.closeStdout();

    await waitFor(() => (target.killed() ? true : null));
    expect(target.killed()).toBe(true);

    connection.disconnect();
  });

  test('disconnect cleans up heartbeat timers', async () => {
    const fake = createFakeControlProcess();
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-hb-cleanup'),
        run: createRunStub('vibeterm-hb-cleanup'),
        spawnControlClient: () => {
          fake.pushStdout('%begin 1 1 0\n%end 1 1 0\n%session-changed $1 vibeterm-hb-cleanup\n');
          return fake.proc;
        },
      }
    );

    await connection.connect();

    expect((connection as any).heartbeatTimer).not.toBeNull();

    (connection as any).sendHeartbeat();
    expect((connection as any).heartbeatTimeoutTimer).not.toBeNull();

    connection.disconnect();

    expect((connection as any).heartbeatTimer).toBeNull();
    expect((connection as any).heartbeatTimeoutTimer).toBeNull();
    expect((connection as any).heartbeatPending).toBe(false);
  });

  test('requestSnapshot reports a non-transient list-windows error via onError without unhandled rejection', async () => {
    const session = 'vibeterm-snapshot-throw';
    let failListWindows = false;
    const errors: Error[] = [];
    const unhandled: unknown[] = [];

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) => {
            if (failListWindows && command.startsWith(`list-windows -t ${session}`)) {
              throw new Error('plain snapshot failure');
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    failListWindows = true;

    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const processEvents = process as unknown as {
      on(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): void;
      off(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): void;
    };
    processEvents.on('unhandledRejection', onUnhandled);
    try {
      connection.requestSnapshot();
      await waitFor(() => (errors.length > 0 ? true : null));
      await Bun.sleep(20);
    } finally {
      processEvents.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe('plain snapshot failure');
    connection.disconnect();
  });
});

describe('LocalExternalTmuxConnection lifecycle events', () => {
  type EmittedEvent = { eventType: string; event: any };

  function makeLifecycleConnection(options: {
    session: string;
    overrides?: (command: string) => CommandResult | null;
  }) {
    const events: EmittedEvent[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        notifyEvent: (eventType, event) => {
          events.push({ eventType, event });
        },
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(options.session),
        run: createRunStub(options.session, { overrides: options.overrides }),
      }
    );
    return { connection, events };
  }

  test('emits session_created only when the session is actually created', async () => {
    let created = false;
    const { connection, events } = makeLifecycleConnection({
      session: 'vibeterm-lc-created',
      overrides: (command) => {
        if (command === 'has-session -t vibeterm-lc-created' && !created) {
          created = true;
          return { exitCode: 1, stdout: '', stderr: "can't find session" };
        }
        if (command.startsWith('new-session -d -c ')) {
          return ok();
        }
        return null;
      },
    });

    await connection.connect();
    expect(events.map((e) => e.eventType)).toEqual(['session_created']);
    expect(events[0].event.tmux.sessionName).toBe('vibeterm-lc-created');
    expect(events[0].event.device.id).toBe('device-local');
    connection.disconnect();
  });

  test('does not emit session_created when the session already exists (and first snapshot emits no closures)', async () => {
    const { connection, events } = makeLifecycleConnection({ session: 'vibeterm-lc-existing' });
    await connection.connect();
    expect(events).toHaveLength(0);
    connection.disconnect();
  });

  test('emits tmux_pane_close when a pane disappears from the snapshot', async () => {
    let panesGone = false;
    const session = 'vibeterm-lc-pane';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (command.startsWith(`list-panes -s -t ${session}`) && panesGone) {
          return ok('%2|@1|1|1|80|24|0|0|1|bash|node|/home/user\n');
        }
        if (command.startsWith(`list-panes -s -t ${session}`)) {
          return ok(
            '%1|@1|0|1|80|24|0|0|1|first pane|vim|/home/user\n%2|@1|1|0|80|24|0|0|1|bash|node|/home/user\n'
          );
        }
        return null;
      },
    });

    await connection.connect();
    expect(events).toHaveLength(0);

    panesGone = true;
    connection.requestSnapshot();
    await waitFor(() => (events.length > 0 ? true : null));

    expect(events.map((e) => e.eventType)).toEqual(['tmux_pane_close']);
    expect(events[0].event.tmux.paneId).toBe('%1');
    expect(events[0].event.tmux.windowId).toBe('@1');
    expect(events[0].event.tmux.paneTitle).toBe('first pane');
    expect(events[0].event.tmux.paneCurrentCommand).toBe('vim');
    connection.disconnect();
  });

  test('emits tmux_window_close without per-pane events when a window disappears', async () => {
    let windowGone = false;
    const session = 'vibeterm-lc-window';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (command.startsWith(`list-windows -t ${session} -F #{window_id}|`)) {
          return windowGone
            ? ok('@1|0|1|ba9d,80x24,0,0,1|main\n')
            : ok('@1|0|1|ba9d,80x24,0,0,1|main\n@2|1|0|ba9d,80x24,0,0,2|second\n');
        }
        if (command === `list-windows -t ${session} -F #{window_id}`) {
          return windowGone ? ok('@1\n') : ok('@1\n@2\n');
        }
        if (command.startsWith('set-option -w -t @2 window-style')) {
          return ok();
        }
        if (command.startsWith(`list-panes -s -t ${session}`) && !windowGone) {
          return ok(
            '%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n%2|@2|0|1|80|24|0|0|0|bash|node|/home/user\n'
          );
        }
        return null;
      },
    });

    await connection.connect();
    expect(events).toHaveLength(0);

    windowGone = true;
    connection.requestSnapshot();
    await waitFor(() => (events.length > 0 ? true : null));

    expect(events.map((e) => e.eventType)).toEqual(['tmux_window_close']);
    expect(events[0].event.tmux.windowId).toBe('@2');
    expect(events[0].event.payload.windowName).toBe('second');
    connection.disconnect();
  });

  test('does not emit closures when the snapshot turns invalid', async () => {
    let invalid = false;
    const session = 'vibeterm-lc-invalid';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (invalid && command.startsWith(`display-message -p -t ${session}`)) {
          return ok('not-a-session-id|whatever\n');
        }
        return null;
      },
    });

    await connection.connect();
    invalid = true;
    connection.requestSnapshot();
    await Bun.sleep(200);

    expect(events).toHaveLength(0);
    connection.disconnect();
  });

  test('emits session_closed exactly once when the tmux server goes away during snapshot', async () => {
    let serverGone = false;
    const session = 'vibeterm-lc-gone';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (
          serverGone &&
          (command.startsWith(`display-message -p -t ${session}`) ||
            command.startsWith(`list-windows -t ${session}`) ||
            command.startsWith(`list-panes -s -t ${session}`))
        ) {
          return { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/sock' };
        }
        return null;
      },
    });

    await connection.connect();
    expect(events).toHaveLength(0);

    serverGone = true;
    // 并发触发两次：两个 in-flight 快照都会命中 server-gone 分支，once 守卫必须兜住
    connection.requestSnapshot();
    connection.requestSnapshot();
    await waitFor(() => (events.length > 0 ? true : null));
    await Bun.sleep(50);

    expect(events.map((e) => e.eventType)).toEqual(['session_closed']);
    expect(events[0].event.payload.message).toBe('no server running on /tmp/sock');
    expect(events[0].event.tmux.sessionName).toBe(session);
  });

  test('runTmux server-gone marks tmux unavailable before emitting session_closed', async () => {
    let serverGone = false;
    const session = 'vibeterm-lc-cmd-gone';
    const { connection, events } = makeLifecycleConnection({
      session,
      overrides: (command) => {
        if (command.startsWith('send-keys -H -t %1')) {
          return serverGone
            ? { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/sock' }
            : ok();
        }
        return null;
      },
    });

    // 设备行存在时 notifyRuntimeError 走 runtime 告警通路（不落 tmuxAvailable），
    // 只有 server-gone 分支负责把 tmuxAvailable 置 false
    if (!getDeviceById('device-local')) {
      createDeviceRow(createDevice(session));
    }

    await connection.connect();
    expect(events).toHaveLength(0);

    serverGone = true;
    connection.sendInput('%1', 'x');
    await waitFor(() => (events.length > 0 ? true : null));

    expect(events.map((e) => e.eventType)).toEqual(['session_closed']);
    const status = getDeviceRuntimeStatus('device-local');
    expect(status.tmuxAvailable).toBe(false);
    expect(status.lastError).toBe('no server running on /tmp/sock');
  });

  test('concurrent snapshot demands run one batch plus one trailing refresh without overlap', async () => {
    const session = 'vibeterm-lc-race';
    const fresh = '%2|@1|1|1|80|24|0|0|1|bash|node|/home/user\n';
    const stale =
      '%1|@1|0|1|80|24|0|0|1|first pane|vim|/home/user\n%2|@1|1|0|80|24|0|0|1|bash|node|/home/user\n';
    let paneListCalls = 0;
    const staleGate = Promise.withResolvers<void>();
    const baseRun = createRunStub(session);
    const events: EmittedEvent[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        notifyEvent: (eventType, event) => {
          events.push({ eventType, event });
        },
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command.startsWith(`list-panes -s -t ${session}`)) {
            paneListCalls += 1;
            if (paneListCalls === 1) {
              return ok(stale); // connect 首帧：两个 pane
            }
            if (paneListCalls === 2) {
              await staleGate.promise; // 请求 A：挂起直到手动放行，届时返回过期数据（%1 仍在）
              return ok(stale);
            }
            return ok(fresh); // 请求 B 与后续帧：%1 已关闭
          }
          return baseRun(argv);
        },
      }
    );

    await connection.connect();
    expect(events).toHaveLength(0);

    (connection as any).requestSnapshotInternal();
    await waitFor(() => (paneListCalls >= 2 ? true : null));
    // 刷新 A 已在途（被 staleGate 挂起），此时到达的请求按新语义合并成一次 trailing
    (connection as any).requestSnapshotInternal();
    (connection as any).requestSnapshotInternal();
    await Bun.sleep(30);

    expect(paneListCalls).toBe(2);
    expect(events).toHaveLength(0);

    staleGate.resolve();
    await waitFor(() => (events.length > 0 ? true : null));

    expect(paneListCalls).toBe(3);
    expect(events.map((e) => e.eventType)).toEqual(['tmux_pane_close']);

    connection.requestSnapshot();
    await Bun.sleep(200);
    expect(events.map((e) => e.eventType)).toEqual(['tmux_pane_close']);
    connection.disconnect();
  });

  test('disconnect during blocked connect does not resurrect after the block resolves', async () => {
    const session = 'vibeterm-cancel-connect';
    const snapshots: StateSnapshotPayload[] = [];
    const sourceReady: Uint8Array[] = [];
    let spawnCount = 0;
    let epochStarted = false;
    let releaseEpoch: (() => void) | undefined;
    const epochGate = new Promise<void>((resolve) => {
      releaseEpoch = resolve;
    });
    const stubRun = createRunStub(session);
    const fake = createFakeControlProcess();

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSourceReady: (epoch) => {
          sourceReady.push(epoch);
        },
        onSnapshot: (payload) => snapshots.push(payload),
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command === 'show-options -gqv @vibeterm-server-epoch') {
            epochStarted = true;
            await epochGate;
          }
          return stubRun(argv);
        },
        spawnControlClient: () => {
          spawnCount += 1;
          fake.pushStdout(`%begin 1 1 0\n%end 1 1 0\n%session-changed $1 ${session}\n`);
          return fake.proc;
        },
      }
    );

    const connectPromise = connection.connect();
    await waitFor(() => (epochStarted ? true : null));
    connection.disconnect();
    releaseEpoch?.();
    await connectPromise;

    expect((connection as any).connected).toBe(false);
    expect(sourceReady).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(spawnCount).toBe(0);
    expect(fake.killed()).toBe(false);
  });

  test('disconnect during control attach does not publish connected state or snapshot', async () => {
    const session = 'vibeterm-cancel-attach';
    const snapshots: StateSnapshotPayload[] = [];
    const sourceReady: Uint8Array[] = [];
    let parkStarted = false;
    let spawnCount = 0;
    let releasePark: (() => void) | undefined;
    const parkGate = new Promise<void>((resolve) => {
      releasePark = resolve;
    });
    const stubRun = createRunStub(session);
    const fake = createFakeControlProcess();

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSourceReady: (epoch) => {
          sourceReady.push(epoch);
        },
        onSnapshot: (payload) => snapshots.push(payload),
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command === `new-window -t ${session} -n vibeterm-park -P -F #{window_id} sleep 30`) {
            parkStarted = true;
            await parkGate;
          }
          return stubRun(argv);
        },
        spawnControlClient: () => {
          spawnCount += 1;
          fake.pushStdout(`%begin 1 1 0\n%end 1 1 0\n%session-changed $1 ${session}\n`);
          return fake.proc;
        },
      }
    );

    const connectPromise = connection.connect();
    await waitFor(() => (parkStarted ? true : null));
    expect(sourceReady).toHaveLength(1);
    connection.disconnect();
    releasePark?.();
    await connectPromise;

    expect((connection as any).connected).toBe(false);
    expect(snapshots).toEqual([]);
    expect(spawnCount).toBe(0);
    expect(fake.killed()).toBe(false);
  });

  test('disconnect during blocked snapshot commands does not publish snapshot', async () => {
    const session = 'vibeterm-cancel-snapshot';
    const snapshots: StateSnapshotPayload[] = [];
    let snapshotStarted = false;
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const stubRun = createRunStub(session);
    const fake = createFakeControlProcess();

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: (payload) => snapshots.push(payload),
        onError: () => {},
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: async (argv) => {
          const command = argv.slice(1).join(' ');
          if (command.startsWith(`list-panes -s -t ${session}`)) {
            snapshotStarted = true;
            await snapshotGate;
          }
          return stubRun(argv);
        },
        spawnControlClient: () => {
          fake.pushStdout(`%begin 1 1 0\n%end 1 1 0\n%session-changed $1 ${session}\n`);
          return fake.proc;
        },
      }
    );

    const connectPromise = connection.connect();
    await waitFor(() => (snapshotStarted ? true : null));
    expect((connection as any).connected).toBe(true);
    connection.disconnect();
    releaseSnapshot?.();
    await connectPromise;

    expect((connection as any).connected).toBe(false);
    expect(snapshots).toEqual([]);
    expect((connection as any).snapshotSession).toBeNull();
    expect((connection as any).snapshotWindows.size).toBe(0);
  });
});

describe('控制模式下的输入流水线', () => {
  async function connectControlMode(session: string) {
    const fake = createFakeControlProcess();
    const errors: Error[] = [];
    const fakes: FakeControlProcess[] = [];
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {},
      },
      {
        enableSubscription: true,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session),
        spawnControlClient: () => {
          const current = fakes.length === 0 ? fake : createFakeControlProcess();
          fakes.push(current);
          current.pushStdout(`%begin 1 1 0\n%end 1 1 0\n%session-changed $1 ${session}\n`);
          return current.proc;
        },
      }
    );
    await connection.connect();

    let blockId = 1000;
    const sendKeys = () => fake.writtenData.filter((line) => line.startsWith('send-keys '));
    const answer = (count: number, kind: 'end' | 'error' = 'end') => {
      for (let i = 0; i < count; i += 1) {
        const id = blockId++;
        const flag = kind === 'error' ? 1 : 0;
        fake.pushStdout(
          kind === 'error'
            ? `%begin 1 ${id} ${flag}\nno such pane\n%error 1 ${id} ${flag}\n`
            : `%begin 1 ${id} ${flag}\n%end 1 ${id} ${flag}\n`
        );
      }
    };
    const internals = connection as unknown as {
      controlCommands: ControlModeCommandQueue;
      inputCommands: InputCommandWindow;
      controlProcess: ControlClientProcess | null;
      spawnControlClientProcess(onReady: () => void): ControlClientProcess;
      handleControlClientExit(proc: ControlClientProcess, exitCode: number): void;
    };
    return { connection, fake, fakes, internals, errors, sendKeys, answer };
  }

  test('32 KiB 粘贴最多四条 send-keys 在途，每个回执释放一个槽位', async () => {
    const harness = await connectControlMode('vibeterm-paste');
    const before = harness.sendKeys().length;

    const paste = harness.connection.sendInput('%1', 'x'.repeat(32 * 1024));
    const expected = (32 * 1024) / 256;
    expect(harness.sendKeys().length - before).toBe(4);
    for (let replied = 1; replied <= expected; replied += 1) {
      harness.answer(1);
      await Bun.sleep(0);
      expect(harness.sendKeys().length - before).toBe(Math.min(expected, replied + 4));
    }
    await paste;
    expect(harness.errors).toEqual([]);
    harness.connection.disconnect();
  });

  test('粘贴与按键交错时保持写入顺序', async () => {
    const harness = await connectControlMode('vibeterm-paste-order');
    const before = harness.sendKeys().length;
    const hexOf = () => harness.sendKeys().map((line) => line.trim().split(' ').slice(4).join(''));

    const first = harness.connection.sendInput('%1', 'A');
    const paste = harness.connection.sendInput('%1', 'BC'.repeat(300));
    const last = harness.connection.sendInput('%1', 'Z');

    expect(harness.sendKeys().length - before).toBe(4);
    harness.answer(1);
    await first;
    expect(harness.sendKeys().length - before).toBe(5);
    harness.answer(4);
    await Promise.all([paste, last]);

    const written = hexOf().slice(before);
    const bytes = Buffer.from(written.join(''), 'hex').toString();
    expect(bytes).toBe(`A${'BC'.repeat(300)}Z`);
    expect(harness.errors).toEqual([]);
    harness.connection.disconnect();
  });

  test('中间一块失败时整段粘贴报错', async () => {
    const harness = await connectControlMode('vibeterm-paste-fail');
    const before = harness.sendKeys().length;

    const paste = harness.connection.sendInput('%1', 'y'.repeat(768));
    await waitFor(() => (harness.sendKeys().length - before === 3 ? true : null));

    harness.answer(1);
    harness.answer(1, 'error');
    harness.answer(1);

    await expect(paste).rejects.toThrow(/no such pane/);
    expect(harness.errors.map((error) => error.message)).toContain('no such pane');
    harness.connection.disconnect();
  });
  test('六个按键只写四条，每个回执按 FIFO 补一条', async () => {
    const h = await connectControlMode('vibeterm-window-six');
    try {
      const inputs = [...'ABCDEF'].map((key) => h.connection.sendInput('%1', key));
      expect(h.sendKeys().map((line) => line.trim().split(' ').at(-1))).toEqual([
        '41',
        '42',
        '43',
        '44',
      ]);
      for (let i = 1; i <= 6; i += 1) {
        h.answer(1);
        await Bun.sleep(0);
        expect(h.sendKeys()).toHaveLength(Math.min(6, i + 4));
        expect(h.sendKeys().length - i).toBeLessThanOrEqual(4);
      }
      await Promise.all(inputs);
      expect(h.sendKeys().map((line) => line.trim().split(' ').at(-1))).toEqual([
        '41',
        '42',
        '43',
        '44',
        '45',
        '46',
      ]);
    } finally {
      h.connection.disconnect();
    }
  });

  test('超过四块的粘贴、另一 pane 的按键及粘贴保持完整字节顺序和超时', async () => {
    const h = await connectControlMode('vibeterm-window-panes');
    const execute = spyOn(h.internals.controlCommands, 'execute');
    try {
      const a = Uint8Array.from({ length: 1300 }, (_, i) => i % 256);
      const c = Uint8Array.from({ length: 600 }, (_, i) => 255 - (i % 256));
      const inputs = [
        h.connection.sendInputBytes('%1', a),
        h.connection.sendInput('%2', '中'),
        h.connection.sendInputBytes('%3', c),
      ];
      const expected: string[] = [];
      for (const [pane, bytes] of [
        ['%1', a],
        ['%2', new TextEncoder().encode('中')],
        ['%3', c],
      ] as const) {
        for (let offset = 0; offset < bytes.length; offset += 256) {
          const hex = [...bytes.slice(offset, offset + 256)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(' ');
          expected.push(`send-keys -H -t ${pane} ${hex}\n`);
        }
      }
      a.fill(0);
      c.fill(0);
      expect(h.sendKeys()).toEqual(expected.slice(0, 4));
      for (let replied = 1; replied <= expected.length; replied += 1) {
        h.answer(1);
        await Bun.sleep(0);
        expect(h.sendKeys()).toEqual(expected.slice(0, replied + 4));
      }
      await Promise.all(inputs);
      expect(execute.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
        ...Array(6).fill(PIPELINED_INPUT_TIMEOUT_MS),
        undefined,
        ...Array(3).fill(PIPELINED_INPUT_TIMEOUT_MS),
      ]);
    } finally {
      execute.mockRestore();
      h.connection.disconnect();
    }
  });

  test('普通 error 释放槽位，后续输入继续发送并分别完成', async () => {
    const h = await connectControlMode('vibeterm-window-error');
    try {
      const failed = h.connection.sendInput('%1', 'A');
      const later = [...'BCDEF'].map((key) => h.connection.sendInput('%2', key));
      h.answer(1, 'error');
      await expect(failed).rejects.toThrow('no such pane');
      expect(h.sendKeys()).toHaveLength(5);
      h.answer(1);
      await Bun.sleep(0);
      expect(h.sendKeys()).toHaveLength(6);
      h.answer(4);
      await Promise.all(later);
      expect(h.errors.map((error) => error.message)).toEqual(['no such pane']);
    } finally {
      h.connection.disconnect();
    }
  });

  test('disconnect 拒绝在途和待发输入、清除定时器，connect 后不重放', async () => {
    const h = await connectControlMode('vibeterm-window-disconnect');
    const inputs = [...'ABCDEF'].map((key) => h.connection.sendInput('%1', key));
    const timers = (
      h.internals.controlCommands as unknown as {
        pending: { timer: ReturnType<typeof setTimeout> }[];
      }
    ).pending.map((pending) => pending.timer);
    const cleared = spyOn(globalThis, 'clearTimeout');
    try {
      h.connection.disconnect();
      const results = await Promise.allSettled(inputs);
      expect(results.map((result) => result.status)).toEqual(Array(6).fill('rejected'));
      expect(timers).toHaveLength(4);
      for (const timer of timers) expect(cleared).toHaveBeenCalledWith(timer);
      expect(h.fake.killed()).toBe(true);
      await h.connection.connect();
      const current = h.fakes[1];
      expect(current.writtenData.filter((line) => line.startsWith('send-keys'))).toEqual([]);
      const fresh = h.connection.sendInput('%1', 'Z');
      current.pushStdout('%begin 1 1000 0\n%end 1 1000 0\n');
      await fresh;
      expect(h.sendKeys()).toHaveLength(4);
    } finally {
      cleared.mockRestore();
      h.connection.disconnect();
    }
  });

  test('控制进程退出立即取消输入，重连期间拒绝输入，重挂后启用新窗口', async () => {
    const h = await connectControlMode('vibeterm-window-exit');
    try {
      const oldQueue = h.internals.controlCommands;
      const inputs = [...'ABCDEF'].map((key) => h.connection.sendInput('%1', key));
      h.fake.exit(1);
      const results = await Promise.allSettled(inputs);
      expect(results.map((result) => result.status)).toEqual(Array(6).fill('rejected'));
      expect(h.internals.controlProcess).toBeNull();
      await expect(h.connection.sendInput('%1', 'G')).rejects.toThrow('exited');
      const unexpectedWrites: string[] = [];
      await expect(
        oldQueue.execute(
          (line) => {
            unexpectedWrites.push(line);
          },
          'stale',
          {
            transform: () => {},
          }
        )
      ).rejects.toThrow('closed');
      expect(unexpectedWrites).toEqual([]);
      await waitFor(() => h.fakes[1] ?? null);
      await Bun.sleep(0);
      const fresh = h.connection.sendInput('%2', 'Z');
      h.fakes[1].pushStdout('%begin 1 1000 0\n%end 1 1000 0\n');
      await fresh;
      expect(h.fakes[1].writtenData.filter((line) => line.startsWith('send-keys'))).toEqual([
        'send-keys -H -t %2 5a\n',
      ]);
      expect(h.sendKeys()).toHaveLength(4);
    } finally {
      h.connection.disconnect();
    }
  });

  test('替换控制进程取消整代输入，旧完成和 poison 回调不影响新窗口', async () => {
    const h = await connectControlMode('vibeterm-window-replace');
    try {
      const oldQueue = h.internals.controlCommands;
      const oldWindow = h.internals.inputCommands;
      const inputs = [...'ABCDEF'].map((key) => h.connection.sendInput('%1', key));
      h.answer(1);
      h.internals.spawnControlClientProcess(() => {});
      const results = await Promise.allSettled(inputs);
      expect(results.map((result) => result.status)).toEqual(Array(6).fill('rejected'));
      expect(oldWindow.disposed).toBe(true);
      await Bun.sleep(0);
      const current = h.fakes[1];
      const fresh = [...'GHIJK'].map((key) => h.connection.sendInput('%2', key));
      const currentWrites = () =>
        current.writtenData.filter((line) => line.startsWith('send-keys'));
      expect(currentWrites()).toHaveLength(4);
      (oldQueue as unknown as { onPoison(): void }).onPoison();
      h.internals.handleControlClientExit(h.fake.proc, 1);
      await Bun.sleep(0);
      expect(h.internals.inputCommands.disposed).toBe(false);
      expect(current.killed()).toBe(false);
      expect(currentWrites()).toHaveLength(4);
      for (let id = 1000; id < 1005; id += 1) {
        current.pushStdout(`%begin 1 ${id} 0\n%end 1 ${id} 0\n`);
        await Bun.sleep(0);
      }
      await Promise.all(fresh);
      expect(currentWrites().at(-1)).toBe('send-keys -H -t %2 4b\n');
      expect(h.sendKeys()).toHaveLength(4);
    } finally {
      h.connection.disconnect();
      h.fake.proc.kill();
    }
  });

  test('stdin 写失败关闭该代队列和窗口，不再写出待发分块', async () => {
    const h = await connectControlMode('vibeterm-window-write-fail');
    const write = spyOn(h.fake.proc, 'write');
    try {
      const first = h.connection.sendInput('%1', 'A');
      write.mockImplementation(() => {
        throw new Error('stdin failed');
      });
      const paste = h.connection.sendInput('%1', 'B'.repeat(1536));
      const results = await Promise.allSettled([first, paste]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(h.fake.killed()).toBe(true);
      expect(h.internals.inputCommands.disposed).toBe(true);
      expect(write).toHaveBeenCalledTimes(2);
      expect(h.sendKeys()).toEqual(['send-keys -H -t %1 41\n']);
    } finally {
      write.mockRestore();
      h.connection.disconnect();
    }
  });

  test('控制客户端创建失败后的 spawn 回退仍然只有一个槽位', async () => {
    const h = await connectControlMode('vibeterm-window-spawn-retry');
    const deps = (
      h.connection as unknown as {
        deps: {
          spawnControlClient(argv: string[]): ControlClientProcess;
          run(argv: string[]): Promise<CommandResult>;
        };
      }
    ).deps;
    const spawn = spyOn(deps, 'spawnControlClient').mockImplementation(() => {
      throw new Error('control spawn failed');
    });
    const replies: ReturnType<typeof Promise.withResolvers<CommandResult>>[] = [];
    const run = spyOn(deps, 'run').mockImplementation(() => {
      const reply = Promise.withResolvers<CommandResult>();
      replies.push(reply);
      return reply.promise;
    });
    try {
      h.internals.handleControlClientExit(h.fake.proc, 1);
      expect(() => h.internals.spawnControlClientProcess(() => {})).toThrow('control spawn failed');
      const inputs = [...'ABCDEF'].map((key) => h.connection.sendInput('%1', key));
      expect(run).toHaveBeenCalledTimes(1);
      for (let i = 0; i < inputs.length; i += 1) {
        replies[i].resolve(ok());
        await inputs[i];
        expect(run).toHaveBeenCalledTimes(Math.min(6, i + 2));
      }
    } finally {
      spawn.mockRestore();
      run.mockRestore();
      h.connection.disconnect();
      h.fake.proc.kill();
    }
  });

  test('pacer 在普通输入前排空的鼠标命令全部保持领先', async () => {
    const h = await connectControlMode('vibeterm-window-pacer');
    const completions: Promise<void>[] = [];
    const pacer = new PaneInputPacer((pane, bytes) => {
      const completion = h.connection.sendInputBytes(pane, bytes);
      completions.push(completion);
      return completion;
    });
    try {
      const mouse = '\x1b[<64;1;1M';
      pacer.sendInputBytes('%1', new TextEncoder().encode(mouse.repeat(7)));
      pacer.sendInputBytes('%1', new TextEncoder().encode('Z'));
      expect(h.sendKeys()).toHaveLength(4);
      for (let i = 0; i < 8; i += 1) {
        h.answer(1);
        await Bun.sleep(0);
      }
      await Promise.all(completions);
      const bytes = h
        .sendKeys()
        .map((line) => line.trim().split(' ').slice(4).join(''))
        .join('');
      expect(Buffer.from(bytes, 'hex').toString()).toBe(`${mouse.repeat(7)}Z`);
    } finally {
      pacer.dispose();
      h.connection.disconnect();
    }
  });
});

describe('无控制进程时的输入窗口', () => {
  async function connectSpawnOnly() {
    const commands: string[][] = [];
    const replies: ReturnType<typeof Promise.withResolvers<CommandResult>>[] = [];
    const errors: Error[] = [];
    const run = createRunStub('vibeterm-window-spawn');
    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {},
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('vibeterm-window-spawn'),
        run: (argv) => {
          if (argv[1] !== 'send-keys') return run(argv);
          commands.push(argv.slice(1));
          const reply = Promise.withResolvers<CommandResult>();
          replies.push(reply);
          return reply.promise;
        },
      }
    );
    await connection.connect();
    return { connection, commands, replies, errors };
  }

  test('多分块和跨 payload 的 spawn 始终逐条串行，错误向调用方传播', async () => {
    const h = await connectSpawnOnly();
    try {
      const paste = h.connection.sendInput('%1', 'A'.repeat(600));
      const key = h.connection.sendInput('%2', 'B');
      const last = h.connection.sendInput('%3', 'C'.repeat(300));
      expect(h.commands).toHaveLength(1);
      h.replies[0].reject(new Error('spawn failed'));
      await expect(paste).rejects.toThrow('spawn failed');
      expect(h.commands).toHaveLength(2);
      for (let i = 1; i < 6; i += 1) {
        expect(h.commands).toHaveLength(i + 1);
        h.replies[i].resolve(ok());
        await Bun.sleep(0);
        expect(h.commands).toHaveLength(Math.min(6, i + 2));
      }
      await Promise.all([key, last]);
      expect(h.commands.map((argv) => argv[3])).toEqual(['%1', '%1', '%1', '%2', '%3', '%3']);
      const hex = h.commands.map((argv) => argv.slice(4).join('')).join('');
      expect(Buffer.from(hex, 'hex').toString()).toBe(`${'A'.repeat(600)}B${'C'.repeat(300)}`);
      expect(h.errors.map((error) => error.message)).toEqual(['spawn failed']);
    } finally {
      h.connection.disconnect();
    }
  });

  test('断开时取消未启动的 spawn，旧进程迟到完成不能驱动新窗口', async () => {
    const h = await connectSpawnOnly();
    try {
      const old = h.connection.sendInput('%1', 'A');
      const pending = h.connection.sendInput('%1', 'B');
      h.connection.disconnect();
      await expect(pending).rejects.toThrow('disconnected');
      await h.connection.connect();
      const fresh = h.connection.sendInput('%2', 'C');
      const bytes = new Uint8Array([0, 0x80, 0xff]);
      const next = h.connection.sendInputBytes('%2', bytes);
      bytes.fill(0x41);
      expect(h.commands).toHaveLength(2);
      h.replies[0].resolve(ok());
      await old;
      expect(h.commands).toHaveLength(2);
      h.replies[1].resolve(ok());
      await fresh;
      expect(h.commands).toHaveLength(3);
      expect(h.commands[2]).toEqual(['send-keys', '-H', '-t', '%2', '00', '80', 'ff']);
      h.replies[2].resolve(ok());
      await next;
    } finally {
      h.connection.disconnect();
    }
  });
});
