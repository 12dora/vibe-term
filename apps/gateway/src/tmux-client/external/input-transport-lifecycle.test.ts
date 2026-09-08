import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from '../control-mode-capture';
import { createControlModeSubscription } from '../control-mode-subscription';
import { type ControlModeHost, ControlModeLifecycle } from './control-mode-lifecycle';

function harness() {
  const events: string[] = [];
  let current = true;
  const transport = { write: () => {} };
  const queue = new ControlModeCommandQueue();
  const host: ControlModeHost = {
    deviceId: 'test-input-lifecycle',
    logPrefix: '[test]',
    stalledControlLabel: 'test',
    connected: true,
    manualDisconnect: false,
    controlStderrTail: '',
    controlCommands: queue,
    controlSubscription: null,
    callbacks: {
      deviceId: 'test-input-lifecycle',
      onEvent: () => {},
      onTerminalOutput: () => events.push('output'),
      onTerminalHistory: () => {},
      onSnapshot: () => {},
      onError: () => {},
      onClose: () => {},
      onInputTransportInvalidated: () => events.push('invalidated'),
      onInputTransportReady: () => events.push('ready'),
    },
    createParkingWindow: async () => null,
    removeParkingWindow: async () => {},
    attachControlTransport: async (ready) => {
      ready();
      return transport;
    },
    isAttachedControlTransport: () => current,
    controlAttachFailureMessage: () => 'attach failed',
    onControlAttachPrematureClose: () => {},
    getControlWriter: () => transport.write,
    killControlTransport: () => events.push('kill'),
    detachControlTransport: () => {
      events.push('detach');
      return () => events.push('kill-detached');
    },
    requestSnapshot: () => {},
    recordBell: () => {},
    emitNotification: () => {},
    noteThemeSubscription: () => {},
    clearThemeSubscription: () => {},
    heartbeatTimer: null,
    heartbeatPending: false,
    heartbeatTimeoutTimer: null,
  };
  const lifecycle = new ControlModeLifecycle(host);
  const subscription = createControlModeSubscription(
    lifecycle.buildControlModeCallbacks(
      () => {},
      queue,
      transport.write,
      () => current
    )
  );
  return {
    events,
    host,
    queue,
    lifecycle,
    subscription,
    stale: () => {
      current = false;
    },
    cleanup: () => {
      lifecycle.stopHeartbeat();
      queue.dispose();
      subscription.dispose();
    },
  };
}

describe('input control transport lifecycle', () => {
  test('parser exit invalidates input synchronously and rejects the outstanding command before process close', async () => {
    const h = harness();
    try {
      const pending = h.queue.execute(() => {}, 'send-keys', { transform: () => undefined });
      h.subscription.push(new TextEncoder().encode('%exit\n'));
      expect(h.events).toEqual(['invalidated']);
      await expect(pending).rejects.toThrow('tmux control parser exited');
    } finally {
      h.cleanup();
    }
  });

  test('stale parser exit cannot invalidate the replacement transport', () => {
    const h = harness();
    try {
      h.stale();
      h.subscription.push(new TextEncoder().encode('%exit\n'));
      expect(h.events).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test('each successful attachment invalidates the old generation then marks the new one ready', async () => {
    const h = harness();
    try {
      await h.lifecycle.startControlClient();
      await h.lifecycle.startControlClient();
      expect(h.events).toEqual(['invalidated', 'ready', 'invalidated', 'ready']);
    } finally {
      h.cleanup();
    }
  });

  test('failed attachment leaves input invalidated', async () => {
    const h = harness();
    try {
      h.stale();
      await expect(h.lifecycle.startControlClient()).rejects.toThrow('attach failed');
      expect(h.events).toEqual(['invalidated']);
    } finally {
      h.cleanup();
    }
  });

  test('explicit stop invalidates input before detaching and killing the transport', () => {
    const h = harness();
    try {
      h.lifecycle.stopControlClient();
      expect(h.events).toEqual(['invalidated', 'detach', 'kill-detached']);
    } finally {
      h.cleanup();
    }
  });
});
