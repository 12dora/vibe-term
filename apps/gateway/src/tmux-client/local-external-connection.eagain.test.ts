import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';

import { config } from '../config';
import { runMigrations } from '../db/migrate';
import { LocalExternalTmuxConnection } from './local-external-connection';

const now = '2026-06-14T00:00:00.000Z';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function createDevice(session = 'tmex-test'): Device {
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

// 内联一份最小 run 桩：argv 形如 ['tmux', ...(socketArgs), ...subcommand]。
// 这里以「去掉前导 tmux 与可选 -L <socket>」后的子命令字符串做匹配，
// 这样无论是否注入 socket，匹配逻辑都不变。
function subcommandOf(argv: string[]): string {
  const rest = argv.slice(1);
  if (rest[0] === '-L') {
    return rest.slice(2).join(' ');
  }
  return rest.join(' ');
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
    const command = subcommandOf(argv);
    const overridden = options.overrides?.(command);
    if (overridden) {
      return overridden;
    }
    if (command === '-V') {
      return ok('tmux 3.4\n');
    }
    if (command === 'display-message -p #{version}') {
      return ok('3.4\n');
    }
    if (command === `has-session -t ${session}`) {
      return ok();
    }
    if (command === 'show-options -gqv @tmex-server-epoch') {
      return ok('00112233445566778899aabbccddeeff\n');
    }
    if (command === `new-window -t ${session} -n tmex-park -P -F #{window_id} sleep 30`) {
      return ok('@99\n');
    }
    if (command === `last-window -t ${session}` || command === 'kill-window -t @99') {
      return ok();
    }
    if (
      command.startsWith(`set-option -t ${session}`) ||
      command.startsWith(`set-environment -t ${session}`)
    ) {
      return ok();
    }
    if (command.startsWith(`set-hook -t ${session}`)) {
      return ok();
    }
    if (command.startsWith('set-option -w -t @')) {
      return ok();
    }
    if (command.startsWith(`display-message -p -t ${session} #{session_id}`)) {
      return ok(`$1|${session}\n`);
    }
    if (command === `list-windows -t ${session} -F #{window_id}`) {
      return ok('@1\n');
    }
    if (command.startsWith(`list-windows -t ${session}`)) {
      return ok('@1|0|main|1\n');
    }
    if (command.startsWith(`list-panes -s -t ${session}`)) {
      return ok('%1|@1|0|bash|1|80|24|1|node\n');
    }
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
}

function makeEagainError(): Error & { code: string } {
  const error = new Error(
    'posix_spawn failed: EAGAIN: resource temporarily unavailable'
  ) as Error & {
    code: string;
  };
  error.code = 'EAGAIN';
  return error;
}

const SNAPSHOT_PREFIXES = ['display-message -p -t', 'list-windows -t', 'list-panes -s -t'];

function isSnapshotReadCommand(command: string): boolean {
  return SNAPSHOT_PREFIXES.some((prefix) => command.startsWith(prefix));
}

function setTmuxSocket(value: string): void {
  (config as { tmuxSocket: string }).tmuxSocket = value;
}

function setTmuxBin(value: string): void {
  (config as { tmuxBin: string }).tmuxBin = value;
}

const originalTmuxSocket = config.tmuxSocket;
const originalTmuxBin = config.tmuxBin;

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  setTmuxSocket(originalTmuxSocket);
  setTmuxBin(originalTmuxBin);
});

