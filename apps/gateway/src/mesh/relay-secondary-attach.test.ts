import { describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import { RelayPresence } from './relay-presence';
import {
  RelaySecondaryAttach,
  type RelaySecondaryRow,
  type SecondaryUplink,
} from './relay-secondary-attach';
import { waitUntil } from './test-support';
import type { InboundRelayHandler, MeshScheduler, UplinkState } from './types';

const SH = 'https://sh.example';
const TK = 'https://tk.example';
const SG = 'https://sg.example';
const PEER = 'ab'.repeat(16);

class ParkScheduler implements MeshScheduler {
  nowMs = 1_000;
  readonly sleeps: Array<{
    ms: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        ms,
        resolve: () => {
          resolve();
        },
        reject,
      };
      this.sleeps.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          const idx = this.sleeps.indexOf(entry);
          if (idx >= 0) this.sleeps.splice(idx, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true }
      );
    });
  }

  interval(fn: () => void, _ms: number): { clear: () => void } {
    return { clear() {}, fn } as { clear: () => void };
  }

  flushSleeps(): void {
    const queued = this.sleeps.splice(0);
    for (const entry of queued) entry.resolve();
  }
}

class FakeSecondary implements SecondaryUplink {
  state: UplinkState = 'offline';
  rttMs: number | null = null;
  quota = null;
  rtc = { stun: [] as string[], turn: null };
  nodesViaRelay = 0;
  awaitingToken = false;
  lastConnectError: { reason: string; at: number } | null = null;
  started = 0;
  stopped = 0;
  connects = 0;
  failNext = false;
  private readonly listeners: Array<(state: UplinkState) => void> = [];
  private closed: { resolve: () => void } | null = null;
  private closedPromise: Promise<void> | null = null;
  relayHandler: InboundRelayHandler | null = null;

  constructor(readonly hubUrl: string) {}

  start(): void {
    this.started += 1;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.setState('offline');
    this.releaseClosed();
  }

  async attemptConnect(signal?: AbortSignal): Promise<void> {
    this.connects += 1;
    if (signal?.aborted) throw new Error('aborted');
    if (this.failNext) {
      this.failNext = false;
      this.setState('offline');
      throw new Error('connect-failed');
    }
    this.setState('online');
  }

  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'online') return Promise.resolve();
    if (signal?.aborted) return Promise.resolve();
    this.closedPromise ??= new Promise((resolve) => {
      this.closed = { resolve };
    });
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          this.releaseClosed();
        },
        { once: true }
      );
    }
    return this.closedPromise;
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
  }

  emitInbound(from: string): void {
    this.relayHandler?.({} as never, from);
  }

  sendStatus(): void {}
  sendCtl(): void {}
  async openRelay(_to: string): Promise<LinkStream> {
    return { id: this.hubUrl } as unknown as LinkStream;
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  disconnect(): void {
    this.setState('offline');
    this.releaseClosed();
  }

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.listeners) cb(state);
  }

  private releaseClosed(): void {
    this.closed?.resolve();
    this.closed = null;
    this.closedPromise = null;
  }
}

function row(
  url: string,
  priority: number,
  extra: Partial<Pick<RelaySecondaryRow, 'kicked' | 'credentialKey'>> = {}
): RelaySecondaryRow {
  return {
    url,
    priority,
    kicked: extra.kicked ?? false,
    credentialKey: extra.credentialKey ?? 'k',
  };
}

function setup(
  rows: RelaySecondaryRow[],
  primary: string | null,
  extra?: { onRelayStream?: InboundRelayHandler }
) {
  const scheduler = new ParkScheduler();
  const presence = new RelayPresence();
  const spawned: FakeSecondary[] = [];
  const liveRows = { current: rows };
  const livePrimary = { current: primary };
  const primaryOpens: string[] = [];
  const manager = new RelaySecondaryAttach({
    rows: () => liveRows.current,
    primaryUrl: () => livePrimary.current,
    spawn: (url) => {
      const client = new FakeSecondary(url);
      spawned.push(client);
      return client;
    },
    presence,
    scheduler,
    openPrimary: async (peer) => {
      primaryOpens.push(peer);
      return { id: 'primary' } as unknown as LinkStream;
    },
    staleMs: 50,
    ...(extra?.onRelayStream ? { onRelayStream: extra.onRelayStream } : {}),
  });
  return { manager, presence, spawned, liveRows, livePrimary, primaryOpens, scheduler };
}

