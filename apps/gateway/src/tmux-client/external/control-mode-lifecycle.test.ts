import { describe, expect, test } from 'bun:test';

import type { TmuxConnectionOptions } from '../connection-types';
import { ControlModeCommandQueue } from '../control-mode-capture';
import { SOURCE_METADATA_SUBSCRIPTION_COMMANDS } from '../control-mode-subscription';
import { createFakeClock } from '../control-queue-test-helpers';
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
      expectAttach: () => new Promise(() => {}),
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

  test('onBlockBegin forwards %begin args to the command queue', () => {
    const { host } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    const seen: Array<string | undefined> = [];
    const queue = {
      nextBlockIsLiteral: (args?: string) => {
        seen.push(args);
        return args?.includes(' 3 ') ?? false;
      },
      handleBlock: () => false,
      expectAttach: () => new Promise(() => {}),
    } as unknown as ControlModeCommandQueue;
    const callbacks = lifecycle.buildControlModeCallbacks(
      () => {},
      queue,
      () => {},
      () => true
    );
    expect(callbacks.onBlockBegin?.('1710000000 2 0')).toBe(false);
    expect(callbacks.onBlockBegin?.('1710000000 3 0')).toBe(true);
    expect(seen).toEqual(['1710000000 2 0', '1710000000 3 0']);
  });

  test('onBlockBegin args stamp seq so a non-literal orphan does not steal a literal capture begin', async () => {
    const { host } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    const queue = new ControlModeCommandQueue();
    const callbacks = lifecycle.buildControlModeCallbacks(
      () => {},
      queue,
      () => {},
      () => true
    );
    expect(callbacks.onBlockBegin?.('1 1 0')).toBe(false);
    callbacks.onBlockEnd?.({ args: '1 1 0', isError: false, lines: [] });
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'probe',
    });
    expect(callbacks.onBlockBegin?.('1 10 0')).toBe(false);
    await expect(probe).rejects.toThrow(/timed out/);
    const capture = queue.execute(() => {}, 'capture-pane -p', {
      literal: true,
      transform: (block) => block.lines.join('\n'),
    });
    expect(callbacks.onBlockBegin?.('1 11 0')).toBe(true);
    expect(queue.handleBlock({ args: '1 11 0', isError: false, lines: ['%output pane'] })).toBe(
      true
    );
    await expect(capture).resolves.toBe('%output pane');
    expect(queue.handleBlock({ args: '1 10 0', isError: false, lines: ['vibeterm-lat'] })).toBe(
      true
    );
    queue.dispose();
  });

  function createClockedQueue() {
    const clock = createFakeClock();
    let poisoned = 0;
    const queue = new ControlModeCommandQueue(
      () => {
        poisoned += 1;
      },
      undefined,
      { clock, stallTimeoutMs: () => 45_000 }
    );
    return { clock, queue, poisoned: () => poisoned };
  }

  test('sendHeartbeat skips while any control activity is recent and sends after silence', () => {
    const { host, written } = createHost();
    const { clock, queue } = createClockedQueue();
    host.controlCommands = queue;
    const lifecycle = new ControlModeLifecycle(host);
    clock.advance(29_000);
    queue.noteActivity();
    clock.advance(29_000);
    lifecycle.sendHeartbeat();
    expect(written).toEqual([]);
    expect(host.heartbeatPending).toBe(false);

    clock.advance(1_000);
    lifecycle.sendHeartbeat();
    expect(written).toEqual(['display-message -p "vibeterm-hb"\n']);
    expect(host.heartbeatPending).toBe(true);
    expect(host.heartbeatTimeoutTimer).not.toBeNull();
    lifecycle.stopHeartbeat();
    queue.dispose();
  });

  test('heartbeat never kills a slow channel that keeps making progress', async () => {
    const { host, order } = createHost();
    const { clock, queue, poisoned } = createClockedQueue();
    host.controlCommands = queue;
    const lifecycle = new ControlModeLifecycle(host);
    clock.advance(30_000);
    lifecycle.sendHeartbeat();
    for (let i = 0; i < 6; i += 1) {
      clock.advance(10_000);
      queue.noteActivity();
      lifecycle.checkHeartbeat();
    }
    expect(order).not.toContain('kill');
    expect(poisoned()).toBe(0);
    await Promise.resolve();
    lifecycle.checkHeartbeat();
    expect(host.heartbeatPending).toBe(false);
    lifecycle.stopHeartbeat();
    queue.dispose();
  });

  test('heartbeat kills the transport once the channel is silent for the stall window', () => {
    const { host, order } = createHost();
    const { clock, queue, poisoned } = createClockedQueue();
    host.controlCommands = queue;
    const lifecycle = new ControlModeLifecycle(host);
    const warn = console.warn;
    console.warn = () => {};
    try {
      clock.advance(30_000);
      lifecycle.sendHeartbeat();
      clock.advance(44_999);
      lifecycle.checkHeartbeat();
      expect(order).not.toContain('kill');
      clock.advance(1);
      lifecycle.checkHeartbeat();
      expect(order).toContain('kill');
      expect(poisoned()).toBe(1);
    } finally {
      console.warn = warn;
      lifecycle.stopHeartbeat();
    }
  });

  test('heartbeat response clears the pending check', async () => {
    const { host } = createHost();
    const { clock, queue } = createClockedQueue();
    host.controlCommands = queue;
    const lifecycle = new ControlModeLifecycle(host);
    clock.advance(30_000);
    lifecycle.sendHeartbeat();
    queue.handleBlock({ args: '', isError: false, lines: ['vibeterm-hb'] });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.heartbeatPending).toBe(false);
    expect(host.heartbeatTimeoutTimer).toBeNull();
    queue.dispose();
  });

  test('commands queued before a late attach block do not claim it', async () => {
    const { host } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    const queue = new ControlModeCommandQueue();
    let attached = 0;
    const callbacks = lifecycle.buildControlModeCallbacks(
      () => {
        attached += 1;
      },
      queue,
      () => {},
      () => true
    );
    const subscribe = queue.execute(() => {}, 'refresh-client -B a', {
      transform: (block) => block.lines.join('\n'),
    });
    expect(callbacks.onBlockBegin?.('1 1 0')).toBe(false);
    callbacks.onBlockEnd?.({ args: '1 1 0', isError: false, lines: [] });
    await Promise.resolve();
    expect(attached).toBe(1);
    expect(queue.busy).toBe(true);
    expect(callbacks.onBlockBegin?.('1 2 0')).toBe(false);
    callbacks.onBlockEnd?.({ args: '1 2 0', isError: false, lines: ['sub-reply'] });
    await expect(subscribe).resolves.toBe('sub-reply');
    queue.dispose();
  });

  test('a fast attach resolves readiness from the first block', async () => {
    const { host } = createHost();
    const lifecycle = new ControlModeLifecycle(host);
    const queue = new ControlModeCommandQueue();
    let attached = 0;
    const callbacks = lifecycle.buildControlModeCallbacks(
      () => {
        attached += 1;
      },
      queue,
      () => {},
      () => true
    );
    callbacks.onBlockEnd?.({ args: '1 1 0', isError: false, lines: [] });
    await Promise.resolve();
    expect(attached).toBe(1);
    expect(queue.busy).toBe(false);
    queue.dispose();
  });
});