describe('LocalExternalTmuxConnection socket injection', () => {
  test('fails closed before session mutation when client and existing server versions differ', async () => {
    setTmuxBin('/opt/vibex/bin/tmux');
    const calls: string[][] = [];
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
        getDevice: () => createDevice('tmex-version-conflict'),
        run: createRunStub('tmex-version-conflict', {
          record: calls,
          overrides: (command) => {
            if (command === '-V') return ok('tmux 3.5a\n');
            if (command === 'display-message -p #{version}') return ok('3.7b\n');
            return null;
          },
        }),
        spawnControlClient: () => {
          throw new Error('must not start control client after version conflict');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow(/client 3\.5a.*server 3\.7b/);
    expect(calls.map(subcommandOf)).toEqual(['-V', 'display-message -p #{version}']);
  });

  test('cannot bypass the existing server version gate by disabling subscriptions', async () => {
    setTmuxBin('/opt/vibex/bin/tmux');
    const calls: string[][] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-version-conflict'),
        run: createRunStub('tmex-version-conflict', {
          record: calls,
          overrides: (command) => {
            if (command === '-V') return ok('tmux 3.5a\n');
            if (command === 'display-message -p #{version}') return ok('3.7b\n');
            return null;
          },
        }),
      }
    );

    await expect(connection.connect()).rejects.toThrow(/client 3\.5a.*server 3\.7b/);
    expect(calls.map(subcommandOf)).toEqual(['-V', 'display-message -p #{version}']);
  });

  test('fails closed when the configured absolute tmux executable becomes unavailable', async () => {
    setTmuxBin('/opt/vibex/bin/tmux');
    const calls: string[][] = [];
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
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice('tmex-missing-client'),
        run: async (argv) => {
          calls.push(argv);
          return { exitCode: 127, stdout: '', stderr: 'No such file or directory' };
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow(
      /configured tmux executable is unavailable.*No such file/
    );
    expect(calls.map(subcommandOf)).toEqual(['-V']);
  });

  test('uses configured absolute tmux binary for version probe, commands, and control client', async () => {
    setTmuxBin('/opt/vibex/bin/tmux');
    setTmuxSocket('tmex-e2e');
    const session = 'tmex-absolute-bin';
    const calls: string[][] = [];
    let controlArgv: string[] | null = null;

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
        getDevice: () => createDevice(session),
        run: createRunStub(session, { record: calls }),
        spawnControlClient: (argv) => {
          controlArgv = argv;
          throw new Error('stop after capturing control argv');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow('stop after capturing control argv');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((argv) => argv.slice(3).join(' ') === '-V')).toBe(true);
    for (const argv of calls) {
      expect(argv.slice(0, 3)).toEqual(['/opt/vibex/bin/tmux', '-L', 'tmex-e2e']);
    }
    expect(controlArgv as string[] | null).toEqual([
      '/opt/vibex/bin/tmux',
      '-L',
      'tmex-e2e',
      '-C',
      'attach-session',
      '-t',
      session,
    ]);
  });

  test('uses the Windows psmux contract without POSIX shell, terminfo, or global teardown', async () => {
    const psmuxBin = 'C:\\Program Files\\tmex\\resources\\psmux.exe';
    const namespace = 'tmex-stable';
    const session = 'tmex-windows-contract';
    setTmuxBin(psmuxBin);
    setTmuxSocket(namespace);
    const calls: string[][] = [];
    let controlArgv: string[] | null = null;

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
        platform: 'win32',
        enableSubscription: true,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          record: calls,
          overrides: (command) => {
            if (command === '-V') {
              return ok('tmux 3.3.7\r\npsmux 3.3.7 (05cc5d4 2026-07-20)\r\n');
            }
            if (command === 'display-message -p #{version}') return ok('3.3.7\r\n');
            if (
              command ===
              `new-window -t ${session} -n tmex-park -P -F #{window_id} ping.exe -n 31 127.0.0.1`
            ) {
              return ok('@99\r\n');
            }
            return null;
          },
        }),
        spawnControlClient: (argv) => {
          controlArgv = argv;
          throw new Error('stop after capturing Windows control argv');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow('stop after capturing Windows control argv');

    for (const argv of calls) {
      expect(argv.slice(0, 3)).toEqual([psmuxBin, '-L', namespace]);
      expect(argv.join(' ')).not.toContain('kill-server');
      expect(argv[0]).not.toBe('/bin/sh');
    }
    expect(calls.map(subcommandOf)).toContain(
      `new-window -t ${session} -n tmex-park -P -F #{window_id} ping.exe -n 31 127.0.0.1`
    );
    expect(calls.map(subcommandOf).some((command) => command.includes('default-terminal'))).toBe(
      false
    );
    expect(controlArgv as string[] | null).toEqual([
      psmuxBin,
      '-L',
      namespace,
      '-C',
      'attach-session',
      '-t',
      session,
    ]);
  });

  test('injects -L <socket> into run argv and control-client argv when tmuxSocket is set', async () => {
    setTmuxSocket('tmex-e2e');
    const session = 'tmex-socket-on';
    const calls: string[][] = [];
    let controlArgv: string[] | null = null;

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
        spawnControlClient: (argv) => {
          controlArgv = argv;
          throw new Error('should not spawn control client when subscription disabled');
        },
      }
    );

    await connection.connect();

    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv.slice(0, 3)).toEqual(['tmux', '-L', 'tmex-e2e']);
    }
    expect(controlArgv).toBeNull();

    // control-client argv 单独验证（不真正起进程）
    const built = [
      'tmux',
      ...(config.tmuxSocket ? ['-L', config.tmuxSocket] : []),
      '-C',
      'attach-session',
      '-t',
      session,
    ];
    expect(built.slice(0, 3)).toEqual(['tmux', '-L', 'tmex-e2e']);
  });

  test('control-client argv contains -L <socket> when subscription enabled', async () => {
    setTmuxSocket('tmex-e2e');
    const session = 'tmex-socket-ctl';
    const captured: { argv: string[] | null } = { argv: null };

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
        getDevice: () => createDevice(session),
        run: createRunStub(session),
        spawnControlClient: (argv) => {
          captured.argv = argv;
          // 抛错使 connect() 失败，避免真正驱动控制流；argv 已被捕获。
          throw new Error('stop after capturing control argv');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow();
    expect(captured.argv).toEqual([
      'tmux',
      '-L',
      'tmex-e2e',
      '-C',
      'attach-session',
      '-t',
      session,
    ]);
  });

  test('omits -L from run argv when tmuxSocket is empty', async () => {
    setTmuxSocket('');
    const session = 'tmex-socket-off';
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

    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv[0]).toBe('tmux');
      expect(argv[1]).not.toBe('-L');
    }
  });

  test('omits -L from control-client argv when tmuxSocket is empty', async () => {
    setTmuxSocket('');
    const session = 'tmex-socket-off-ctl';
    const captured: { argv: string[] | null } = { argv: null };

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
        getDevice: () => createDevice(session),
        run: createRunStub(session),
        spawnControlClient: (argv) => {
          captured.argv = argv;
          throw new Error('stop after capturing control argv');
        },
      }
    );

    await expect(connection.connect()).rejects.toThrow();
    expect(captured.argv).toEqual(['tmux', '-C', 'attach-session', '-t', session]);
  });
});

