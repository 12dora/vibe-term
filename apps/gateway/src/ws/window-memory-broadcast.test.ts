import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import type { WindowMemoryListener } from '../window-memory/runtime-adapter';
import { bindWindowMemoryRuntimeHost } from '../window-memory/runtime-host';
import type { WindowMemoryAggregate } from '../window-memory/types';
import type { GatewaySession } from './gateway-session';
import { shareVisibleClients } from './share-gate';
import type { ShareScope } from './share-scope';
import { type BorshTestWs, createGatewaySession } from './test-helpers';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';
import { WindowMemoryBroadcast, bindWindowMemoryBroadcast } from './window-memory-broadcast';

const DEVICE_ID = 'device-a';
const SHARE_SCOPE: ShareScope = { shareId: 'sh1', deviceId: DEVICE_ID, windowId: '@1' };

function aggregate(
  windowId: string,
  overrides: Partial<WindowMemoryAggregate> = {}
): WindowMemoryAggregate {
  return {
    windowId,
    windowName: windowId,
    panes: 1,
    scopes: ['tmux-spawn-aaa.scope'],
    current: 1024,
    high: 8192,
    max: 12288,
    swapMax: 4096,
    oomKills: 0,
    oomFlag: false,
    sampledAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFakeRuntime() {
  const listeners = new Set<WindowMemoryListener>();
  let current: WindowMemoryAggregate[] = [];
  let ticks = 0;
  const runtime = {
    getWindowMemory: () => current,
    getWindowMemorySupported: () => true,
    onWindowMemory: (listener: WindowMemoryListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tickWindowMemory: async () => {
      ticks += 1;
    },
  };
  return {
    runtime: runtime as unknown as DeviceSessionRuntime,
    emit(windows: WindowMemoryAggregate[]) {
      current = windows;
      for (const listener of listeners) listener(windows);
    },
    setCurrent(windows: WindowMemoryAggregate[]) {
      current = windows;
    },
    listenerCount: () => listeners.size,
    tickCount: () => ticks,
  };
}

function setup() {
  const connections = new Map<string, DeviceConnectionEntry>();
  const shareIndex = {
    visibleClients(
      clients: Iterable<GatewaySession>,
      deviceId: string,
      paneId: string | null
    ): Iterable<GatewaySession> {
      return shareVisibleClients(clients, deviceId, paneId, () => false);
    },
  };
  const broadcast = new WindowMemoryBroadcast({ connections, shareIndex });
  const fake = createFakeRuntime();
  const clients = new Set<GatewaySession>();
  const canonicalClients = new Set<GatewaySession>();
  const entry = {
    runtime: fake.runtime,
    detachRuntime: null,
    clients,
    lastSnapshot: null,
    snapshotTimer: null,
    snapshotPollTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    canonicalClients,
  } satisfies DeviceConnectionEntry;
  connections.set(DEVICE_ID, entry);
  const detach = broadcast.attach(DEVICE_ID, fake.runtime);
  return {
    broadcast,
    connections,
    entry,
    fake,
    detach,
    addSession: (target: Set<GatewaySession> = clients): BorshTestWs => {
      const session = createGatewaySession();
      session.borshState.negotiated = true;
      target.add(session);
      return session;
    },
  };
}

function decode(frame: Uint8Array) {
  const envelope = wsBorsh.decodeEnvelope(frame);
  return {
    kind: envelope.kind,
    payload: wsBorsh.decodePayload(wsBorsh.WindowMemorySchema, envelope.payload as Uint8Array),
  };
}

afterEach(() => {
  bindWindowMemoryRuntimeHost(null);
});

describe('WindowMemoryBroadcast fan-out', () => {
  test('sends WINDOW_MEMORY to the sessions holding the device only', () => {
    const { fake, addSession, connections } = setup();
    const attached = addSession();
    const canonicalOnly = addSession(connections.get(DEVICE_ID)?.canonicalClients as never);
    const stranger = createGatewaySession();
    stranger.borshState.negotiated = true;

    fake.emit([aggregate('@1', { current: 2048, sampledAt: 1_700_000_000_123, oomFlag: true })]);

    expect(stranger.sent).toHaveLength(0);
    for (const session of [attached, canonicalOnly]) {
      expect(session.sent).toHaveLength(1);
      const { kind, payload } = decode(session.sent[0]);
      expect(kind).toBe(wsBorsh.KIND_WINDOW_MEMORY);
      expect(payload).toEqual({
        deviceId: DEVICE_ID,
        windowId: '@1',
        current: 2048n,
        high: 8192n,
        max: 12288n,
        swapMax: 4096n,
        oomKills: 0,
        oomFlag: true,
        panes: 1,
        sampledAt: 1_700_000_000_123n,
      });
    }
  });

  test('one frame per changed window', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    fake.emit([aggregate('@1'), aggregate('@2', { current: 4096 })]);
    expect(session.sent).toHaveLength(2);
    expect(decode(session.sent[0]).payload.windowId).toBe('@1');
    expect(decode(session.sent[1]).payload.windowId).toBe('@2');
  });

  test('encode 失败只跳过该窗口并 warn，其余窗口继续发', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    const orig = wsBorsh.encodePayload.bind(wsBorsh);
    const spy = spyOn(wsBorsh, 'encodePayload').mockImplementation((schema, value) => {
      if ((value as { windowId?: string }).windowId === '@1') {
        throw new Error('boom');
      }
      return orig(schema, value);
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fake.emit([aggregate('@1'), aggregate('@2', { current: 4096 })]);
      expect(session.sent).toHaveLength(1);
      expect(decode(session.sent[0]).payload.windowId).toBe('@2');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        `[vibeterm][window-memory] broadcast failed device=${DEVICE_ID} window=@1: boom`
      );
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  test('never sends WINDOW_MEMORY to a share-scoped session', () => {
    const { fake, addSession, broadcast } = setup();
    const owner = addSession();
    const shared = addSession();
    shared.shareScope = SHARE_SCOPE;

    fake.emit([aggregate('@1')]);
    expect(owner.sent).toHaveLength(1);
    expect(shared.sent).toHaveLength(0);

    fake.setCurrent([aggregate('@1', { current: 9999 })]);
    broadcast.handleDeviceConnected(shared, DEVICE_ID);
    expect(shared.sent).toHaveLength(0);
  });

  test('encodes the payload once per window even with several sessions', () => {
    const { fake, addSession } = setup();
    addSession();
    addSession();
    const spy = spyOn(wsBorsh, 'encodePayload');
    try {
      fake.emit([aggregate('@1')]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('ignores samples from a runtime the entry no longer points at', () => {
    const { fake, entry, addSession } = setup();
    const session = addSession();
    entry.runtime = createFakeRuntime().runtime;
    fake.emit([aggregate('@1')]);
    expect(session.sent).toHaveLength(0);
  });

  test('uses the priority send path so terminal backpressure cannot delay it', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    const spy = spyOn(gatewayWebSocketSendGuard, 'sendPriorityFrames');
    try {
      fake.emit([aggregate('@1')]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(session.activeCarrier);
    } finally {
      spy.mockRestore();
    }
  });

  test('载体有优先通道时，背压中的会话照发', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    const carrier = session.activeCarrier as typeof session.activeCarrier & {
      sendPriority?: (bytes: Uint8Array) => 'sent';
    };
    carrier.sendPriority = (bytes) => {
      session.sent.push(bytes);
      return 'sent';
    };
    const spy = spyOn(gatewayWebSocketSendGuard, 'isBackpressured').mockImplementation(() => true);
    try {
      fake.emit([aggregate('@1')]);
      expect(session.sent).toHaveLength(1);
    } finally {
      spy.mockRestore();
      carrier.sendPriority = undefined;
    }
  });

  test('skips a session whose carrier is already backpressured', () => {
    const { fake, addSession } = setup();
    const healthy = addSession();
    const stalled = addSession();
    const spy = spyOn(gatewayWebSocketSendGuard, 'isBackpressured').mockImplementation(
      (carrier) => carrier === stalled.activeCarrier
    );
    try {
      fake.emit([aggregate('@1')]);
      expect(healthy.sent).toHaveLength(1);
      expect(stalled.sent).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('skips closed sessions', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    session.closed = true;
    fake.emit([aggregate('@1')]);
    expect(session.sent).toHaveLength(0);
  });
});

describe('WindowMemoryBroadcast session connect', () => {
  test('pushes current aggregates to a session that just connected the device', () => {
    const { fake, addSession, broadcast } = setup();
    const session = addSession();
    fake.setCurrent([aggregate('@1', { current: 77 }), aggregate('@2')]);
    broadcast.handleDeviceConnected(session, DEVICE_ID);
    expect(session.sent).toHaveLength(2);
    expect(decode(session.sent[0]).payload.current).toBe(77n);
    expect(decode(session.sent[1]).payload.windowId).toBe('@2');
  });

  test('stays quiet when there are no samples or no entry yet', () => {
    const { addSession, broadcast, connections } = setup();
    const session = addSession();
    broadcast.handleDeviceConnected(session, DEVICE_ID);
    connections.delete(DEVICE_ID);
    broadcast.handleDeviceConnected(session, DEVICE_ID);
    expect(session.sent).toHaveLength(0);
  });

  test('does not push when the session never made it into the device entry', () => {
    const { fake, broadcast } = setup();
    const session = createGatewaySession();
    session.borshState.negotiated = true;
    fake.setCurrent([aggregate('@1')]);
    broadcast.handleDeviceConnected(session, DEVICE_ID);
    expect(session.sent).toHaveLength(0);
  });
});

describe('WindowMemoryBroadcast attach and tick', () => {
  test('detach clears the subscription', () => {
    const { fake, addSession, detach } = setup();
    const session = addSession();
    expect(fake.listenerCount()).toBe(1);
    detach();
    expect(fake.listenerCount()).toBe(0);
    fake.emit([aggregate('@1')]);
    expect(session.sent).toHaveLength(0);
  });

  test('requestTickAll ticks every attached runtime', async () => {
    const { broadcast, fake } = setup();
    broadcast.requestTickAll();
    await Promise.resolve();
    expect(fake.tickCount()).toBe(1);
  });

  test('bindWindowMemoryBroadcast 把实例接到 HTTP tick/lookup', () => {
    const { broadcast, fake } = setup();
    bindWindowMemoryBroadcast(broadcast);
    expect(broadcast.getRuntime(DEVICE_ID)).toBe(fake.runtime);
  });

  test('tolerates runtimes without the window-memory API', () => {
    const connections = new Map<string, DeviceConnectionEntry>();
    const shareIndex = {
      visibleClients(clients: Iterable<GatewaySession>) {
        return clients;
      },
    };
    const broadcast = new WindowMemoryBroadcast({ connections, shareIndex });
    const runtime = {} as DeviceSessionRuntime;
    const detach = broadcast.attach(DEVICE_ID, runtime);
    expect(() => detach()).not.toThrow();
    expect(() => broadcast.requestTickAll()).not.toThrow();
  });
});
