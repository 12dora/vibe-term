import { describe, expect, test } from 'bun:test';

import type { TmuxConnectionOptions } from '../connection-types';
import type { ControlModeCommandQueue } from '../control-mode-capture';
import { SOURCE_METADATA_SUBSCRIPTION_COMMANDS } from '../control-mode-subscription';
import { type ControlModeHost, ControlModeLifecycle } from './control-mode-lifecycle';
import type { ExternalControlHandle } from './types';

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

describe('ControlModeLifecycle', () => {
  function createHost(overrides: Partial<ControlModeHost> = {}) {
    const order: string[] = [];
    const written: string[] = [];
    const transport: ExternalControlHandle = {
      write: (data) => {
        written.push(data);
      },
    };
    const host: ControlModeHost = {
      deviceId: 'dev-1',
      logPrefix: '[test]',
      stalledControlLabel: 'process',
      connected: true,
      manualDisconnect: false,
      controlStderrTail: '',
      controlCommands: {
        execute: async (_write: (data: string) => void, command: string) => {
          order.push(`subscribe:${command.trim()}`);
        },
        dispose: () => {
          order.push('dispose-commands');
        },
      } as unknown as ControlModeCommandQueue,
      controlSubscription: {
        dispose: () => {
          order.push('dispose-subscription');
        },
        push: () => {},
        end: () => {},
        prunePanes: () => {},
        noteParkingWindow: () => {},
      },
      callbacks: createCallbacks(),
      async createParkingWindow() {
        order.push('create-parking');
        return '@99';
      },
      async removeParkingWindow(windowId) {
        order.push(`remove-parking:${windowId}`);
      },
      async attachControlTransport(onAttachReady) {
        order.push('attach');
        onAttachReady();
        return transport;
      },
      isAttachedControlTransport: (candidate) => candidate === transport,
      controlAttachFailureMessage: () => 'tmux control client exited during attach',
      onControlAttachPrematureClose: () => {
        order.push('premature-close');
      },
      getControlWriter: () => (data) => written.push(data),
      killControlTransport: () => {
        order.push('kill');
      },
      detachControlTransport: () => {
        order.push('detach');
        return () => {
          order.push('kill-detached');
        };
      },
      requestSnapshot: () => {},
      recordBell: () => {},
      emitNotification: () => {},
      noteThemeSubscription: () => {},
      clearThemeSubscription: () => {},
      heartbeatTimer: null,
      heartbeatPending: false,
      heartbeatTimeoutTimer: null,
      ...overrides,
    };
    return { host, order, written, transport };
  }

  test('startControlClient parks, attaches, unparks, then subscribes metadata', async () => {
    const { host, order } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    await lifecycle.startControlClient();
    lifecycle.stopHeartbeat();
    expect(order.slice(0, 6)).toEqual([
      'create-parking',
      'attach',
      'remove-parking:@99',
      `subscribe:${SOURCE_METADATA_SUBSCRIPTION_COMMANDS[0].trim()}`,
      `subscribe:${SOURCE_METADATA_SUBSCRIPTION_COMMANDS[1].trim()}`,
    ]);
  });

  test('startControlClient still removes parking when attach is missing', async () => {
    const { host, order } = createHost({
      isAttachedControlTransport: () => false,
    });
    const lifecycle = new ControlModeLifecycle(host);
    await expect(lifecycle.startControlClient()).rejects.toThrow(
      'tmux control client exited during attach'
    );
    expect(order).toEqual(['create-parking', 'attach', 'remove-parking:@99', 'premature-close']);
  });

  test('stopControlClient detaches, disposes, then kills the detached transport', () => {
    const { host, order } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    lifecycle.stopControlClient();
    expect(order).toEqual(['detach', 'dispose-subscription', 'dispose-commands', 'kill-detached']);
    expect(host.controlSubscription).toBeNull();
  });

  test('onPause continues the pane only while the transport is current', async () => {
    const { host } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    const executed: string[] = [];
    const queue = {
      execute: async (_write: (data: string) => void, command: string) => {
        executed.push(command);
      },
      nextBlockIsLiteral: () => {},
      handleBlock: () => false,
    } as unknown as ControlModeCommandQueue;
    const current = lifecycle.buildControlModeCallbacks(
      () => {},
      queue,
      () => {},
      () => true
    );
    current.onPause?.('%1');
    const stale = lifecycle.buildControlModeCallbacks(
      () => {},
      queue,
      () => {},
      () => false
    );
    stale.onPause?.('%1');
    await Bun.sleep(0);
    expect(executed).toEqual(['refresh-client -A %1:continue']);
  });

  test('sendHeartbeat skips when control traffic is recent and sends after silence', async () => {
    const { host, written } = createHost();
    const commands: string[] = [];
    host.controlCommands = {
      execute: async (write: (data: string) => void, command: string) => {
        commands.push(command);
        write(`${command}\n`);
      },
    } as unknown as ControlModeCommandQueue;
    const lifecycle = new ControlModeLifecycle(host);
    const recent = Date.now();
    host.lastControlActivityAt = () => recent;
    lifecycle.sendHeartbeat();
    expect(commands).toEqual([]);
    expect(written).toEqual([]);
    expect(host.heartbeatPending).toBe(false);

    host.lastControlActivityAt = () => recent - 30_001;
    lifecycle.sendHeartbeat();
    expect(commands).toEqual(['display-message -p "tmex-hb"']);
    expect(written).toEqual(['display-message -p "tmex-hb"\n']);
    expect(host.heartbeatPending).toBe(true);
    expect(host.heartbeatTimeoutTimer).not.toBeNull();
    lifecycle.stopHeartbeat();
  });
});
