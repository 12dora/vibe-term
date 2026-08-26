import { describe, expect, test } from 'bun:test';
import {
  DeviceConnectionRegistry,
  type DeviceConnectionRegistryHost,
} from './device-connection-registry';
import type { DeviceConnectionEntry } from './types';

function fakeEntry(): DeviceConnectionEntry {
  return {
    runtime: {} as DeviceConnectionEntry['runtime'],
    detachRuntime: () => {},
    clients: new Set(),
    lastSnapshot: null,
    snapshotTimer: null,
    snapshotPollTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    canonicalClients: new Set(),
    idleReleaseTimer: null,
  };
}

describe('DeviceConnectionRegistry close generation', () => {
  test('discards and releases an entry that resolves after closeAll', async () => {
    const released: string[] = [];
    const releaseRef: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolve) => {
      releaseRef.current = resolve;
    });
    const created = fakeEntry();
    const host = {
      async createDeviceConnectionEntry() {
        await gate;
        return created;
      },
      releaseConnectionEntry(deviceId: string, entry: DeviceConnectionEntry) {
        released.push(deviceId);
        expect(entry).toBe(created);
      },
    } as unknown as DeviceConnectionRegistryHost;

    const registry = new DeviceConnectionRegistry(host);
    const pending = registry.getOrCreate('device-race', {} as never);
    registry.closeAll();
    if (releaseRef.current) {
      releaseRef.current();
    }

    expect(await pending).toBeNull();
    expect(registry.connections.size).toBe(0);
    expect(registry.pendingConnectionEntries.size).toBe(0);
    expect(released).toEqual(['device-race']);
    expect(registry.isClosed).toBe(true);
  });

  test('rejects new getOrCreate after closeAll', async () => {
    const host = {
      async createDeviceConnectionEntry() {
        return fakeEntry();
      },
      releaseConnectionEntry() {},
    } as unknown as DeviceConnectionRegistryHost;
    const registry = new DeviceConnectionRegistry(host);
    registry.closeAll();
    expect(await registry.getOrCreate('device-z', {} as never)).toBeNull();
  });
});
