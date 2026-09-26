import { beforeEach, describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import type { InboundRelayHandler, PooledUplink } from './types';
import {
  UPLINK_RELAY_DRAIN_TIMEOUT_MS,
  UplinkRelayDrain,
  bindRelayDrainOwner,
  noteRelayCarriedStream,
  resetRelayCarriedStreamsForTest,
} from './uplink-relay-drain';

function fakeClient(uplinkUrl: string): PooledUplink & {
  handler: InboundRelayHandler | null;
  resets: string[];
  emit(from: string): void;
  stop: () => Promise<void>;
} {
  const client = {
    uplinkUrl,
    state: 'online' as const,
    link: {},
    handler: null as InboundRelayHandler | null,
    resets: [] as string[],
    setOnRelayStream(handler: InboundRelayHandler | null) {
      client.handler = handler;
    },
    emit(from: string) {
      const stream = {
        closed: Promise.resolve(),
        reset: (reason?: string) => client.resets.push(reason ?? ''),
      } as unknown as LinkStream;
      client.handler?.(stream, from, uplinkUrl);
    },
    async stop() {},
  };
  return client as unknown as PooledUplink & {
    handler: InboundRelayHandler | null;
    resets: string[];
    emit(from: string): void;
    stop: () => Promise<void>;
  };
}

function heldStream(): { stream: LinkStream; finish(): void } {
  let resolve!: (info: { reason: 'end' }) => void;
  const stream = {
    id: 1,
    closed: new Promise<{ reason: 'end' }>((done) => {
      resolve = done;
    }),
  } as unknown as LinkStream;
  return { stream, finish: () => resolve({ reason: 'end' }) };
}

describe('UplinkRelayDrain inbound viaRelay', () => {
  beforeEach(() => {
    resetRelayCarriedStreamsForTest();
  });

  test('bind 把 live client 的 uplinkUrl 传给入站 handler', () => {
    const drain = new UplinkRelayDrain({
      scheduler: { now: () => 1, sleep: async () => undefined, interval: () => ({ clear() {} }) },
      log: () => {},
    });
    const seen: Array<{ from: string; viaRelay?: string }> = [];
    drain.setHandler((_stream, from, viaRelay) => {
      seen.push({ from, viaRelay });
    });
    const client = fakeClient('https://sh.example');
    drain.bind(client, () => true);
    client.emit('aa'.repeat(16));
    expect(seen).toEqual([{ from: 'aa'.repeat(16), viaRelay: 'https://sh.example' }]);
  });

  test('count is carried user streams, and the grace cap is 30s', () => {
    expect(UPLINK_RELAY_DRAIN_TIMEOUT_MS).toBe(30_000);
    const drain = new UplinkRelayDrain({
      scheduler: { now: () => 1, sleep: async () => undefined, interval: () => ({ clear() {} }) },
      log: () => {},
    });
    const client = fakeClient('https://sh.example');
    expect(drain.inFlight(client)).toBe(0);
    drain.track(client, { closed: Promise.resolve() } as unknown as LinkStream);
    expect(drain.inFlight(client)).toBe(0);
    const user = heldStream();
    noteRelayCarriedStream(client.uplinkUrl, user.stream);
    expect(drain.inFlight(client)).toBe(1);
    user.finish();
  });

  test('retire resets new inbound instead of accepting it', () => {
    const drain = new UplinkRelayDrain({
      scheduler: { now: () => 1, sleep: async () => undefined, interval: () => ({ clear() {} }) },
      log: () => {},
    });
    const seen: string[] = [];
    drain.setHandler((_stream, from) => {
      seen.push(from);
    });
    const client = fakeClient('https://drain.example');
    drain.bind(client, () => false);
    drain.retire(client);
    client.emit('bb'.repeat(16));
    expect(seen).toEqual([]);
    expect(client.resets).toEqual(['stale']);
  });

  test('carried streams are counted on the client that owned the URL when noted', () => {
    const drain = new UplinkRelayDrain({
      scheduler: { now: () => 1, sleep: async () => undefined, interval: () => ({ clear() {} }) },
      log: () => {},
    });
    const old = fakeClient('https://same.example');
    const next = fakeClient('https://same.example');
    bindRelayDrainOwner(old, old.uplinkUrl);
    bindRelayDrainOwner(next, next.uplinkUrl);
    const early = heldStream();
    noteRelayCarriedStream(old, early.stream);
    const late = heldStream();
    noteRelayCarriedStream(old.uplinkUrl, late.stream);
    expect(drain.inFlight(old)).toBe(1);
    expect(drain.inFlight(next)).toBe(1);
    early.finish();
    late.finish();
  });

  test('drain returns when carried streams end, or at the grace cap', async () => {
    let now = 0;
    const drain = new UplinkRelayDrain({
      scheduler: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        interval: () => ({ clear() {} }),
      },
      timeoutMs: 30_000,
      recheckMs: 5_000,
      log: () => {},
    });
    const client = fakeClient('https://grace.example');
    const user = heldStream();
    noteRelayCarriedStream(client.uplinkUrl, user.stream);
    const waiting = drain.waitForClient(client, 'auto-select');
    const early = Promise.race([
      waiting.then(() => 'done'),
      Promise.resolve().then(() => 'pending'),
    ]);
    expect(await early).toBe('pending');
    user.finish();
    await waiting;

    const stuck = heldStream();
    noteRelayCarriedStream(client.uplinkUrl, stuck.stream);
    now = 0;
    await drain.waitForClient(client, 'switch-back');
    expect(now).toBeGreaterThanOrEqual(30_000);
    stuck.finish();
  });
});
