import { describe, expect, test } from 'bun:test';
import { type WebSocketTransportInput, createInMemoryLinkPair } from '@tmex/shared/link';
import {
  DirectDialLimiter,
  type WsSecureCandidate,
  classifyWsDialFailure,
  connectWsTransport,
  dialWsSecureCandidate,
  raceWsSecureEndpoints,
} from './peer-ws-race';
import { fakeSocketPair } from './test-support';
import { PeerHandshakeError } from './types';

describe('peer-ws-race', () => {
  test('same-turn two handshakes elect the first candidate and close only the loser', async () => {
    const [sessionA] = createInMemoryLinkPair();
    const [sessionB] = createInMemoryLinkPair();
    const keysA = { sendKey: new Uint8Array([1]), recvKey: new Uint8Array([2]) };
    const keysB = { sendKey: new Uint8Array([3]), recvKey: new Uint8Array([4]) };
    const dial = async (url: string): Promise<WsSecureCandidate> =>
      url.endsWith('/a')
        ? { session: sessionA, peerNodeId: 'peer', url, ...keysA }
        : { session: sessionB, peerNodeId: 'peer', url, ...keysB };
    const result = await raceWsSecureEndpoints({
      urls: ['ws://127.0.0.1:1/a', 'ws://127.0.0.1:2/b'],
      gen: 1,
      signal: new AbortController().signal,
      stale: () => false,
      sleep: async () => undefined,
      staggerMs: 0,
      dial,
    });
    expect(result.winner?.session).toBe(sessionA);
    expect(result.winner?.sendKey).toEqual(keysA.sendKey);
    expect(result.winner?.recvKey).toEqual(keysA.recvKey);
    const bClosed = await Promise.race([
      sessionB.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(bClosed).toBe(true);
    const aClosed = await Promise.race([
      sessionA.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(aClosed).toBe(false);
  });

  test('aborted connect closes a factory socket that resolves later', async () => {
    const ac = new AbortController();
    let resolveLate: ((ws: ReturnType<typeof fakeSocketPair>[0]) => void) | undefined;
    const pending = connectWsTransport({
      factory: () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
      url: 'ws://127.0.0.1:1/peer',
      signal: ac.signal,
      connectTimeoutMs: 5_000,
    });
    ac.abort();
    await expect(pending).rejects.toThrow();
    const [ws] = fakeSocketPair();
    resolveLate?.(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.closed).toBe(true);
  });

  test('parent abort after electing a winner closes it and returns no winner', async () => {
    const [sessionA] = createInMemoryLinkPair();
    const parent = new AbortController();
    const result = await raceWsSecureEndpoints({
      urls: ['ws://127.0.0.1:1/a', 'ws://127.0.0.1:2/b'],
      gen: 1,
      signal: parent.signal,
      stale: () => parent.signal.aborted,
      staggerMs: 50,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            parent.abort();
            reject(signal.reason ?? new Error('aborted'));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      dial: async (url): Promise<WsSecureCandidate> => {
        if (!url.endsWith('/a')) throw new Error('staggered candidate should not dial');
        return {
          session: sessionA,
          peerNodeId: 'peer',
          url,
          sendKey: new Uint8Array([1]),
          recvKey: new Uint8Array([2]),
        };
      },
    });
    expect(result.winner).toBeNull();
    const closed = await Promise.race([
      sessionA.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(closed).toBe(true);
  });

  test('parent abort rejects pending stagger sleeps and does not dial later candidates', async () => {
    const parent = new AbortController();
    const dialed: string[] = [];
    const pendingSleeps: Array<{ rejected: boolean }> = [];
    let held = 0;
    let sleepsReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      sleepsReady = resolve;
    });
    const resultP = raceWsSecureEndpoints({
      urls: ['ws://127.0.0.1:1/a', 'ws://127.0.0.1:2/b', 'ws://127.0.0.1:3/c'],
      gen: 1,
      signal: parent.signal,
      stale: () => parent.signal.aborted,
      staggerMs: 250,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          const row = { rejected: false };
          pendingSleeps.push(row);
          const onAbort = () => {
            row.rejected = true;
            reject(signal.reason ?? new Error('aborted'));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          held += 1;
          if (held === 2) sleepsReady();
        }),
      dial: async (url, signal) => {
        dialed.push(url);
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
        return null;
      },
    });
    await ready;
    expect(dialed).toEqual(['ws://127.0.0.1:1/a']);
    parent.abort();
    const result = await resultP;
    expect(result.winner).toBeNull();
    expect(pendingSleeps).toHaveLength(2);
    expect(pendingSleeps.every((row) => row.rejected)).toBe(true);
    expect(dialed).toEqual(['ws://127.0.0.1:1/a']);
  });

  test('duplicate and IPv4-mapped URLs of the same host:port only dial once', async () => {
    const dialed: string[] = [];
    const result = await raceWsSecureEndpoints({
      urls: [
        'ws://10.0.0.1:39001/peer',
        'ws://10.0.0.1:39001/peer',
        'ws://[::ffff:10.0.0.1]:39001/x',
        'ws://10.0.0.2:39001/peer',
      ],
      gen: 1,
      signal: new AbortController().signal,
      stale: () => false,
      sleep: async () => undefined,
      staggerMs: 0,
      dial: async (url): Promise<WsSecureCandidate> => {
        dialed.push(url);
        const [row] = createInMemoryLinkPair();
        return { session: row, peerNodeId: 'peer', url };
      },
    });
    expect(dialed).toEqual(['ws://10.0.0.1:39001/peer', 'ws://10.0.0.2:39001/peer']);
    expect(result.winner?.url).toBe('ws://10.0.0.1:39001/peer');
  });
});

describe('classifyWsDialFailure', () => {
  const url = 'ws://10.0.0.1:1/peer';
  test('maps transport vs protocol failures', () => {
    expect(classifyWsDialFailure(url, new Error('connect-timeout')).kind).toBe('open-timeout');
    expect(classifyWsDialFailure(url, new Error('ECONNREFUSED')).kind).toBe('refused');
    expect(
      classifyWsDialFailure(url, Object.assign(new Error('no route'), { code: 'ENETUNREACH' })).kind
    ).toBe('unreachable');
    expect(classifyWsDialFailure(url, new Error('ECONNRESET')).kind).toBe('reset');
    expect(
      classifyWsDialFailure(url, new PeerHandshakeError('timeout', 'peer handshake timed out')).kind
    ).toBe('timeout');
    expect(classifyWsDialFailure(url, new PeerHandshakeError('bad_signature', 'sig')).kind).toBe(
      'protocol'
    );
    expect(classifyWsDialFailure(url, new Error('aborted')).kind).toBe('aborted');
  });
});

describe('DirectDialLimiter', () => {
  test('caps concurrent holders and hands the slot to the next waiter', async () => {
    const limiter = new DirectDialLimiter(1);
    await limiter.acquire(new AbortController().signal);
    expect(limiter.active).toBe(1);
    let second = false;
    const waiting = limiter.acquire(new AbortController().signal).then(() => {
      second = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBe(false);
    limiter.release();
    await waiting;
    expect(second).toBe(true);
    expect(limiter.active).toBe(1);
    limiter.release();
    expect(limiter.active).toBe(0);
  });

  test('abort while queued does not take a slot', async () => {
    const limiter = new DirectDialLimiter(1);
    await limiter.acquire(new AbortController().signal);
    const ac = new AbortController();
    const pending = limiter.acquire(ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow();
    limiter.release();
    expect(limiter.active).toBe(0);
  });
});

function hangingTransport(): WebSocketTransportInput & { closed: boolean } {
  const obj = {
    closed: false,
    readyState: 0,
    addEventListener(_type: string, _cb: () => void) {},
    close() {
      obj.closed = true;
    },
  };
  return obj as unknown as WebSocketTransportInput & { closed: boolean };
}

describe('dialWsSecureCandidate budgets and limiter', () => {
  const dummyIdentity = { nodeId: '00'.repeat(16), edSecretKey: new Uint8Array(32) };
  const dummyStore = {} as import('../auth/user-store').UserStore;

  test('totalTimeoutMs aborts a never-opening socket and classifies timeout', async () => {
    const ws = hangingTransport();
    const limiter = new DirectDialLimiter(4);
    const t0 = Date.now();
    await expect(
      dialWsSecureCandidate({
        url: 'ws://203.0.113.9:1/peer',
        expectedId: dummyIdentity.nodeId,
        gen: 1,
        signal: new AbortController().signal,
        stale: () => false,
        connectTimeoutMs: 5_000,
        totalTimeoutMs: 40,
        factory: () => ws,
        identity: dummyIdentity,
        userStore: dummyStore,
        limiter,
      })
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(ws.closed).toBe(true);
    expect(limiter.active).toBe(0);
  });

  test('LAN handshake budget closes a connected socket that never handshakes', async () => {
    const [a] = fakeSocketPair();
    const limiter = new DirectDialLimiter(4);
    const t0 = Date.now();
    await expect(
      dialWsSecureCandidate({
        url: 'ws://10.0.0.8:1/peer',
        expectedId: dummyIdentity.nodeId,
        gen: 1,
        signal: new AbortController().signal,
        stale: () => false,
        connectTimeoutMs: 5_000,
        totalTimeoutMs: 40,
        factory: () => a,
        identity: dummyIdentity,
        userStore: dummyStore,
        limiter,
      })
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(a.closed).toBe(true);
    expect(limiter.active).toBe(0);
  });

  test('process limiter serializes socket opens across candidates', async () => {
    const limiter = new DirectDialLimiter(1);
    let inflight = 0;
    let max = 0;
    const hold = new AbortController();
    const start = (url: string) =>
      dialWsSecureCandidate({
        url,
        expectedId: dummyIdentity.nodeId,
        gen: 1,
        signal: hold.signal,
        stale: () => false,
        connectTimeoutMs: 5_000,
        factory: async () => {
          inflight += 1;
          max = Math.max(max, inflight);
          await new Promise<never>((_resolve, reject) => {
            hold.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
          return hangingTransport();
        },
        identity: dummyIdentity,
        userStore: dummyStore,
        limiter,
      });
    const a = start('ws://203.0.113.1:1/peer');
    const b = start('ws://203.0.113.2:1/peer');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(max).toBe(1);
    hold.abort();
    await Promise.allSettled([a, b]);
    expect(limiter.active).toBe(0);
  });
});
