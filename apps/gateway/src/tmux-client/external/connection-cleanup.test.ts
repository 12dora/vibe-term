import { describe, expect, test } from 'bun:test';

import { ConnectionCleanup, type ConnectionCleanupHost } from './connection-cleanup';

describe('ConnectionCleanup', () => {
  function createHost() {
    const order: string[] = [];
    const host: ConnectionCleanupHost = {
      cleanupPromise: null,
      closeNotified: false,
      manualDisconnect: false,
      connected: true,
      callbacks: {
        onClose: () => {
          order.push('onClose');
        },
      },
      stopControlClient() {
        order.push('stopControlClient');
      },
      async disposeTransport() {
        order.push('disposeTransport');
      },
    };
    return { host, order };
  }

  test('shutdownInternal clears connected, stops control, then disposes transport', async () => {
    const { host, order } = createHost();
    await new ConnectionCleanup(host).shutdownInternal(true);
    expect(host.connected).toBe(false);
    expect(host.closeNotified).toBe(true);
    expect(host.cleanupPromise).toBeNull();
    expect(order).toEqual(['stopControlClient', 'disposeTransport', 'onClose']);
  });

  test('a second shutdown waits for the in-flight cleanup before optionally closing', async () => {
    const { host, order } = createHost();
    let release!: () => void;
    host.disposeTransport = async () => {
      order.push('disposeTransport-start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('disposeTransport-end');
    };
    const cleanup = new ConnectionCleanup(host);
    const first = cleanup.shutdownInternal(false);
    await Bun.sleep(0);
    const second = cleanup.shutdownInternal(true);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'stopControlClient',
      'disposeTransport-start',
      'disposeTransport-end',
      'onClose',
    ]);
    expect(host.closeNotified).toBe(true);
  });

  test('manual disconnect suppresses onClose', async () => {
    const { host, order } = createHost();
    host.manualDisconnect = true;
    await new ConnectionCleanup(host).shutdownInternal(true);
    expect(order).toEqual(['stopControlClient', 'disposeTransport']);
    expect(host.closeNotified).toBe(false);
  });
});
