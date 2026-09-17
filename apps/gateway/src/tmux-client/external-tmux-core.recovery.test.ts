import { beforeAll, describe, expect, test } from 'bun:test';
import type { Device, EventDevicePayload } from '@vibeterm/shared';

import { createDevice, getDeviceRuntimeStatus, updateDeviceRuntimeStatus } from '../db';
import { runMigrations } from '../db/migrate';
import { connectionAlertNotifier } from '../push/connection-alerts';
import type { HostShellResult } from '../window-memory/types';
import type { TmuxConnectionOptions } from './connection-types';
import { ExternalTmuxConnectionCore } from './external-tmux-core';
import type { CommandResult, ExternalControlHandle } from './external/types';

const SOCKET_MISSING = 'error connecting to /tmp/tmux-1000/default (No such file or directory)';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr };
}

class RecoveryStubCore extends ExternalTmuxConnectionCore {
  protected readonly logPrefix = '[stub]';
  protected readonly stalledControlLabel = 'process';
  readonly commands: string[][] = [];
  readonly scripts: string[] = [];
  readonly reported: string[] = [];
  readonly errors: unknown[] = [];
  controlAlive = true;
  shellExitCode = 0;
  commandImpl: (argv: string[], attempt: number) => CommandResult = () => ok();

  constructor(deviceId: string) {
    super(
      {
        deviceId,
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: (error) => {
          this.errors.push(error);
        },
        onClose: () => {},
      } satisfies TmuxConnectionOptions,
      () => null
    );
    this.connected = true;
  }

  sendInput(): void {}

  exposeEnsureSession(): Promise<{ created: boolean }> {
    return this.ensureSession();
  }

  override async runHostShell(script: string): Promise<HostShellResult> {
    this.scripts.push(script);
    return { stdout: '', stderr: '', exitCode: this.shellExitCode };
  }

  protected resolveDefaultWorkingDir(): string {
    return '/tmp';
  }

  protected async runTmuxAllowFailure(argv: string[]): Promise<CommandResult> {
    this.commands.push(argv);
    const key = argv.join(' ');
    const attempt = this.commands.filter((entry) => entry.join(' ') === key).length;
    return this.commandImpl(argv, attempt);
  }

  protected getParkingCommand(): string {
    return 'sleep 30';
  }

  protected async shouldInstallGhosttyTerminfo(): Promise<boolean> {
    return false;
  }

  protected async attachControlTransport(): Promise<ExternalControlHandle> {
    return { write: () => {} };
  }

  protected isAttachedControlTransport(): boolean {
    return true;
  }

  // 控制模式 client 已挂上：socket 路径不可达也照常收发，pid 只能从这里问。
  protected getControlWriter(): ((data: string) => void) | null {
    if (!this.controlAlive) return null;
    return () => {
      this.controlCommands.handleBlock({ args: '', isError: false, lines: ['2064'] });
    };
  }

  protected detachControlTransport(): () => void {
    return () => {};
  }

  protected killControlTransport(): void {}

  protected controlAttachFailureMessage(): string {
    return 'attach failed';
  }

  protected reportTmuxCommandFailure(message: string): void {
    this.reported.push(message);
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      lastError: message,
      lastErrorType: 'unknown',
    });
  }

  protected async runHistoryQuery(): Promise<CommandResult> {
    return ok();
  }

  protected async runHistoryCapture(): Promise<string> {
    return '';
  }
}

function seedDevice(id: string): Device {
  const now = new Date().toISOString();
  const device: Device = {
    id,
    name: id,
    type: 'local',
    session: 'vibeterm',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
  createDevice(device);
  return device;
}

async function withCapturedBroadcasts<T>(
  run: (events: EventDevicePayload[]) => Promise<T>
): Promise<T> {
  const events: EventDevicePayload[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  connectionAlertNotifier.setBroadcaster((_deviceId, payload) => {
    events.push(payload);
  });
  try {
    return await run(events);
  } finally {
    connectionAlertNotifier.setBroadcaster(null);
    console.warn = originalWarn;
  }
}

beforeAll(() => {
  runMigrations();
});

describe('ExternalTmuxConnectionCore socket recovery', () => {
  test('socket 不可达：控制通道取 pid、补目录发 SIGUSR1、重试成功且不发告警', async () => {
    const device = seedDevice('r57-recover-ok');
    const core = new RecoveryStubCore(device.id);
    core.commandImpl = (argv, attempt) => {
      const key = argv.join(' ');
      if (key === 'has-session -t vibeterm') return fail(SOCKET_MISSING);
      if (key.startsWith('new-session')) return attempt === 1 ? fail(SOCKET_MISSING) : ok('');
      return ok('2064');
    };

    const result = await withCapturedBroadcasts(async (events) => {
      const created = await core.exposeEnsureSession();
      expect(events).toEqual([]);
      return created;
    });

    expect(result).toEqual({ created: true });
    expect(core.scripts).toEqual(["mkdir -p -m 700 '/tmp/tmux-1000' && kill -USR1 2064"]);
    expect(core.reported).toEqual([]);
    expect(core.commands.map((argv) => argv.join(' '))).toContain('display-message -p #{pid}');
  });

  test('没有控制通道时不尝试恢复，失败按原路径上报一次', async () => {
    const device = seedDevice('r57-recover-no-control');
    const core = new RecoveryStubCore(device.id);
    core.controlAlive = false;
    core.commandImpl = (argv) =>
      argv.join(' ') === 'has-session -t vibeterm' ? fail(SOCKET_MISSING) : fail(SOCKET_MISSING);

    await withCapturedBroadcasts(async () => {
      await expect(core.exposeEnsureSession()).rejects.toThrow(SOCKET_MISSING);
    });

    expect(core.scripts).toEqual([]);
    expect(core.reported).toEqual([SOCKET_MISSING]);
  });

  test('命令重新成功后清掉滞留错误并广播 reconnected', async () => {
    const device = seedDevice('r57-clear-on-success');
    const core = new RecoveryStubCore(device.id);
    core.commandImpl = (argv) =>
      argv.join(' ') === 'has-session -t vibeterm' ? fail('boom') : fail('boom');

    const events = await withCapturedBroadcasts(async (captured) => {
      await expect(core.exposeEnsureSession()).rejects.toThrow('boom');
      expect(core.reported).toEqual(['boom']);
      expect(getDeviceRuntimeStatus(device.id).lastError).toBe('boom');

      core.commandImpl = () => ok();
      await core.exposeEnsureSession();
      return captured;
    });

    const status = getDeviceRuntimeStatus(device.id);
    expect(status.lastError).toBeNull();
    expect(status.lastErrorType).toBeNull();
    expect(status.tmuxAvailable).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['reconnected']);
    expect(events[0]?.deviceId).toBe(device.id);
  });
});
