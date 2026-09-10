import { describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import type { HostLatencyListener, HostLatencySample } from '../tmux-client/host-latency-tracker';
import {
  DEVICE_LATENCY_MIN_INTERVAL_MS,
  DEVICE_LATENCY_REFRESH_MS,
  DeviceLatencyBroadcast,
  type DeviceLatencySchedule,
} from './device-latency-broadcast';
import type { GatewaySession } from './gateway-session';
import { shareVisibleClients } from './share-gate';
import type { ShareScope } from './share-scope';
import { type BorshTestWs, createGatewaySession } from './test-helpers';
import type { DeviceConnectionEntry } from './types';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

const DEVICE_ID = 'device-a';
const SHARE_SCOPE: ShareScope = { shareId: 'sh1', deviceId: DEVICE_ID, windowId: '@1' };

function createFakeRuntime() {
  const listeners = new Set<HostLatencyListener>();
  let gate: (() => boolean) | null = null;
  let current: HostLatencySample | null = null;
  const runtime = {
    getHostLatency: () => current,
    onHostLatency: (listener: HostLatencyListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHostLatencyProbeGate: (next: (() => boolean) | null) => {
      gate = next;
    },
  };
  return {
    runtime: runtime as unknown as DeviceSessionRuntime,
    emit(sample: HostLatencySample) {
      current = sample;
      for (const listener of listeners) listener(sample);
    },
    setCurrent(sample: HostLatencySample | null) {
      current = sample;
    },
    listenerCount: () => listeners.size,
    askGate: () => gate?.() ?? null,
  };
}

function sample(rttMs: number, overrides: Partial<HostLatencySample> = {}): HostLatencySample {
  return { rttMs, rawMs: rttMs, hop: 0, sampledAt: 1_700_000_000_000, ...overrides };
}

function createScheduleClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule: DeviceLatencySchedule = {
    setTimeout: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
  };
  return {
    now: () => now,
    schedule,
    advance: (ms: number) => {
      const target = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
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
  const clock = createScheduleClock();
  const broadcast = new DeviceLatencyBroadcast(
    { connections, shareIndex },
    clock.now,
    clock.schedule
  );
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
    advance: clock.advance,
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
    payload: wsBorsh.decodePayload(
      wsBorsh.schema.DeviceLatencySchema,
      envelope.payload as Uint8Array
    ),
  };
}

describe('DeviceLatencyBroadcast fan-out', () => {
  test('sends DEVICE_LATENCY to the sessions holding the device only', () => {
    const { fake, addSession, connections } = setup();
    const attached = addSession();
    const canonicalOnly = addSession(connections.get(DEVICE_ID)?.canonicalClients as never);
    const stranger = createGatewaySession();
    stranger.borshState.negotiated = true;

    fake.emit(sample(42, { hop: 1, sampledAt: 1_700_000_000_123 }));

    expect(stranger.sent).toHaveLength(0);
    for (const session of [attached, canonicalOnly]) {
      expect(session.sent).toHaveLength(1);
      const { kind, payload } = decode(session.sent[0]);
      expect(kind).toBe(wsBorsh.KIND_DEVICE_LATENCY);
      expect(payload).toEqual({
        deviceId: DEVICE_ID,
        rttMs: 42,
        rawMs: 42,
        hop: 1,
        sampledAt: 1_700_000_000_123n,
      });
    }
  });

  test('never sends DEVICE_LATENCY to a share-scoped session', () => {
    const { fake, addSession, broadcast } = setup();
    const owner = addSession();
    const shared = addSession();
    shared.shareScope = SHARE_SCOPE;

    fake.emit(sample(42));
    expect(owner.sent).toHaveLength(1);
    expect(shared.sent).toHaveLength(0);

    fake.setCurrent(sample(77));
    broadcast.handleDeviceConnected(shared, DEVICE_ID);
    expect(shared.sent).toHaveLength(0);
  });

  test('encodes the payload once per publish even with several sessions', () => {
    const { fake, addSession } = setup();
    addSession();
    addSession();
    const spy = spyOn(wsBorsh, 'encodePayload');
    try {
      fake.emit(sample(42));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('ignores samples from a runtime the entry no longer points at', () => {
    const { fake, entry, addSession } = setup();
    const session = addSession();
    entry.runtime = createFakeRuntime().runtime;
    fake.emit(sample(30));
    expect(session.sent).toHaveLength(0);
  });

  test('uses the priority send path so terminal backpressure cannot delay it', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    const spy = spyOn(gatewayWebSocketSendGuard, 'sendPriorityFrames');
    try {
      fake.emit(sample(11));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(session.activeCarrier);
    } finally {
      spy.mockRestore();
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
      fake.emit(sample(11));
      expect(healthy.sent).toHaveLength(1);
      expect(stalled.sent).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DeviceLatencyBroadcast throttling', () => {
  test('resends only on material change after the min interval, or after the refresh window', () => {
    const { fake, addSession, advance } = setup();
    const session = addSession();

    fake.emit(sample(100));
    expect(session.sent).toHaveLength(1);

    advance(1000);
    fake.emit(sample(105));
    expect(session.sent).toHaveLength(1);

    advance(DEVICE_LATENCY_MIN_INTERVAL_MS);
    fake.emit(sample(130));
    expect(session.sent).toHaveLength(2);

    advance(1000);
    fake.emit(sample(131));
    expect(session.sent).toHaveLength(2);

    advance(DEVICE_LATENCY_REFRESH_MS);
    fake.emit(sample(131));
    expect(session.sent).toHaveLength(3);
  });

  test('0→1 ms and 1→2 ms do not publish before the min interval', () => {
    const { fake, addSession, advance } = setup();
    const session = addSession();

    fake.emit(sample(0));
    expect(session.sent).toHaveLength(1);

    advance(DEVICE_LATENCY_MIN_INTERVAL_MS - 1);
    fake.emit(sample(1));
    expect(session.sent).toHaveLength(1);
    fake.emit(sample(2));
    expect(session.sent).toHaveLength(1);
  });

  test('1→2 ms stays below the material floor even after the min interval', () => {
    const { fake, addSession, advance } = setup();
    const session = addSession();

    fake.emit(sample(1));
    advance(DEVICE_LATENCY_MIN_INTERVAL_MS);
    fake.emit(sample(2));
    expect(session.sent).toHaveLength(1);
  });

  test('1→20 ms publishes only after the min interval', () => {
    const { fake, addSession, advance } = setup();
    const session = addSession();

    fake.emit(sample(1));
    expect(session.sent).toHaveLength(1);

    advance(DEVICE_LATENCY_MIN_INTERVAL_MS - 1);
    fake.emit(sample(20));
    expect(session.sent).toHaveLength(1);

    advance(1);
    fake.emit(sample(20));
    expect(session.sent).toHaveLength(2);
  });

  test('sub-floor local hops still refresh after 15 s', () => {
    const { fake, addSession, advance } = setup();
    const session = addSession();

    fake.emit(sample(0));
    advance(DEVICE_LATENCY_MIN_INTERVAL_MS);
    fake.emit(sample(1));
    expect(session.sent).toHaveLength(1);

    advance(DEVICE_LATENCY_REFRESH_MS - DEVICE_LATENCY_MIN_INTERVAL_MS);
    fake.emit(sample(2));
    expect(session.sent).toHaveLength(2);
  });

  test('does not remember a send when nobody received it', () => {
    const { fake, addSession, advance } = setup();
    fake.emit(sample(100));
    const session = addSession();
    advance(100);
    fake.emit(sample(101));
    expect(session.sent).toHaveLength(1);
  });

  test('re-emits the last sample every 15 s while a session is attached, and stops after detach', () => {
    const { fake, addSession, advance, detach } = setup();
    const session = addSession();

    fake.emit(sample(42, { sampledAt: 1_700_000_000_000 }));
    expect(session.sent).toHaveLength(1);

    advance(DEVICE_LATENCY_REFRESH_MS);
    expect(session.sent).toHaveLength(2);
    advance(DEVICE_LATENCY_REFRESH_MS);
    expect(session.sent).toHaveLength(3);
    advance(DEVICE_LATENCY_REFRESH_MS);
    expect(session.sent).toHaveLength(4);
    expect(decode(session.sent[3]).payload.rttMs).toBe(42);

    detach();
    advance(DEVICE_LATENCY_REFRESH_MS * 2);
    expect(session.sent).toHaveLength(4);
  });
});

describe('DeviceLatencyBroadcast session connect', () => {
  test('pushes the existing estimate to a session that just connected the device', () => {
    const { fake, addSession, broadcast } = setup();
    const session = addSession();
    fake.setCurrent(sample(77));
    broadcast.handleDeviceConnected(session, DEVICE_ID);
    expect(decode(session.sent[0]).payload.rttMs).toBe(77);
  });

  test('stays quiet when there is no estimate or no entry yet', () => {
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
    fake.setCurrent(sample(77));
    broadcast.handleDeviceConnected(session, DEVICE_ID);
    expect(session.sent).toHaveLength(0);
  });

  test('skips closed sessions', () => {
    const { fake, addSession } = setup();
    const session = addSession();
    session.closed = true;
    fake.emit(sample(50));
    expect(session.sent).toHaveLength(0);
  });
});

describe('DeviceLatencyBroadcast probe gate', () => {
  test('opens only while a session holds the device', () => {
    const { fake, entry, addSession } = setup();
    expect(fake.askGate()).toBe(false);
    const session = addSession();
    expect(fake.askGate()).toBe(true);
    entry.clients.delete(session);
    expect(fake.askGate()).toBe(false);
    entry.canonicalClients?.add(session);
    expect(fake.askGate()).toBe(true);
  });

  test('detach clears the gate and the subscription', () => {
    const { fake, addSession, detach } = setup();
    const session = addSession();
    expect(fake.listenerCount()).toBe(1);
    detach();
    expect(fake.askGate()).toBe(null);
    expect(fake.listenerCount()).toBe(0);
    fake.emit(sample(20));
    expect(session.sent).toHaveLength(0);
  });

  test('tolerates runtimes without the latency API', () => {
    const connections = new Map<string, DeviceConnectionEntry>();
    const shareIndex = {
      visibleClients(clients: Iterable<GatewaySession>) {
        return clients;
      },
    };
    const broadcast = new DeviceLatencyBroadcast({ connections, shareIndex });
    const runtime = {} as DeviceSessionRuntime;
    const detach = broadcast.attach(DEVICE_ID, runtime);
    expect(() => detach()).not.toThrow();
  });
});
