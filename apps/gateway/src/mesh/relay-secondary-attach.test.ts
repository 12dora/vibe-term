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

  connectGate: Promise<void> | null = null;

  async attemptConnect(signal?: AbortSignal): Promise<void> {
    this.connects += 1;
    if (signal?.aborted) throw new Error('aborted');
    if (this.connectGate) {
      const gate = this.connectGate;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        void gate.then(
          () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          (err) => {
            signal?.removeEventListener('abort', onAbort);
            reject(err instanceof Error ? err : new Error('aborted'));
          }
        );
      });
      if (signal?.aborted) throw new Error('aborted');
    }
    if (this.failNext) {
      this.failNext = false;
      this.lastConnectError = { reason: 'connect-failed', at: 1 };
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
  extra?: {
    onRelayStream?: InboundRelayHandler;
    onSpawn?: (client: FakeSecondary, spawned: FakeSecondary[]) => void;
    primaryUrl?: (livePrimary: string | null) => string | null;
  }
) {
  const scheduler = new ParkScheduler();
  const presence = new RelayPresence();
  const spawned: FakeSecondary[] = [];
  const liveRows = { current: rows };
  const livePrimary = { current: primary };
  const primaryOpens: string[] = [];
  const manager = new RelaySecondaryAttach({
    rows: () => liveRows.current,
    primaryUrl: () => extra?.primaryUrl?.(livePrimary.current) ?? livePrimary.current,
    spawn: (url) => {
      const client = new FakeSecondary(url);
      extra?.onSpawn?.(client, spawned);
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

  test('故障转移后原 primary 在退避内重挂为 secondary（事故）', async () => {
    const { manager, spawned, livePrimary, scheduler } = setup([row(SH, 0), row(TK, 1)], SH, {
      onSpawn: (client, already) => {
        if (client.hubUrl === SH && already.every((row) => row.hubUrl !== SH)) {
          client.failNext = true;
        }
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));

    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === SH));
    await waitUntil(() => scheduler.sleeps.length > 0);

    // 池 wrap 短暂把 SH 当成 primary：runLoop 看到 stillWanted=false 后退出，且不经过 drop()。
    // 必须在 primary 仍是 SH 时让出事件循环，否则 loop 还没检查 stillWanted 就被拨回 TK。
    livePrimary.current = SH;
    scheduler.flushSleeps();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawned.filter((c) => c.hubUrl === SH)).toHaveLength(1);

    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.filter((c) => c.hubUrl === SH).length >= 2);
    await waitUntil(() => manager.client(SH)?.state === 'online');
    expect(manager.client(TK)).toBeNull();
    expect(spawned.filter((c) => c.hubUrl === SH).length).toBeGreaterThanOrEqual(2);
    await manager.stop();
  });

  test('primaryUrl 为空时拆掉全部 secondary（attached-only）', async () => {
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    livePrimary.current = null;
    await manager.reconcile();
    await waitUntil(() => manager.client(TK) == null);
    expect(spawned.filter((c) => c.hubUrl === TK).every((c) => c.stopped > 0)).toBe(true);
    await manager.stop();
  });

  test('primaryUrl 回退到 presence 时会留下 secondary（旧接线）', async () => {
    const presenceUrl = { current: SH as string | null };
    const { manager, spawned, livePrimary, presence } = setup([row(SH, 0), row(TK, 1)], SH, {
      primaryUrl: (live) => live ?? presenceUrl.current,
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    presence.setPrimary(SH);
    presenceUrl.current = presence.primaryUrl();
    livePrimary.current = null;
    await manager.reconcile();
    expect(manager.client(TK)?.state).toBe('online');
    await manager.stop();
  });

  test('runLoop 自然退出后会清掉 zombie slot 并再挂', async () => {
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], TK);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => manager.client(SH)?.state === 'online');
    const first = spawned.find((c) => c.hubUrl === SH);
    expect(first).toBeTruthy();
    livePrimary.current = SH;
    first!.disconnect();
    await waitUntil(() => first!.stopped > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.filter((c) => c.hubUrl === SH).length >= 2);
    await waitUntil(() => manager.client(SH)?.state === 'online');
    await manager.stop();
  });

  test('attemptConnect 进行中 primary 抖动不会留下死 slot', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], SH, {
      onSpawn: (client) => {
        if (client.hubUrl === SH) client.connectGate = gate;
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === TK && c.state === 'online'));
    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.hubUrl === SH && c.connects >= 1));
    livePrimary.current = SH;
    await manager.reconcile();
    await waitUntil(() => manager.client(SH) == null);
    livePrimary.current = TK;
    await manager.reconcile();
    release();
    await waitUntil(() => manager.client(SH)?.state === 'online');
    await manager.stop();
  });

  test('secondary 连接失败打节流日志，成功打 online', async () => {
    const lines: string[] = [];
    const warn = console.warn;
    const info = console.info;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { manager, scheduler } = setup([row(SH, 0), row(TK, 1)], SH, {
        onSpawn: (client, already) => {
          if (client.hubUrl === TK && already.every((row) => row.hubUrl !== TK)) {
            client.failNext = true;
          }
        },
      });
      manager.start();
      await manager.reconcile();
      await waitUntil(() => scheduler.sleeps.length > 0);
      expect(
        lines.some((row) => row.includes('[uplink] secondary connect failed hub=tk.example'))
      ).toBe(true);
      expect(
        lines.some((row) => /attempt=1 reason=connect-failed next_retry_ms=\d+/.test(row))
      ).toBe(true);
      scheduler.flushSleeps();
      await waitUntil(() => manager.client(TK)?.state === 'online');
      expect(lines.some((row) => row.includes('[uplink] secondary online hub=tk.example'))).toBe(
        true
      );
      await manager.stop();
    } finally {
      console.warn = warn;
      console.info = info;
    }
  });
});
