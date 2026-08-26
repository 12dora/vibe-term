import { describe, expect, test } from 'bun:test';
import type { TmuxConnectionOptions } from './connection-types';
import { ExternalTmuxConnectionCore } from './external-tmux-core';
import type { CommandResult, ExternalControlHandle } from './external/types';

class StubExternalCore extends ExternalTmuxConnectionCore {
  protected readonly logPrefix = '[stub]';
  protected readonly stalledControlLabel = 'process';
  readonly allowFailureCalls: string[][] = [];
  readonly inputs: Array<{ paneId: string; data: string }> = [];
  readonly disposed: string[] = [];

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

  protected resolveDefaultWorkingDir(): string {
    return '/tmp';
  }

  protected async runTmuxAllowFailure(argv: string[]): Promise<CommandResult> {
    this.allowFailureCalls.push(argv);
    return { exitCode: 0, stdout: '', stderr: '' };
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

  test('session commands reach runTmuxAllowFailure through the bound host', async () => {
    const core = new StubExternalCore();
    core.markConnected();
    core.resizePane('%1', 80, 24);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core.allowFailureCalls.length).toBeGreaterThan(0);
  });
});