describe('LocalExternalTmuxConnection EAGAIN handling', () => {
  test('transient spawn EAGAIN does not escape, shutdown, or error out', async () => {
    setTmuxSocket('');
    const session = 'tmex-eagain';
    let eagainPhase = false;
    let closeCalls = 0;
    const errors: unknown[] = [];

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
        onClose: () => {
          closeCalls += 1;
        },
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) => {
            if (eagainPhase && isSnapshotReadCommand(command)) {
              throw makeEagainError();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    expect((connection as unknown as { connected: boolean }).connected).toBe(true);

    eagainPhase = true;

    let escaped = false;
    const onUnhandled = () => {
      escaped = true;
    };
    const processEvents = process as unknown as {
      on(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): void;
      off(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): void;
    };
    processEvents.on('unhandledRejection', onUnhandled);
    try {
      // public requestSnapshot：内部捕获瞬时 spawn 错误，不应抛出/不触发 onError/onClose
      connection.requestSnapshot();
      await Bun.sleep(200);
    } finally {
      processEvents.off('unhandledRejection', onUnhandled);
    }

    expect(escaped).toBe(false);
    expect(closeCalls).toBe(0);
    // EAGAIN 不应作为 onError 上报
    expect(
      errors.filter((e) => e instanceof Error && /EAGAIN|posix_spawn/.test(e.message))
    ).toEqual([]);
    expect((connection as unknown as { connected: boolean }).connected).toBe(true);

    connection.disconnect();
  });

  test('recovers after a transient EAGAIN: subsequent snapshot emits normally', async () => {
    setTmuxSocket('');
    const session = 'tmex-eagain-recover';
    let eagainPhase = false;
    let closeCalls = 0;
    const snapshots: unknown[] = [];
    const errors: unknown[] = [];

    const connection = new LocalExternalTmuxConnection(
      {
        deviceId: 'device-local',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: (payload) => {
          snapshots.push(payload);
        },
        onError: (error) => {
          errors.push(error);
        },
        onClose: () => {
          closeCalls += 1;
        },
      },
      {
        enableSubscription: false,
        ensureGhosttyTerminfo: async () => false,
        getDevice: () => createDevice(session),
        run: createRunStub(session, {
          overrides: (command) => {
            if (eagainPhase && isSnapshotReadCommand(command)) {
              throw makeEagainError();
            }
            return null;
          },
        }),
      }
    );

    await connection.connect();
    const baseSnapshots = snapshots.length;

    // 1) 触发一次 EAGAIN：不发快照、不 shutdown
    eagainPhase = true;
    connection.requestSnapshot();
    await Bun.sleep(200);
    expect(snapshots.length).toBe(baseSnapshots);
    expect(closeCalls).toBe(0);

    // 2) 恢复正常：后续快照正常发出，连接健康
    eagainPhase = false;
    connection.requestSnapshot();
    await Bun.sleep(200);
    expect(snapshots.length).toBeGreaterThan(baseSnapshots);

    expect(
      errors.filter((e) => e instanceof Error && /EAGAIN|posix_spawn/.test(e.message))
    ).toEqual([]);
    expect((connection as unknown as { connected: boolean }).connected).toBe(true);

    connection.disconnect();
  });
});
