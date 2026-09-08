import { describe, expect, test } from 'bun:test';
import type { TmuxConnectionOptions } from './connection-types';
import type { ControlModeCommandQueue } from './control-mode-capture';
import {
  type ControlClientProcess,
  LocalExternalTmuxConnection,
} from './local-external-connection';
import { SshExternalTmuxConnection } from './ssh-external-connection';

function callbacks(events: string[]): TmuxConnectionOptions {
  return {
    deviceId: 'test-input-connection',
    onEvent: () => {},
    onTerminalOutput: () => {},
    onTerminalHistory: () => {},
    onSnapshot: () => {},
    onError: () => {},
    onClose: () => {},
    onInputTransportInvalidated: () => events.push('invalidated'),
  };
}

function fakeProcess(events: string[], failWrite: boolean): ControlClientProcess {
  const exit = Promise.withResolvers<number>();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const streams = [0, 1].map(
    () => new ReadableStream<Uint8Array>({ start: (controller) => controllers.push(controller) })
  );
  let stopped = false;
  return {
    stdout: streams[0],
    stderr: streams[1],
    exited: exit.promise,
    write: () => {
      if (failWrite) throw new Error('broken stdin');
    },
    kill: () => {
      if (stopped) return;
      stopped = true;
      events.push('kill');
      for (const controller of controllers) controller.close();
      exit.resolve(0);
    },
  };
}

interface LocalInternals {
  connected: boolean;
  controlCommands: ControlModeCommandQueue;
  spawnControlClientProcess(ready: () => void): ControlClientProcess;
  handleControlClientExit(process: ControlClientProcess, code: number): void;
}

function localHarness(failWrite = false) {
  const events: string[] = [];
  const proc = fakeProcess(events, failWrite);
  let spawned = false;
  const connection = new LocalExternalTmuxConnection(callbacks(events), {
    getDevice: () => null,
    spawnControlClient: () => {
      if (spawned) return fakeProcess(events, failWrite);
      spawned = true;
      return proc;
    },
  });
  const internals = connection as unknown as LocalInternals;
  internals.spawnControlClientProcess(() => {});
  internals.connected = true;
  events.length = 0;
  return { events, proc, connection, internals };
}

describe('external connection input invalidation', () => {
  test('local process exit invalidates runtime input synchronously before pending writes reject', async () => {
    const h = localHarness();
    try {
      const input = h.connection.sendInput('%1', 'A');
      h.internals.connected = false;
      h.internals.handleControlClientExit(h.proc, 1);
      expect(h.events).toEqual(['invalidated']);
      await expect(input).rejects.toThrow('tmux control client exited');
    } finally {
      h.connection.disconnect();
      h.proc.kill();
    }
  });

  test('local poisoned command queue invalidates runtime input before killing the process', async () => {
    const h = localHarness(true);
    try {
      let acknowledged = false;
      const input = h.connection.sendInput('%1', 'A', () => {
        acknowledged = true;
      });
      expect(h.events).toEqual(['invalidated', 'kill']);
      h.internals.connected = false;
      await expect(input).rejects.toThrow('broken stdin');
      expect(acknowledged).toBe(false);
    } finally {
      h.connection.disconnect();
    }
  });

  test('local replacement invalidates runtime input before any new command can be written', async () => {
    const h = localHarness();
    try {
      const input = h.connection.sendInput('%1', 'A');
      h.internals.spawnControlClientProcess(() => {});
      expect(h.events).toEqual(['invalidated']);
      await expect(input).rejects.toThrow('tmux control connection replaced');
    } finally {
      h.connection.disconnect();
      h.proc.kill();
    }
  });

  test('SSH channel close invalidates runtime input and rejects its outstanding control commands', async () => {
    const events: string[] = [];
    const connection = new SshExternalTmuxConnection(callbacks(events), {
      getDevice: () => null,
    });
    const internals = connection as unknown as {
      controlCommands: ControlModeCommandQueue;
      controlChannel: { stop: () => void; write: () => void };
      handleControlChannelClose(handle: unknown): void;
    };
    const handle = { stop: () => {}, write: () => {} };
    internals.controlChannel = handle;
    const input = internals.controlCommands.execute(() => {}, 'send-keys', {
      transform: () => undefined,
    });
    internals.handleControlChannelClose(handle);
    expect(events).toEqual(['invalidated']);
    await expect(input).rejects.toThrow('tmux control channel exited');
  });
});
