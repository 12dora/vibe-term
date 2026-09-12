import { describe, expect, test } from 'bun:test';
import { WS_DIAL_RACE_MAX } from './ws-dial-race-config';
import {
  type WsDialContext,
  raceWebSocketOpen,
  withWsOpenRace,
  wsRaceCountForUrl,
} from './ws-open-race';

type Listener = (ev: Event) => void;

class FakeSocket {
  readyState = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener, _opts?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit('open', {});
  }

  fail(message: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('error', { message });
  }

  get closed(): boolean {
    return this.closeCalls.length > 0;
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, []);
    for (const fn of list) fn(payload as unknown as Event);
  }
}

function fakeFactory(): { factory: () => FakeSocket; made: FakeSocket[] } {
  const made: FakeSocket[] = [];
  return {
    made,
    factory: () => {
      const ws = new FakeSocket();
      made.push(ws);
      return ws;
    },
  };
}

function clock(steps: number[]): () => number {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)] ?? 0;
}

describe('raceWebSocketOpen', () => {
  test('count<=1 is a plain factory call with no logging', async () => {
    const { factory, made } = fakeFactory();
    const lines: string[] = [];
    const ws = await raceWebSocketOpen(factory, 'ws://host.example:39001/peer', {
      count: 1,
      log: (line) => lines.push(line),
    });
    expect(made).toHaveLength(1);
    expect(ws).toBe(made[0] as FakeSocket);
    expect(ws.readyState).toBe(0);
    expect(lines).toEqual([]);
  });

  test('first socket to open wins and the losers are closed unsent', async () => {
    const { factory, made } = fakeFactory();
    const lines: string[] = [];
    const pending = raceWebSocketOpen(factory, 'ws://host.example:39001/peer', {
      count: 3,
      log: (line) => lines.push(line),
      now: clock([0, 90]),
    });
    await Promise.resolve();
    expect(made).toHaveLength(3);
    made[1]?.open();
    const winner = await pending;
    expect(winner).toBe(made[1] as FakeSocket);
    expect(made[0]?.closed).toBe(true);
    expect(made[2]?.closed).toBe(true);
    expect(made[0]?.closeCalls[0]?.reason).toBe('ws-race-loser');
    expect(winner.closed).toBe(false);
    expect(lines).toEqual([
      '[mesh][dial] ws race url=host.example winner_ms=90 others_ms=- count=3',
    ]);
  });

  test('a runner-up that settled before the winner shows up in others_ms', async () => {
    const { factory, made } = fakeFactory();
    const lines: string[] = [];
    const pending = raceWebSocketOpen(factory, 'wss://hub.example.com/uplink', {
      count: 2,
      log: (line) => lines.push(line),
      now: clock([0, 40, 180]),
    });
    await Promise.resolve();
    made[0]?.fail('refused');
    await Promise.resolve();
    made[1]?.open();
    const winner = await pending;
    expect(winner).toBe(made[1] as FakeSocket);
    expect(lines).toEqual([
      '[mesh][dial] ws race url=hub.example.com winner_ms=180 others_ms=40 count=2',
    ]);
  });

  test('rejects with the last error when every socket fails', async () => {
    const { factory, made } = fakeFactory();
    const pending = raceWebSocketOpen(factory, 'ws://host.example:39001/peer', { count: 2 });
    await Promise.resolve();
    made[0]?.fail('refused');
    made[1]?.fail('unreachable');
    await expect(pending).rejects.toThrow(/unreachable|refused/);
  });

  test('a factory that throws counts as a failed lane', async () => {
    let calls = 0;
    const made: FakeSocket[] = [];
    const factory = () => {
      calls += 1;
      if (calls === 1) throw new Error('dns-fail');
      const ws = new FakeSocket();
      made.push(ws);
      return ws;
    };
    const pending = raceWebSocketOpen(factory, 'ws://host.example:39001/peer', { count: 2 });
    await Promise.resolve();
    made[0]?.open();
    expect(await pending).toBe(made[0] as FakeSocket);
  });

  test('abort closes every socket and rejects', async () => {
    const { factory, made } = fakeFactory();
    const ac = new AbortController();
    const pending = raceWebSocketOpen(factory, 'ws://host.example:39001/peer', {
      count: 2,
      signal: ac.signal,
    });
    await Promise.resolve();
    ac.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(made[0]?.closed).toBe(true);
    expect(made[1]?.closed).toBe(true);
  });

  test('an already aborted signal rejects without dialing', async () => {
    const { factory, made } = fakeFactory();
    const ac = new AbortController();
    ac.abort(new Error('stopped'));
    await expect(
      raceWebSocketOpen(factory, 'ws://host.example:39001/peer', { count: 2, signal: ac.signal })
    ).rejects.toThrow('stopped');
    expect(made).toHaveLength(0);
  });

  test('a socket created after the race settled is closed right away', async () => {
    const made: FakeSocket[] = [];
    const late: Array<() => void> = [];
    const factory = () => {
      const ws = new FakeSocket();
      made.push(ws);
      if (made.length === 2) {
        return new Promise<FakeSocket>((resolve) => late.push(() => resolve(ws)));
      }
      return ws;
    };
    const pending = raceWebSocketOpen(factory, 'ws://host.example:39001/peer', { count: 2 });
    await Promise.resolve();
    made[0]?.open();
    expect(await pending).toBe(made[0] as FakeSocket);
    late[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(made[1]?.closed).toBe(true);
  });

  test('every lane honours the open timeout instead of hanging', async () => {
    const { factory } = fakeFactory();
    await expect(
      raceWebSocketOpen(factory, 'ws://host.example:39001/peer', { count: 2, timeoutMs: 5 })
    ).rejects.toThrow('connect-timeout');
  });
});

describe('wsRaceCountForUrl', () => {
  test('private destinations are never raced', () => {
    expect(wsRaceCountForUrl('ws://127.0.0.1:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://localhost:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://192.168.1.9:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://10.0.0.3:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://172.20.0.3:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://169.254.1.2:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://[::1]:39001/peer', 3)).toBe(1);
    expect(wsRaceCountForUrl('ws://[fe80::1]:39001/peer', 3)).toBe(1);
  });

  test('public destinations race and stay inside the clamp', () => {
    expect(wsRaceCountForUrl('wss://hub.example.com/uplink', 3)).toBe(3);
    expect(wsRaceCountForUrl('ws://203.0.113.7:39001/peer', 2)).toBe(2);
    expect(wsRaceCountForUrl('wss://hub.example.com/uplink', 99)).toBe(WS_DIAL_RACE_MAX);
    expect(wsRaceCountForUrl('wss://hub.example.com/uplink', 0)).toBe(1);
  });
});

describe('withWsOpenRace', () => {
  test('passes the caller signal and connect budget into the race', async () => {
    const { factory, made } = fakeFactory();
    const raced = withWsOpenRace(factory, { count: 2, now: clock([0, 12]) });
    const ac = new AbortController();
    const ctx: WsDialContext = { signal: ac.signal, timeoutMs: 5 };
    const pending = raced('wss://hub.example.com/uplink', ctx);
    await Promise.resolve();
    expect(made).toHaveLength(2);
    made[0]?.open();
    expect(await pending).toBe(made[0] as FakeSocket);
  });

  test('lan targets stay single-socket even with a race count', async () => {
    const { factory, made } = fakeFactory();
    const raced = withWsOpenRace(factory, { count: 4 });
    const ws = await raced('ws://127.0.0.1:39001/peer');
    expect(made).toHaveLength(1);
    expect(ws).toBe(made[0] as FakeSocket);
  });
});
