import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import * as db from '../db';
import {
  clearLegacyPaneOutputObservers,
  isLegacyPaneOutputObserved,
} from '../tmux-client/runtime/output-materialization';
import {
  DeviceConnectionRegistry,
  type DeviceConnectionRegistryHost,
} from './device-connection-registry';
import { createGatewaySession } from './test-helpers';
import { type DeviceConnectionEntry, RUNTIME_IDLE_GRACE_MS } from './types';

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
    const ws = createGatewaySession();
    ws.borshState.selectedPanes['dev-dead'] = '%0';
    const dead = fakeEntry();
    dead.clients.add(ws);
    registry.connections.set('dev-dead', dead);

    await registry.handleConnectionClose('dev-dead');
    expect(timeoutFns.length).toBe(1);
    await (timeoutFns.shift() as () => Promise<void>)();

    expect(events.some((e) => e.errorType === 'reconnect_failed')).toBe(true);
    expect(registry.connections.has('dev-dead')).toBe(false);
    expect(registry.connections.get('dev-dead')).toBeUndefined();

    const fresh = fakeEntry();
    createResults.push(fresh);
    const got = await registry.getOrCreate('dev-dead', ws);
    expect(got).toBe(fresh);
    expect(got).not.toBe(dead);
  });
});

describe('DeviceConnectionRegistry pending connect vs disconnect', () => {
  const idleTimers: Array<() => void> = [];
  let setTimeoutSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    setTimeoutSpy?.mockRestore();
    idleTimers.length = 0;
  });

  test('disconnect during pending getOrCreate does not emit device-connected and releases the entry', async () => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => unknown,
      delay?: number
    ) => {
      if (delay === RUNTIME_IDLE_GRACE_MS) {
        idleTimers.push(fn as () => void);
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const released: string[] = [];
    const kinds: number[] = [];
    const releaseRef: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolve) => {
      releaseRef.current = resolve;
    });
    const created = fakeEntry();
    created.runtime = { requestSnapshot() {} } as DeviceConnectionEntry['runtime'];

    const host = {
      canonicalSessions: new Map(),
      async createDeviceConnectionEntry() {
        await gate;
        return created;
      },
      releaseConnectionEntry(deviceId: string, entry: DeviceConnectionEntry) {
        released.push(deviceId);
        expect(entry).toBe(created);
      },
      sendEnvelope(_ws: unknown, kind: number) {
        kinds.push(kind);
      },
    } as unknown as DeviceConnectionRegistryHost;

    const registry = new DeviceConnectionRegistry(host);
    const ws = createGatewaySession();

    const pendingConnect = registry.handleDeviceConnect(ws, 'device-race');
    registry.handleDeviceDisconnect(ws, 'device-race');
    if (releaseRef.current) {
      releaseRef.current();
    }
    await pendingConnect;

    expect(kinds).toEqual([wsBorsh.KIND_DEVICE_DISCONNECTED]);
    expect(kinds).not.toContain(wsBorsh.KIND_DEVICE_CONNECTED);
    expect(created.clients.size).toBe(0);

    expect(idleTimers.length).toBe(1);
    idleTimers[0]();
    expect(released).toEqual(['device-race']);
    expect(registry.connections.size).toBe(0);
    expect(registry.pendingConnectionEntries.size).toBe(0);
  });
});

describe('DeviceConnectionRegistry output observer presence', () => {
  test('keeps connected legacy clients conservative and clears presence on disconnect', async () => {
    const deviceId = 'device-observer-presence';
    const entry = fakeEntry();
    entry.runtime = { requestSnapshot() {} } as DeviceConnectionEntry['runtime'];
    const host = {
      canonicalSessions: new Map(),
      async createDeviceConnectionEntry() {
        return entry;
      },
      releaseConnectionEntry() {},
      syncLegacyPaneObservers() {},
      releaseLegacyPaneObservers() {},
      dropViewportClaims() {},
      sendEnvelope() {},
    } as unknown as DeviceConnectionRegistryHost;
    const registry = new DeviceConnectionRegistry(host);
    const ws = createGatewaySession();
    clearLegacyPaneOutputObservers(deviceId);

    await registry.handleDeviceConnect(ws, deviceId);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(true);

    registry.handleDeviceDisconnect(ws, deviceId);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(false);
    registry.clearIdleReleaseTimer(entry);
    registry.closeAll();
    clearLegacyPaneOutputObservers(deviceId);
  });
});