describe('RelaySecondaryAttach', () => {
  test('单中继不造 secondary', async () => {
    const { manager, spawned } = setup([row(SH, 0)], SH);
    manager.start();
    await manager.reconcile();
    expect(spawned).toHaveLength(0);
    await manager.stop();
  });

  test('primary 尚未挂上时不把唯一行当 secondary', async () => {
    const { manager, spawned, livePrimary } = setup([row(SH, 0)], null);
    manager.start();
    await manager.reconcile();
    expect(spawned).toHaveLength(0);
    livePrimary.current = SH;
    await manager.reconcile();
    expect(spawned).toHaveLength(0);
    await manager.stop();
  });

  test('行变化时挂上/拆掉 secondary', async () => {
    const { manager, spawned, liveRows, presence } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    expect(spawned.map((c) => c.hubUrl)).toEqual([TK]);
    expect(presence.snapshot().find((entry) => entry.url === TK)?.connected).toBe(true);

    liveRows.current = [row(SH, 0), row(TK, 1), row(SG, 2)];
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === SG && c.state === 'online'));

    liveRows.current = [row(SH, 0), row(SG, 2)];
    await manager.reconcile();
    await waitUntil(() => manager.client(TK) == null);
    expect(manager.client(SG)?.state).toBe('online');
    await manager.stop();
  });

  test('primary 切换：旧 primary 变 secondary，新 primary 从 secondary 提升', async () => {
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    const tokyo = spawned.find((c) => c.hubUrl === TK);
    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => manager.client(TK) == null);
    await waitUntil(() => manager.client(SH)?.state === 'online');
    expect(tokyo?.stopped).toBeGreaterThan(0);
    await manager.stop();
  });

  test('连接失败后退避重连', async () => {
    const { manager, spawned, scheduler } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.length >= 1);
    const first = spawned[0];
    if (!first) throw new Error('missing spawn');
    first.disconnect();
    await waitUntil(() => scheduler.sleeps.length > 0);
    first.failNext = false;
    scheduler.flushSleeps();
    await waitUntil(() => spawned.length >= 2 && spawned[1]?.state === 'online');
    await manager.stop();
  });

  test('kicked 行拆掉且不再重连', async () => {
    const { manager, spawned, liveRows } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.state === 'online'));
    liveRows.current = [row(SH, 0), row(TK, 1, { kicked: true })];
    manager.noteKicked(TK);
    await waitUntil(() => manager.client(TK) == null);
    expect(spawned.filter((c) => c.hubUrl === TK).length).toBe(1);
    await manager.stop();
  });

  test('openRelayVia：primary 走 openPrimary，secondary 走该 client', async () => {
    const { manager, spawned, primaryOpens } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.state === 'online'));
    await manager.openRelayVia(SH, PEER);
    expect(primaryOpens).toEqual([PEER]);
    const stream = await manager.openRelayVia(TK, PEER);
    expect((stream as unknown as { id: string }).id).toBe(TK);
    await manager.stop();
  });

  test('入站 OPEN 把该 secondary 的 URL 传给 onRelayStream', async () => {
    const inbound: Array<{ from: string; viaRelay?: string }> = [];
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1)], SH, {
      onRelayStream: (_stream, from, viaRelay) => {
        inbound.push({ from, viaRelay });
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    const tokyo = spawned.find((c) => c.hubUrl === TK);
    tokyo?.emitInbound(PEER);
    expect(inbound).toEqual([{ from: PEER, viaRelay: TK }]);
    await manager.stop();
  });

  test('path-rerace 把 slot.attempt 归零并立刻重连', async () => {
    const { manager, spawned, scheduler } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    const first = spawned.find((c) => c.hubUrl === TK);
    expect(first).toBeTruthy();
    first!.lastConnectError = { reason: 'path-rerace', at: 1 };
    first!.disconnect();
    await waitUntil(() => spawned.filter((c) => c.hubUrl === TK).length >= 2);
    expect(scheduler.sleeps).toEqual([]);
    expect(spawned.filter((c) => c.hubUrl === TK).at(-1)?.state).toBe('online');
    await manager.stop();
  });

  test('secondary 令牌轮换：拆掉旧 slot 并用新凭证重挂，其他行不动', async () => {
    const { manager, spawned, liveRows } = setup(
      [
        row(SH, 0, { credentialKey: 'p' }),
        row(TK, 1, { credentialKey: 'tk-1' }),
        row(SG, 2, { credentialKey: 'sg-1' }),
      ],
      SH
    );
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.filter((c) => c.state === 'online').length >= 2);
    const tokyo = spawned.find((c) => c.hubUrl === TK);
    const singapore = spawned.find((c) => c.hubUrl === SG);
    if (!tokyo || !singapore) throw new Error('missing secondary');
    expect(tokyo.state).toBe('online');
    expect(singapore.state).toBe('online');

    liveRows.current = [
      row(SH, 0, { credentialKey: 'p' }),
      row(TK, 1, { credentialKey: 'tk-2' }),
      row(SG, 2, { credentialKey: 'sg-1' }),
    ];
    await manager.reconcile();
    await waitUntil(() => tokyo.stopped > 0);
    await waitUntil(() =>
      spawned.some((c) => c.hubUrl === TK && c !== tokyo && c.state === 'online')
    );
    expect(manager.client(TK)).not.toBe(tokyo);
    expect(manager.client(TK)?.state).toBe('online');
    expect(manager.client(SG)).toBe(singapore);
    expect(singapore.stopped).toBe(0);
    expect(spawned.filter((c) => c.hubUrl === TK)).toHaveLength(2);
    expect(spawned.filter((c) => c.hubUrl === SG)).toHaveLength(1);
    await manager.stop();
  });
});
