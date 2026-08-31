import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { type WsSecureCandidate, connectWsTransport, raceWsSecureEndpoints } from './peer-ws-race';
import { fakeSocketPair } from './test-support';

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
      urls: ['ws://127.0.0.1:1/a', 'ws://127.0.0.1:1/b'],
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
      urls: ['ws://127.0.0.1:1/a', 'ws://127.0.0.1:1/b'],
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
});
