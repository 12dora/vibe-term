import { describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

import * as db from '../db';
import { establishSshClientConnection, execSshShellChannel } from './ssh-client-connect';
import { type SshControlReconnectContext, reconnectSshControlClient } from './ssh-control-channel';

class FakeClient extends EventEmitter {
  connectConfig: ConnectConfig | null = null;
  execError: Error | null = null;

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    return this;
  }

  exec(
    command: string,
    options: unknown,
    callback?: (error: Error | undefined, channel: ClientChannel) => void
  ): this {
    const cb =
      typeof options === 'function'
        ? (options as (error: Error | undefined, channel: ClientChannel) => void)
        : callback;
    if (this.execError) {
      cb?.(this.execError, undefined as unknown as ClientChannel);
      return this;
    }
    cb?.(undefined, new EventEmitter() as unknown as ClientChannel);
    return this;
  }
}

function asClient(client: FakeClient): Client {
  return client as unknown as Client;
}

describe('establishSshClientConnection', () => {
  test('resolves on ready and records the connect config', async () => {
    const client = new FakeClient();
    const pending = establishSshClientConnection(
      asClient(client),
      { host: 'example.com', port: 22, username: 'alice' },
      {
        reportError: () => {
          throw new Error('reportError should not run');
        },
        isManualDisconnect: () => false,
        onUnexpectedError: () => {
          throw new Error('onUnexpectedError should not run');
        },
        onUnexpectedClose: () => {
          throw new Error('onUnexpectedClose should not run');
        },
      }
    );
    client.emit('ready');
    await pending;
    expect(client.connectConfig).toEqual({ host: 'example.com', port: 22, username: 'alice' });
  });

  test('rejects when the client errors before ready', async () => {
    const client = new FakeClient();
    const reported: string[] = [];
    const pending = establishSshClientConnection(
      asClient(client),
      { host: 'h' },
      {
        reportError: (error) => {
          reported.push(error.message);
        },
        isManualDisconnect: () => false,
        onUnexpectedError: () => undefined,
        onUnexpectedClose: () => undefined,
      }
    );
    client.emit('error', new Error('auth failed'));
    await expect(pending).rejects.toThrow('auth failed');
    expect(reported).toEqual(['auth failed']);
  });

  test('rejects when the connection closes before ready', async () => {
    const client = new FakeClient();
    const pending = establishSshClientConnection(
      asClient(client),
      { host: 'h' },
      {
        reportError: () => undefined,
        isManualDisconnect: () => false,
        onUnexpectedError: () => undefined,
        onUnexpectedClose: () => undefined,
      }
    );
    client.emit('close');
    await expect(pending).rejects.toThrow('SSH connection closed before ready');
  });

  test('reports unexpected error after ready unless manually disconnected', async () => {
    const client = new FakeClient();
    const unexpected: string[] = [];
    const pending = establishSshClientConnection(
      asClient(client),
      { host: 'h' },
      {
        reportError: () => undefined,
        isManualDisconnect: () => false,
        onUnexpectedError: (error) => {
          unexpected.push(error.message);
        },
        onUnexpectedClose: () => undefined,
      }
    );
    client.emit('ready');
    await pending;
    client.emit('error', new Error('dropped'));
    expect(unexpected).toEqual(['dropped']);
  });
});

describe('execSshShellChannel', () => {
  test('rejects when exec fails', async () => {
    const client = new FakeClient();
    client.execError = new Error('no pty');
    await expect(execSshShellChannel(asClient(client))).rejects.toThrow('no pty');
  });
});

function createReconnectCtx(
  overrides: Partial<SshControlReconnectContext> & {
    controlRestartCount?: number;
    controlStartedAt?: number;
  } = {}
): SshControlReconnectContext & {
  restartCount: number;
  shutdowns: boolean[];
  snapshots: number;
  starts: number;
} {
  const startedAt = overrides.controlStartedAt ?? Date.now();
  const state = {
    restartCount: overrides.controlRestartCount ?? 0,
    shutdowns: [] as boolean[],
    snapshots: 0,
    starts: 0,
  };
  return {
    deviceId: 'device-ssh',
    sessionName: 'tmex',
    isLifecycleActive: () => true,
    getControlStartedAt: () => startedAt,
    getControlRestartCount: () => state.restartCount,
    setControlRestartCount: (count) => {
      state.restartCount = count;
    },
    getControlStderrTail: () => '',
    getActivePaneId: () => null,
    runTmuxAllowFailure: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    startControlClient: async () => {
      state.starts += 1;
    },
    requestSnapshot: () => {
      state.snapshots += 1;
    },
    capturePaneHistory: async () => undefined,
    shutdownInternal: async (notifyClose) => {
      state.shutdowns.push(notifyClose);
    },
    notifySessionClosed: () => undefined,
    ...overrides,
    get restartCount() {
      return state.restartCount;
    },
    get snapshots() {
      return state.snapshots;
    },
    get starts() {
      return state.starts;
    },
    shutdowns: state.shutdowns,
  };
}

describe('reconnectSshControlClient', () => {
  test('gives up after CONTROL_MAX_RESTARTS and shuts down', async () => {
    const status = spyOn(db, 'updateDeviceRuntimeStatus').mockImplementation(() => undefined);
    const ctx = createReconnectCtx({ controlRestartCount: 3, controlStartedAt: Date.now() });
    await reconnectSshControlClient(ctx);
    expect(ctx.shutdowns).toEqual([true]);
    expect(ctx.starts).toBe(0);
    expect(status.mock.calls[0]?.[1]).toMatchObject({
      tmuxAvailable: false,
      lastError: 'tmux control client channel closed repeatedly',
    });
    status.mockRestore();
  });

  test('treats a failed has-session probe as session gone', async () => {
    const status = spyOn(db, 'updateDeviceRuntimeStatus').mockImplementation(() => undefined);
    const closed: string[] = [];
    const ctx = createReconnectCtx({
      controlRestartCount: 0,
      controlStartedAt: Date.now(),
      runTmuxAllowFailure: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'session not found',
      }),
      notifySessionClosed: (message) => {
        closed.push(message);
      },
    });
    await reconnectSshControlClient(ctx);
    expect(closed).toEqual(['session not found']);
    expect(ctx.shutdowns).toEqual([true]);
    expect(ctx.starts).toBe(0);
    status.mockRestore();
  });

  test('returns after the backoff when the lifecycle is no longer active', async () => {
    const ctx = createReconnectCtx({
      controlRestartCount: 0,
      controlStartedAt: Date.now(),
      isLifecycleActive: () => false,
    });
    await reconnectSshControlClient(ctx);
    expect(ctx.starts).toBe(0);
    expect(ctx.shutdowns).toEqual([]);
  });

  test('restarts the control client and requests a snapshot when the session is alive', async () => {
    const history: string[] = [];
    const ctx = createReconnectCtx({
      controlRestartCount: 0,
      controlStartedAt: Date.now(),
      getActivePaneId: () => '%1',
      capturePaneHistory: async (paneId) => {
        history.push(paneId);
      },
    });
    await reconnectSshControlClient(ctx);
    expect(ctx.starts).toBe(1);
    expect(ctx.snapshots).toBe(1);
    expect(history).toEqual(['%1']);
    expect(ctx.shutdowns).toEqual([]);
  });
});
