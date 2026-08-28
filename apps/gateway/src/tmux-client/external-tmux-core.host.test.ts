import { beforeAll, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';

import { runMigrations } from '../db/migrate';
import type { TmuxConnectionOptions } from './connection-types';
import { ExternalTmuxConnectionCore } from './external-tmux-core';
import type { CommandResult, ExternalControlHandle } from './external/types';

class StubExternalCore extends ExternalTmuxConnectionCore {
  protected readonly logPrefix = '[stub]';
  protected readonly stalledControlLabel = 'process';
  readonly allowFailureCalls: string[][] = [];
  readonly inputs: Array<{ paneId: string; data: string }> = [];
  readonly disposed: string[] = [];
  commandImpl: ((argv: string[]) => Promise<CommandResult>) | null = null;

  constructor(callbacks: Partial<TmuxConnectionOptions> = {}) {
    super(
      {
        deviceId: 'dev-1',
        onEvent: () => {},
        onTerminalOutput: () => {},
        onTerminalHistory: () => {},
        onSnapshot: () => {},
        onError: () => {},
        onClose: () => {},
        ...callbacks,
      },
      () => null
    );
  }

  sendInput(paneId: string, data: string): void {
    this.inputs.push({ paneId, data });
  }

  markConnected(): void {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isCloseNotified(): boolean {
    return this.closeNotified;
  }

  async exposeShutdown(notifyClose: boolean): Promise<void> {
    await this.shutdownInternal(notifyClose);
  }

  beginAttempt(): number {
    return this.beginConnectGeneration();
  }

  invalidateAttempt(): void {
    this.invalidateConnectGeneration();
    this.manualDisconnect = true;
  }

  abandon(generation: number): boolean {
    return this.abandonStaleConnect(generation);
  }

  protected resolveDefaultWorkingDir(): string {
    return '/tmp';
  }

  protected async runTmuxAllowFailure(argv: string[]): Promise<CommandResult> {
    this.allowFailureCalls.push(argv);
    if (this.commandImpl) {
      return this.commandImpl(argv);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async exposeConnect(run: (generation: number) => Promise<void>): Promise<void> {
    await this.runConnectAttempt(run);
  }

  async exposeFinalize(generation: number): Promise<void> {
    await this.finalizeConnect(generation, false, false);
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

  protected getControlWriter(): ((data: string) => void) | null {
    return null;
  }

  protected detachControlTransport(): () => void {
    return () => {
      this.disposed.push('detach');
    };
  }

  protected killControlTransport(): void {
    this.disposed.push('kill');
  }

  protected controlAttachFailureMessage(): string {
    return 'attach failed';
  }

  protected reportTmuxCommandFailure(): void {}

  protected async runHistoryQuery(): Promise<CommandResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  protected async runHistoryCapture(): Promise<string> {
    return '';
  }

  protected async disposeTransport(): Promise<void> {
    this.disposed.push('dispose');
  }
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

describe('ExternalTmuxConnectionCore collaborator host', () => {
  test('bound host writes cleanup fields back onto the core', async () => {
    const closed: number[] = [];
    const core = new StubExternalCore({
      onClose: () => {
        closed.push(1);
      },
    });
    core.markConnected();
    expect(core.isConnected()).toBe(true);

    await core.exposeShutdown(true);

    expect(core.isConnected()).toBe(false);
    expect(core.isCloseNotified()).toBe(true);
    expect(closed).toEqual([1]);
    expect(core.disposed).toContain('dispose');
  });

  test('stale connect generation releases resources and does not stay connected', () => {
    const core = new StubExternalCore();
    const generation = core.beginAttempt();
    core.markConnected();
    core.invalidateAttempt();

    expect(core.abandon(generation)).toBe(true);
    expect(core.isConnected()).toBe(false);
    expect(core.disposed).toContain('detach');
    expect(core.disposed).toContain('dispose');
  });

  test('current connect generation is not abandoned', () => {
    const core = new StubExternalCore();
    const generation = core.beginAttempt();
    core.markConnected();

    expect(core.abandon(generation)).toBe(false);
    expect(core.isConnected()).toBe(true);
    expect(core.disposed).toEqual([]);
  });

  test('session commands reach runTmuxAllowFailure through the bound host', async () => {
    const core = new StubExternalCore();
    core.markConnected();
    core.resizePane('%1', 80, 24);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core.allowFailureCalls.length).toBeGreaterThan(0);
  });

  test('disconnect during blocked connect snapshot does not emit snapshot', async () => {
    const snapshots: StateSnapshotPayload[] = [];
    const core = new StubExternalCore({
      onSnapshot: (payload) => snapshots.push(payload),
    });
    let snapshotStarted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    core.commandImpl = async (argv) => {
      if (argv[0] === 'show-options') {
        return { exitCode: 0, stdout: '00112233445566778899aabbccddeeff\n', stderr: '' };
      }
      if (argv[0] === 'display-message') {
        return { exitCode: 0, stdout: '$1|tmex\n', stderr: '' };
      }
      if (argv[0] === 'list-windows' && argv.at(-1) !== '#{window_id}') {
        return { exitCode: 0, stdout: '@1|0|1|ba9d,80x24,0,0,1|main\n', stderr: '' };
      }
      if (argv[0] === 'list-panes') {
        snapshotStarted = true;
        await gate;
        return {
          exitCode: 0,
          stdout: '%1|@1|0|1|80|24|0|0|1|bash|node|/home/user\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const done = core.exposeConnect(async (generation) => {
      await core.exposeFinalize(generation);
    });
    await waitFor(() => (snapshotStarted ? true : null));
    core.invalidateAttempt();
    release?.();
    await done;

    expect(snapshots).toEqual([]);
    expect(core.isConnected()).toBe(false);
  });
});
