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
const JP = 'https://jp.example';
const PEER = 'ab'.repeat(16);
const PEER_JP = 'cd'.repeat(16);

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

  constructor(readonly uplinkUrl: string) {}

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

  adoptPrimaryWiring: (() => void) | null = null;
  releasePrimaryWiring: (() => void) | null = null;

  sendStatus(): void {}
  sendCtl(): void {}
  async openRelay(_to: string): Promise<LinkStream> {
    return { id: this.uplinkUrl } as unknown as LinkStream;
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
    excludeUrl?: () => string | null;
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
    ...(extra?.excludeUrl ? { excludeUrl: extra.excludeUrl } : {}),
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

  test('primary 为空时不新开 secondary（只保住已有的）', async () => {
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1), row(JP, 2)], null);
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
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
    expect(spawned.map((c) => c.uplinkUrl)).toEqual([TK]);
    expect(presence.snapshot().find((entry) => entry.url === TK)?.connected).toBe(true);

    liveRows.current = [row(SH, 0), row(TK, 1), row(SG, 2)];
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === SG && c.state === 'online'));

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
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
    const tokyo = spawned.find((c) => c.uplinkUrl === TK);
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
    expect(spawned.filter((c) => c.uplinkUrl === TK).length).toBe(1);
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
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
    const tokyo = spawned.find((c) => c.uplinkUrl === TK);
    tokyo?.emitInbound(PEER);
    expect(inbound).toEqual([{ from: PEER, viaRelay: TK }]);
    await manager.stop();
  });

  test('path-rerace 把 slot.attempt 归零并立刻重连', async () => {
    const { manager, spawned, scheduler } = setup([row(SH, 0), row(TK, 1)], SH);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
    const first = spawned.find((c) => c.uplinkUrl === TK);
    expect(first).toBeTruthy();
    first!.lastConnectError = { reason: 'path-rerace', at: 1 };
    first!.disconnect();
    await waitUntil(() => spawned.filter((c) => c.uplinkUrl === TK).length >= 2);
    expect(scheduler.sleeps).toEqual([]);
    expect(spawned.filter((c) => c.uplinkUrl === TK).at(-1)?.state).toBe('online');
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
    const tokyo = spawned.find((c) => c.uplinkUrl === TK);
    const singapore = spawned.find((c) => c.uplinkUrl === SG);
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
      spawned.some((c) => c.uplinkUrl === TK && c !== tokyo && c.state === 'online')
    );
    expect(manager.client(TK)).not.toBe(tokyo);
    expect(manager.client(TK)?.state).toBe('online');
    expect(manager.client(SG)).toBe(singapore);
    expect(singapore.stopped).toBe(0);
    expect(spawned.filter((c) => c.uplinkUrl === TK)).toHaveLength(2);
    expect(spawned.filter((c) => c.uplinkUrl === SG)).toHaveLength(1);
    await manager.stop();
  });

  test('故障转移后原 primary 在退避内重挂为 secondary（事故）', async () => {
    const { manager, spawned, livePrimary, scheduler } = setup([row(SH, 0), row(TK, 1)], SH, {
      onSpawn: (client, already) => {
        if (client.uplinkUrl === SH && already.every((row) => row.uplinkUrl !== SH)) {
          client.failNext = true;
        }
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));

    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === SH));
    await waitUntil(() => scheduler.sleeps.length > 0);

    // 池 wrap 短暂把 SH 当成 primary：runLoop 看到 stillWanted=false 后退出，且不经过 drop()。
    // 必须在 primary 仍是 SH 时让出事件循环，否则 loop 还没检查 stillWanted 就被拨回 TK。
    livePrimary.current = SH;
    scheduler.flushSleeps();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(1);

    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.filter((c) => c.uplinkUrl === SH).length >= 2);
    await waitUntil(() => manager.client(SH)?.state === 'online');
    expect(manager.client(TK)).toBeNull();
    expect(spawned.filter((c) => c.uplinkUrl === SH).length).toBeGreaterThanOrEqual(2);
    await manager.stop();
  });

  test('primaryUrl 为空且仍在跑时保住已有 secondary', async () => {
    const inbound: Array<{ from: string; viaRelay?: string }> = [];
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], SH, {
      onRelayStream: (_stream, from, viaRelay) => {
        inbound.push({ from, viaRelay });
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
    const tokyo = spawned.find((c) => c.uplinkUrl === TK);
    livePrimary.current = null;
    await manager.reconcile();
    expect(manager.client(TK)?.state).toBe('online');
    expect(tokyo?.stopped).toBe(0);
    tokyo?.emitInbound(PEER);
    expect(inbound).toEqual([{ from: PEER, viaRelay: TK }]);
    await manager.stop();
  });

  test('三中继：primary 暂缺时 tk/jp 仍在 presence，onlineUnion 保住 peers', async () => {
    const { manager, spawned, livePrimary, presence, scheduler } = setup(
      [row(SH, 0), row(TK, 1), row(JP, 2)],
      SH
    );
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.filter((c) => c.state === 'online').length >= 2);
    presence.applyList(TK, [{ id: PEER, online: true }], 1, scheduler.now());
    presence.applyList(JP, [{ id: PEER_JP, online: true }], 1, scheduler.now());
    expect(presence.onlineUnion(scheduler.now())).toEqual(new Set([PEER, PEER_JP]));

    livePrimary.current = null;
    await manager.reconcile();
    expect(manager.client(TK)?.state).toBe('online');
    expect(manager.client(JP)?.state).toBe('online');
    expect(presence.snapshot().some((entry) => entry.url === TK)).toBe(true);
    expect(presence.snapshot().some((entry) => entry.url === JP)).toBe(true);
    expect(presence.onlineUnion(scheduler.now())).toEqual(new Set([PEER, PEER_JP]));
    expect(spawned.filter((c) => c.uplinkUrl === TK).every((c) => c.stopped === 0)).toBe(true);
    expect(spawned.filter((c) => c.uplinkUrl === JP).every((c) => c.stopped === 0)).toBe(true);
    await manager.stop();
  });

  test('正在拨的 URL 不挂 secondary，避免双连', async () => {
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], TK);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => manager.client(SH)?.state === 'online');
    const shanghai = spawned.find((c) => c.uplinkUrl === SH);
    livePrimary.current = SH;
    await manager.reconcile();
    await waitUntil(() => manager.client(SH) == null);
    expect(shanghai?.stopped).toBeGreaterThan(0);
    expect(spawned.filter((c) => c.uplinkUrl === SH && c.state === 'online')).toHaveLength(0);
    await manager.stop();
  });

  test('primaryUrl 回退到 presence 时会留下 secondary（旧接线）', async () => {
    const presenceUrl = { current: SH as string | null };
    const { manager, spawned, livePrimary, presence } = setup([row(SH, 0), row(TK, 1)], SH, {
      primaryUrl: (live) => live ?? presenceUrl.current,
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
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
    const first = spawned.find((c) => c.uplinkUrl === SH);
    expect(first).toBeTruthy();
    livePrimary.current = SH;
    first!.disconnect();
    await waitUntil(() => first!.stopped > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.filter((c) => c.uplinkUrl === SH).length >= 2);
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
        if (client.uplinkUrl === SH) client.connectGate = gate;
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
    livePrimary.current = TK;
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === SH && c.connects >= 1));
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
          if (client.uplinkUrl === TK && already.every((row) => row.uplinkUrl !== TK)) {
            client.failNext = true;
          }
        },
      });
      manager.start();
      await manager.reconcile();
      await waitUntil(() => scheduler.sleeps.length > 0);
      expect(
        lines.some((row) => row.includes('[uplink] secondary connect failed url=tk.example'))
      ).toBe(true);
      expect(
        lines.some((row) => /attempt=1 reason=connect-failed next_retry_ms=\d+/.test(row))
      ).toBe(true);
      const logged = lines.find((row) => /next_retry_ms=\d+/.test(row));
      const loggedMs = Number(/next_retry_ms=(\d+)/.exec(logged ?? '')?.[1]);
      expect(scheduler.sleeps[0]?.ms).toBe(loggedMs);
      scheduler.flushSleeps();
      await waitUntil(() => manager.client(TK)?.state === 'online');
      expect(lines.some((row) => row.includes('[uplink] secondary online url=tk.example'))).toBe(
        true
      );
      await manager.stop();
    } finally {
      console.warn = warn;
      console.info = info;
    }
  });

  test('secondary online 按 URL 节流，path-rerace 不刷屏', async () => {
    const lines: string[] = [];
    const info = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { manager, spawned } = setup([row(SH, 0), row(TK, 1)], SH);
      manager.start();
      await manager.reconcile();
      await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.state === 'online'));
      const first = spawned.find((c) => c.uplinkUrl === TK);
      first!.lastConnectError = { reason: 'path-rerace', at: 1 };
      first!.disconnect();
      await waitUntil(() => spawned.filter((c) => c.uplinkUrl === TK).length >= 2);
      expect(
        lines.filter((row) => row.includes('[uplink] secondary online url=tk.example'))
      ).toHaveLength(1);
      await manager.stop();
    } finally {
      console.info = info;
    }
  });

  test('stillWanted 变 false 时立刻 abort 在途 attempt', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], SH, {
      onSpawn: (client) => {
        if (client.uplinkUrl === TK) client.connectGate = gate;
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.connects >= 1));
    livePrimary.current = TK;
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.stopped > 0));
    expect(spawned.filter((c) => c.uplinkUrl === TK && c.connects > 0)).toHaveLength(1);
    release();
    await manager.stop();
  });

  test('detachOnline 交出现有副连接且不 stop；没有主接线时原样留下', async () => {
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1)], TK);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => manager.client(SH)?.state === 'online');
    const plain = spawned.find((client) => client.uplinkUrl === SH);
    if (!plain) throw new Error('missing secondary');
    expect(await manager.detachOnline(SH)).toBeNull();
    expect(plain.stopped).toBe(0);
    expect(manager.client(SH)?.state).toBe('online');
    plain.adoptPrimaryWiring = () => {};
    expect(await manager.detachOnline(SH)).toBe(plain);
    expect(plain.stopped).toBe(0);
    expect(manager.client(SH)).toBeNull();
    await manager.stop();
    expect(plain.stopped).toBe(0);
  });

  test('excludeUrl 挡住池正在拨的 URL，松开后才挂上', async () => {
    let exclude: string | null = SH;
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1)], TK, {
      excludeUrl: () => exclude,
    });
    manager.start();
    await manager.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(0);
    exclude = null;
    await manager.reconcile();
    await waitUntil(() => manager.client(SH)?.state === 'online');
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(1);
    await manager.stop();
  });

  test('primaryUrl 指向本槽时从 wanted 排除，不与池双拨', async () => {
    const { manager, spawned, livePrimary } = setup([row(SH, 0), row(TK, 1)], TK);
    manager.start();
    await manager.reconcile();
    await waitUntil(() => manager.client(SH)?.state === 'online');
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(1);
    livePrimary.current = SH;
    await waitUntil(() => manager.client(SH) == null);
    expect(spawned.filter((c) => c.uplinkUrl === SH && c.state === 'online')).toHaveLength(0);
    await manager.stop();
  });

  test('releaseNotOnline 丢掉未在线的槽，在线但不能收养的留下', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1), row(JP, 2)], SH, {
      onSpawn: (client) => {
        if (client.uplinkUrl === TK) client.connectGate = gate;
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === JP && c.state === 'online'));
    await waitUntil(() => spawned.some((c) => c.uplinkUrl === TK && c.connects >= 1));
    const tokyo = spawned.find((c) => c.uplinkUrl === TK);
    await manager.releaseNotOnline(TK);
    expect(manager.client(TK)).toBeNull();
    expect(tokyo?.stopped).toBeGreaterThan(0);
    const japan = spawned.find((c) => c.uplinkUrl === JP);
    if (!japan) throw new Error('missing japan secondary');
    await manager.releaseNotOnline(JP);
    expect(manager.client(JP)).toBe(japan);
    expect(japan?.stopped).toBe(0);
    release();
    await manager.stop();
  });

  test('resetAttempts 不叫醒池正在占用的槽', async () => {
    let exclude: string | null = null;
    const { manager, spawned, scheduler } = setup([row(SH, 0), row(TK, 1)], SH, {
      excludeUrl: () => exclude,
      onSpawn: (client, already) => {
        if (client.uplinkUrl === TK && already.every((item) => item.uplinkUrl !== TK)) {
          client.failNext = true;
        }
      },
    });
    manager.start();
    await manager.reconcile();
    await waitUntil(() => scheduler.sleeps.length > 0);
    expect(spawned.filter((c) => c.uplinkUrl === TK).reduce((n, c) => n + c.connects, 0)).toBe(1);
    exclude = TK;
    manager.resetAttempts();
    expect(scheduler.sleeps.length).toBeGreaterThan(0);
    scheduler.flushSleeps();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawned.filter((c) => c.uplinkUrl === TK).reduce((n, c) => n + c.connects, 0)).toBe(1);
    await manager.stop();
  });

  test('adoptOnline 原地收下旧主连接，reconcile 不再另拨', async () => {
    let exclude: string | null = SH;
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1)], TK, {
      excludeUrl: () => exclude,
    });
    manager.start();
    await manager.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(0);
    const handed = new FakeSecondary(SH);
    handed.state = 'online';
    let released = 0;
    handed.releasePrimaryWiring = () => {
      released += 1;
    };
    expect(manager.adoptOnline(handed)).toBe(true);
    expect(manager.client(SH)).toBe(handed);
    expect(handed.connects).toBe(0);
    expect(handed.stopped).toBe(0);
    expect(released).toBe(1);
    exclude = null;
    await manager.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(0);
    expect(manager.client(SH)).toBe(handed);
    await manager.stop();
  });

  test('noteRetiring 在清掉之前不把该 URL 再挂成 secondary', async () => {
    const { manager, spawned } = setup([row(SH, 0), row(TK, 1)], TK);
    manager.noteRetiring(SH);
    manager.start();
    await manager.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(0);
    manager.clearRetiring(SH);
    await waitUntil(() => manager.client(SH)?.state === 'online');
    expect(spawned.filter((c) => c.uplinkUrl === SH)).toHaveLength(1);
    await manager.stop();
  });
});
