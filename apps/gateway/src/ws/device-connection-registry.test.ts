import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as db from '../db';
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

describe('DeviceConnectionRegistry reconnect exhaustion', () => {
  const timeoutFns: Array<(...args: unknown[]) => unknown> = [];
  let setTimeoutSpy: ReturnType<typeof spyOn> | undefined;
  let settingsSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    setTimeoutSpy?.mockRestore();
    settingsSpy?.mockRestore();
    timeoutFns.length = 0;
  });

  test('retry limit deletes the dead entry so next getOrCreate is a fresh runtime', async () => {
    settingsSpy = spyOn(db, 'getSiteSettings').mockReturnValue({
      sshReconnectMaxRetries: 1,
      sshReconnectDelaySeconds: 1,
    } as ReturnType<typeof db.getSiteSettings>);
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => unknown
    ) => {
      timeoutFns.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const events: Array<{ type: string; errorType?: string }> = [];
    const createResults: Array<DeviceConnectionEntry | null> = [];
    const host = {
      deps: {
        releaseRuntime: async () => {},
      },
      canonicalSessions: new Map(),
      async createDeviceConnectionEntry() {
        const next = createResults.shift();
        return next ?? null;
      },
      releaseConnectionEntry() {},
      broadcastDeviceEvent(
        _entry: DeviceConnectionEntry,
        payload: { type: string; errorType?: string }
      ) {
        events.push({ type: payload.type, errorType: payload.errorType });
      },
    } as unknown as DeviceConnectionRegistryHost;

    const registry = new DeviceConnectionRegistry(host);
    const ws = {
      data: {
        borshState: { selectedPanes: { 'dev-dead': '%0' } as Record<string, string | null> },
      },
    };
    const dead = fakeEntry();
    dead.clients.add(ws as never);
    registry.connections.set('dev-dead', dead);

    await registry.handleConnectionClose('dev-dead');
    expect(timeoutFns.length).toBe(1);
    await (timeoutFns.shift() as () => Promise<void>)();

    expect(events.some((e) => e.errorType === 'reconnect_failed')).toBe(true);
    expect(registry.connections.has('dev-dead')).toBe(false);
    expect(registry.connections.get('dev-dead')).toBeUndefined();

    const fresh = fakeEntry();
    createResults.push(fresh);
    const got = await registry.getOrCreate('dev-dead', ws as never);
    expect(got).toBe(fresh);
    expect(got).not.toBe(dead);
  });
});
