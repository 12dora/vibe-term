import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkStream, StreamCloseInfo } from '@vibeterm/shared/link';
import { RelayCaPinStore } from '../auth/relay-ca-pin-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { seedUser } from './test-support';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
} from './types';
import type { UplinkClientOptions } from './uplink-constants';
import {
  UPLINK_POOL_AUTH_DEADLINE_MS,
  UPLINK_POOL_FAIL_LIMIT,
  UPLINK_POOL_PROBE_JITTER,
  type UplinkCandidate,
  UplinkPool,
  isRttSwitchWorth,
  redactUrl,
  sameUplinkUrl,
} from './uplink-pool';
import type { UplinkNodeList } from './uplink-protocol';

const ID = {
  a: 'aa'.repeat(16),
  b: 'bb'.repeat(16),
  c: 'cc'.repeat(16),
};

function dummyApplier(): KeyLogApplier {
  return {
    async head() {
      return { seq: 0n, hash: new Uint8Array(32) };
    },
    async applyMany() {
      return { applied: 0 };
    },
  };
}

function identity(): MeshIdentity {
  return { nodeId: ID.a, edSecretKey: new Uint8Array(32).fill(7) };
}

class ManualScheduler implements MeshScheduler {
  nowMs = 1_000;
  sleeps: number[] = [];
  readonly intervals: Array<{ fn: () => void; ms: number; cleared: boolean; dueAt: number }> = [];
  private sleepers: Array<{
    at: number;
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
  }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      const entry = {
        at: this.nowMs + ms,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (err: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        signal,
      };
      const onAbort = () => {
        this.sleepers = this.sleepers.filter((row) => row !== entry);
        entry.reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      this.sleepers.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  interval(fn: () => void, ms: number): { clear: () => void } {
    const handle = { fn, ms, cleared: false, dueAt: this.nowMs + ms };
    this.intervals.push(handle);
    return {
      clear() {
        handle.cleared = true;
      },
    };
  }

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    const now = this.nowMs;
    const dueSleeps = this.sleepers.filter((row) => row.at <= now);
    this.sleepers = this.sleepers.filter((row) => row.at > now);
    for (const row of dueSleeps) row.resolve();
    const due = this.intervals
      .filter((handle) => !handle.cleared && handle.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const handle of due) {
      if (handle.cleared) continue;
      handle.fn();
      if (!handle.cleared) handle.dueAt += handle.ms;
    }
    await Promise.resolve();
  }
}

type FakeBehavior = {
  failTimes?: number;
  hang?: boolean;
  gate?: { wait: () => Promise<void> };
  /** 忽略 abort/stop，等门打开后仍标成 online——用来测超时后不得 promote。 */
  lateConnect?: { wait: () => Promise<void> };
  error?: string;
};

function controlledRelayStream(id = 1): {
  stream: LinkStream;
  finish: (info?: StreamCloseInfo) => void;
} {
  let resolveClosed!: (info: StreamCloseInfo) => void;
  let settled = false;
  const abortListeners: Array<() => void> = [];
  const closed = new Promise<StreamCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = (info: StreamCloseInfo = { reason: 'end' }) => {
    if (settled) return;
    settled = true;
    resolveClosed(info);
    if (info.reason !== 'end') {
      for (const listener of abortListeners) listener();
    }
  };
  const stream: LinkStream = {
    id,
    openPayload: new Uint8Array(0),
    readable: new ReadableStream(),
    async write() {},
    async end() {},
    reset(reason) {
      finish({ reason: 'rst', ...(reason ? { message: reason } : {}) });
    },
    closed,
    onAbort(cb) {
      abortListeners.push(cb);
    },
  };
  return { stream, finish };
}

class FakeUplink {
  state: UplinkState = 'offline';
  link: { closed: Promise<{ reason?: string }> } | null = null;
  uplinkUrl: string;
  userId: string;
  identity: MeshIdentity;
  tlsCa: string[] | null;
  transport: 'ws' | 'memory' | null = null;
  connectCalls = 0;
  statusSends = 0;
  statusIfChangedCalls = 0;
  stopped = false;
  failTimes: number;
  hang: boolean;
  relayHandler: InboundRelayHandler | null = null;
  relayStreams: LinkStream[] = [];
  relayOpenGate: Promise<void> | null = null;
  private readonly sharedFail: FakeBehavior;
  lastConnectError: { reason: string; at: number } | null = null;
  lastKeyLogHead = null;
  readonly opts: UplinkClientOptions;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private closeResolve: ((info: { reason?: string }) => void) | null = null;
  private hangReject: ((err: Error) => void) | null = null;

  constructor(opts: UplinkClientOptions, behavior: FakeBehavior) {
    this.opts = opts;
    this.uplinkUrl = opts.uplinkUrl;
    this.identity = opts.identity;
    this.userId = typeof opts.userId === 'function' ? opts.userId() : opts.userId;
    this.tlsCa = opts.tlsCa ?? null;
    this.failTimes = 0;
    this.hang = behavior.hang ?? false;
    this.sharedFail = behavior;
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
  }

  start(): void {}

  emitRelay(fromNodeId = ID.c): void {
    this.relayHandler?.({} as never, fromNodeId, this.uplinkUrl);
  }

  queueRelayStream(stream: LinkStream): void {
    this.relayStreams.push(stream);
  }

  emitFork(event?: Partial<KeyLogForkEvent>): void {
    this.opts.onKeyLogFork?.({
      userId: this.userId,
      local: { seq: 1n, hash: new Uint8Array(32) },
      remote: { seq: 1n, hash: new Uint8Array(32).fill(1) },
      ...event,
    });
  }

  async attemptConnect(signal?: AbortSignal): Promise<void> {
    this.transport = 'ws';
    await this.connectInner(signal);
  }

  async connectWithLink(): Promise<void> {
    this.transport = 'memory';
    await this.connectInner();
  }

  private async connectInner(signal?: AbortSignal): Promise<void> {
    this.connectCalls += 1;
    this.setState('connecting');
    if (this.hang || this.sharedFail.hang) {
      await new Promise<void>((_resolve, reject) => {
        this.hangReject = reject;
        const onAbort = () => {
          this.hangReject = null;
          reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (this.sharedFail.lateConnect) {
      await this.sharedFail.lateConnect.wait();
    }
    if (this.sharedFail.gate) {
      const aborted = new Promise<void>((_resolve, reject) => {
        this.hangReject = reject;
        const onAbort = () => {
          this.hangReject = null;
          reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([this.sharedFail.gate.wait(), aborted]);
      this.hangReject = null;
    }
    if ((this.sharedFail.failTimes ?? 0) > 0) {
      this.sharedFail.failTimes = (this.sharedFail.failTimes ?? 0) - 1;
      this.failTimes += 1;
      this.setState('offline');
      throw new Error(this.sharedFail.error ?? 'connect-failed');
    }
    this.link = {
      closed: new Promise((resolve) => {
        this.closeResolve = resolve;
      }),
    };
    this.setState('online');
    this.opts.onNodeList?.({
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
    });
  }

  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    if (!this.link) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => resolve();
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      void this.link?.closed.then(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.hangReject?.(new Error('stopped'));
    this.hangReject = null;
    this.link = null;
    this.closeResolve?.({ reason: 'stopped' });
    this.closeResolve = null;
    this.setState('offline');
  }

  drop(): void {
    this.link = null;
    this.closeResolve?.({ reason: 'dropped' });
    this.closeResolve = null;
    this.setState('offline');
  }

  terminate(reason: string): void {
    this.lastConnectError = { reason, at: 1 };
    this.link = null;
    this.closeResolve?.({ reason });
    this.closeResolve = null;
    this.setState('offline');
  }

  emitStaleList(list: UplinkNodeList): void {
    this.opts.onNodeList?.(list);
  }

  sendCtl(): void {}
  sendStatus(): void {
    this.statusSends += 1;
  }
  sendStatusIfChanged(): boolean {
    this.statusIfChangedCalls += 1;
    this.sendStatus();
    return true;
  }
  async openRelay(): Promise<LinkStream> {
    const stream = this.relayStreams.shift();
    if (!stream) throw new Error('no relay');
    await this.relayOpenGate;
    return stream;
  }
  async queryKeyLogHead() {
    return null;
  }
  async queryKeyLogAt() {
    return null;
  }
  async appendAndAck() {
    return { ok: false as const, error: 'offline' };
  }

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.stateListeners) cb(state);
  }
}

describe('redactUrl', () => {
  test('prints origin only and strips userinfo, query and fragment', () => {
    expect(redactUrl('https://user:secret@hub.example:8443/path?q=1#frag')).toBe(
      'https://hub.example:8443'
    );
    expect(redactUrl('http://hub.example/foo')).toBe('http://hub.example');
    expect(redactUrl('https://hub.example:443/')).toBe('https://hub.example');
  });
});

describe('UplinkPool', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  function boot(input: {
    urls: string[];
    behavior?: Record<string, FakeBehavior>;
    scheduler?: ManualScheduler;
    probe?: (url: string) => Promise<boolean>;
    candidates?: () => UplinkCandidate[];
    onNodeList?: (list: UplinkNodeList) => void;
    onKeyLogFork?: (event: KeyLogForkEvent) => void;
    probeJitter?: number;
    enablePeriodicRttProbe?: boolean;
    rttProbeIntervalMs?: number;
    failbackDebounceMs?: number;
    relayDrainRecheckMs?: number;
    relayDrainTimeoutMs?: number;
    versions?: Record<string, string>;
    caPins?: RelayCaPinStore;
  }) {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const scheduler = input.scheduler ?? new ManualScheduler();
    const created: FakeUplink[] = [];
    const pool = new UplinkPool({
      identity: identity(),
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => ({
        version: '1',
        tmux: false,
        direct_capable: false,
        inventory: {},
        endpoints: [],
      }),
      candidates:
        input.candidates ??
        (() =>
          input.urls.map((publicUrl, index) => ({
            uplinkNodeId: index === 0 ? ID.b : index === 1 ? ID.c : null,
            publicUrl,
            priority: 10 + index,
            version: input.versions?.[publicUrl] ?? '1.1.13',
          }))),
      scheduler,
      failLimit: UPLINK_POOL_FAIL_LIMIT,
      authDeadlineMs: UPLINK_POOL_AUTH_DEADLINE_MS,
      probeIntervalMs: 60_000,
      probeTimeoutMs: 5_000,
      probeJitter: input.probeJitter ?? 0,
      enablePeriodicRttProbe: input.enablePeriodicRttProbe,
      rttProbeIntervalMs: input.rttProbeIntervalMs,
      failbackDebounceMs: input.failbackDebounceMs,
      relayDrainRecheckMs: input.relayDrainRecheckMs,
      relayDrainTimeoutMs: input.relayDrainTimeoutMs,
      caPins: input.caPins ?? new RelayCaPinStore(db),
      probeHealthz: async (url) => (input.probe ? input.probe(url) : false),
      onNodeList: input.onNodeList
        ? (list) => {
            input.onNodeList?.(list);
          }
        : undefined,
      onKeyLogFork: input.onKeyLogFork,
      createClient: (opts: UplinkClientOptions) => {
        const fake = new FakeUplink(opts, input.behavior?.[opts.uplinkUrl] ?? {});
        created.push(fake);
        return fake as unknown as import('./types').PooledUplink;
      },
    });
    fixtures.push({ close, stop: () => pool.stop() });
    return { pool, created, scheduler, close };
  }

  test('tries candidates in order and attaches the first that authenticates', async () => {
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 1 } },
    });
    pool.start();
    await waitMicro();
    expect(created.map((row) => row.uplinkUrl)).toEqual(['https://a.example']);
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(pool.state).toBe('online');
    expect(created[0]?.statusSends).toBeGreaterThanOrEqual(1);
  });

  test('spawn and healthz probe use pinned relay CA as tls.ca', async () => {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const caPins = new RelayCaPinStore(db);
    const pem = '-----BEGIN CERTIFICATE-----\nPIN\n-----END CERTIFICATE-----';
    caPins.put({
      url: 'https://relay.example',
      caPem: pem,
      fingerprint: 'ab'.repeat(32),
    });
    const created: FakeUplink[] = [];
    const pool = new UplinkPool({
      identity: identity(),
      userId: 'user-1',
      keyLogApplier: dummyApplier(),
      userStore,
      statusProvider: () => ({
        version: '1',
        tmux: false,
        direct_capable: false,
        inventory: {},
        endpoints: [],
      }),
      candidates: () => [
        {
          uplinkNodeId: null,
          publicUrl: 'https://relay.example',
          priority: 1,
        },
      ],
      caPins,
      createClient: (opts) => {
        const fake = new FakeUplink(opts, {});
        created.push(fake);
        return fake as unknown as import('./types').PooledUplink;
      },
      enablePeriodicRttProbe: false,
    });
    fixtures.push({ close, stop: () => pool.stop() });
    pool.start();
    await waitMicro();
    expect(created[0]?.tlsCa).toEqual([pem]);
    const spawned = pool.spawn({
      uplinkNodeId: null,
      publicUrl: 'https://relay.example',
      priority: 1,
    });
    expect((spawned as unknown as FakeUplink).tlsCa).toEqual([pem]);
  });

  test('empty candidates stay idle and never construct a client', async () => {
    const { pool, created } = boot({ urls: [], candidates: () => [] });
    pool.start();
    await waitMicro();
    expect(created).toHaveLength(0);
    expect(pool.candidates()).toEqual([]);
    expect(pool.attachedUplink()).toBeNull();
    expect(pool.state).toBe('offline');
  });

  test('fails over after 3 consecutive connect failures', async () => {
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.start();
    await waitMicro();
    expect(created[0]?.connectCalls).toBe(3);
    expect(created.some((row) => row.uplinkUrl === 'https://b.example')).toBe(true);
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
  });

  test('primaryTarget 在拨号窗口指向正在拨的 URL，挂上后跟 attached，stop 后为 null', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { hang: true } },
      scheduler,
    });
    expect(pool.primaryTarget()).toBeNull();
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()).toBeNull();
    expect(pool.primaryTarget()).toBe('https://a.example');
    await scheduler.advance(UPLINK_POOL_AUTH_DEADLINE_MS);
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    expect(pool.primaryTarget()).toBe('https://b.example');
    await pool.stop();
    expect(pool.primaryTarget()).toBeNull();
  });

  test('fails over after 20s without authenticating', async () => {
    const scheduler = new ManualScheduler();
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { hang: true } },
      scheduler,
    });
    pool.start();
    await waitMicro();
    expect(created[0]?.uplinkUrl).toBe('https://a.example');
    expect(pool.attachedUplink()).toBeNull();
    await scheduler.advance(UPLINK_POOL_AUTH_DEADLINE_MS);
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
  });

  test('wraps around with exponential backoff after every candidate fails', async () => {
    const scheduler = new ManualScheduler();
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: {
        'https://a.example': { failTimes: 99 },
        'https://b.example': { failTimes: 99 },
      },
      scheduler,
    });
    pool.start();
    await waitMicro();
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(scheduler.sleeps.some((ms) => ms >= 1_000)).toBe(true);
    expect(pool.attachedUplink()).toBeNull();
  });

  test('反复重连不会在长寿 stop signal 上攒 abort 监听器', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: {
        'https://a.example': { failTimes: 999 },
        'https://b.example': { failTimes: 999 },
      },
      scheduler,
    });
    pool.start();
    const stop = pool.stopSignal();
    if (!stop) throw new Error('stop signal missing');
    let live = 0;
    const addOrig = stop.addEventListener.bind(stop);
    const removeOrig = stop.removeEventListener.bind(stop);
    stop.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') live += 1;
      return (addOrig as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof stop.addEventListener;
    stop.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') live -= 1;
      return (removeOrig as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof stop.removeEventListener;
    for (let i = 0; i < 12; i += 1) {
      await waitMicro();
      await scheduler.advance(60_000);
    }
    await waitMicro();
    // 旧的 anyAbort 每拨一次就往 stop signal 上挂一个永不摘除的监听器。
    expect(live).toBeLessThanOrEqual(2);
  });

  test('make-before-break switchTo authenticates the new link before closing the old one', async () => {
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    const order: string[] = [];
    pool.onAttached((hub) => order.push(`attach:${hub.publicUrl}`));
    pool.onDetached(() => order.push('detach'));
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    const standby = created.find((row) => row.uplinkUrl === 'https://b.example');
    const origStop = standby?.stop.bind(standby);
    if (standby && origStop) {
      standby.stop = async () => {
        order.push('stop:b');
        await origStop();
      };
    }
    await pool.switchTo('https://a.example');
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    const preferred = created.filter((row) => row.uplinkUrl === 'https://a.example').at(-1);
    expect(preferred?.statusSends).toBeGreaterThanOrEqual(1);
    expect(order.indexOf('attach:https://a.example')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stop:b')).toBeGreaterThan(order.indexOf('attach:https://a.example') - 1);
    expect(standby?.stopped).toBe(true);
  });

  test('switchTo retires the old client only after its relay streams drain', async () => {
    const { pool, created } = boot({ urls: ['https://a.example', 'https://b.example'] });
    pool.start();
    await waitMicro();
    const old = created[0];
    const active = controlledRelayStream();
    old?.queueRelayStream(active.stream);
    await pool.openRelay(ID.c);
    expect(pool.relayStreamsInFlight()).toBe(1);

    expect(await pool.switchTo('https://b.example')).toEqual({ ok: true });
    expect(old?.stopped).toBe(false);
    expect(pool.relayStreamsInFlight()).toBe(1);

    active.finish();
    await waitMicro();
    expect(old?.stopped).toBe(true);
    expect(pool.relayStreamsInFlight()).toBe(0);
  });

  test('a relay stream that opens during promotion is reset on the retired client', async () => {
    const { pool, created } = boot({ urls: ['https://a.example', 'https://b.example'] });
    pool.start();
    await waitMicro();
    const old = created[0];
    const raced = controlledRelayStream();
    let release!: () => void;
    old?.queueRelayStream(raced.stream);
    if (old) {
      old.relayOpenGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    const opening = pool.openRelay(ID.c);

    expect(await pool.switchTo('https://b.example')).toEqual({ ok: true });
    release();
    await expect(opening).rejects.toThrow(/not online/);
    expect(await raced.stream.closed).toEqual({ reason: 'rst', message: 'uplink-retiring' });
  });

  test('retiring a client has a bounded drain timeout and dead links stop immediately', async () => {
    const scheduler = new ManualScheduler();
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      relayDrainRecheckMs: 3_000,
      relayDrainTimeoutMs: 6_000,
    });
    pool.start();
    await waitMicro();
    const old = created[0];
    const active = controlledRelayStream();
    old?.queueRelayStream(active.stream);
    await pool.openRelay(ID.c);
    expect(await pool.switchTo('https://b.example')).toEqual({ ok: true });
    expect(old?.stopped).toBe(false);
    await scheduler.advance(3_000);
    await waitMicro();
    expect(old?.stopped).toBe(false);
    await scheduler.advance(3_000);
    await waitMicro();
    expect(old?.stopped).toBe(true);

    const current = created.at(-1);
    const deadStream = controlledRelayStream(3);
    current?.queueRelayStream(deadStream.stream);
    await pool.openRelay(ID.c);
    if (current) {
      current.state = 'offline';
      current.link = null;
    }
    expect(await pool.switchTo('https://a.example')).toEqual({ ok: true });
    await waitMicro();
    expect(current?.stopped).toBe(true);
  });

  test('promote 成功后清掉该 URL 的 lastError', async () => {
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    expect(pool.candidates().find((row) => row.publicUrl === 'https://a.example')?.lastError).toBe(
      'connect-failed'
    );
    await pool.switchTo('https://a.example');
    const recovered = pool.candidates().find((row) => row.publicUrl === 'https://a.example');
    expect(recovered?.lastError).toBeNull();
    expect(recovered?.lastErrorAt).toBeNull();
  });

  test('generation guard drops node.list from a superseded link', async () => {
    const lists: Array<{ url: string; generation: number }> = [];
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.onNodeList((_list, meta) => {
      lists.push({ url: pool.attachedUplink()?.publicUrl ?? '', generation: meta.generation });
    });
    pool.start();
    await waitMicro();
    const gen = pool.currentGeneration();
    expect(gen).toBeGreaterThan(0);
    const stale = created.find((row) => row.uplinkUrl === 'https://a.example');
    stale?.emitStaleList({
      t: 'node.list',
      version: 9,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
    });
    expect(lists.every((row) => row.generation === gen)).toBe(true);
    expect(lists.some((row) => row.url === 'https://a.example' && row.generation === gen)).toBe(
      false
    );
  });

  test('probes preferred hubs and switches back when healthz succeeds', async () => {
    const scheduler = new ManualScheduler();
    let aHealthy = false;
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
      scheduler,
      probe: async (url) => url === 'https://a.example' && aHealthy,
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    expect(scheduler.intervals.some((row) => !row.cleared && row.ms === 60_000)).toBe(true);
    aHealthy = true;
    await scheduler.advance(60_000);
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(created.filter((row) => row.uplinkUrl === 'https://a.example').length).toBeGreaterThan(
      1
    );
  });

  test('failover attach starts the probe timer without node.list', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
      scheduler,
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    const probe = scheduler.intervals.find((row) => !row.cleared);
    expect(probe?.ms).toBe(60_000);
  });

  test('switch-back waits for relay streams on the current uplink', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const scheduler = new ManualScheduler();
      let aHealthy = false;
      const { pool, created } = boot({
        urls: ['https://a.example', 'https://b.example'],
        behavior: { 'https://a.example': { failTimes: 3 } },
        scheduler,
        probe: async (url) => url === 'https://a.example' && aHealthy,
      });
      pool.start();
      await waitMicro();
      const current = created.find((client) => client.uplinkUrl === 'https://b.example');
      const active = controlledRelayStream();
      current?.queueRelayStream(active.stream);
      await pool.openRelay(ID.c);
      aHealthy = true;

      await scheduler.advance(60_000);
      await waitMicro();
      expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
      expect(created.filter((client) => client.uplinkUrl === 'https://a.example')).toHaveLength(1);
      expect(lines.some((row) => row.includes('[uplink] probe ok url=https://a.example'))).toBe(
        true
      );
      expect(
        lines.some((row) =>
          row.includes(
            '[uplink] probe waiting drain reason=switch-back streams=1 url=https://b.example'
          )
        )
      ).toBe(true);

      active.finish();
      await waitMicro();
      expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    } finally {
      console.info = originalInfo;
    }
  });

  test('onNodeList meta.uplinkNodeId is the authenticated attached hub, not list.hub (writer)', async () => {
    const metas: Array<{ uplinkNodeId: string | null; generation: number }> = [];
    const { pool, created } = boot({
      urls: ['https://standby.example'],
      candidates: () => [
        {
          uplinkNodeId: ID.c,
          publicUrl: 'https://standby.example',
          priority: 20,
        },
      ],
    });
    pool.onNodeList((_list, meta) => {
      metas.push(meta);
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://standby.example');
    created[0]?.emitStaleList({
      t: 'node.list',
      version: 2,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
    });
    await waitMicro();
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((row) => row.uplinkNodeId === ID.c)).toBe(true);
  });

  test('older switchTo must not promote over a newer live link', async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const behavior: Record<string, FakeBehavior> = {
      'https://a.example': { failTimes: 3 },
      'https://c.example': {},
    };
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example', 'https://c.example'],
      behavior,
      candidates: () => [
        {
          uplinkNodeId: ID.b,
          publicUrl: 'https://a.example',
          priority: 10,
        },
        {
          uplinkNodeId: ID.c,
          publicUrl: 'https://b.example',
          priority: 20,
        },
        {
          uplinkNodeId: 'dd'.repeat(16),
          publicUrl: 'https://c.example',
          priority: 30,
        },
      ],
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    behavior['https://a.example'] = { gate: { wait: () => gateA } };
    const first = pool.switchTo('https://a.example');
    await waitMicro();
    const second = pool.switchTo('https://c.example');
    await second;
    expect(pool.attachedUplink()?.publicUrl).toBe('https://c.example');
    const firstClient = created.filter((row) => row.uplinkUrl === 'https://a.example').at(-1);
    expect(firstClient?.stopped).toBe(true);
    expect(await first).toEqual({ ok: false, reason: 'superseded' });
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://c.example');
    expect(created.filter((row) => row.uplinkUrl === 'https://c.example').at(-1)?.stopped).toBe(
      false
    );
  });

  test('switchTo 超时后迟到的连接不得 promote', async () => {
    let releaseLate: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const behavior: Record<string, FakeBehavior> = {
      'https://a.example': { failTimes: 3 },
    };
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior,
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    behavior['https://a.example'] = { lateConnect: { wait: () => late } };
    const ac = new AbortController();
    const pending = pool.switchTo('https://a.example', ac.signal);
    await waitMicro();
    ac.abort();
    await waitMicro();
    releaseLate();
    expect(await pending).toEqual({ ok: false, reason: 'connect-timeout' });
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
  });

  test('promote 提交后旧客户端 stop 延迟，中止仍算切换成功', async () => {
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    const standby = created.find((row) => row.uplinkUrl === 'https://b.example');
    const origStop = standby?.stop.bind(standby);
    if (standby && origStop) {
      standby.stop = async () => {
        await stopGate;
        await origStop();
      };
    }
    const ac = new AbortController();
    const pending = pool.switchTo('https://a.example', ac.signal);
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    ac.abort();
    expect(await pending).toEqual({ ok: true });
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(standby?.stopped).toBe(false);
    releaseStop();
    await waitMicro();
    expect(standby?.stopped).toBe(true);
  });

  test('手动切换后 heartbeat-lost 记到新 URL，旧 URL 诊断保持干净', async () => {
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    expect(await pool.switchTo('https://a.example')).toEqual({ ok: true });
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(
      pool.candidates().find((row) => row.publicUrl === 'https://a.example')?.lastError
    ).toBeNull();
    expect(
      pool.candidates().find((row) => row.publicUrl === 'https://b.example')?.lastError
    ).toBeNull();
    const liveA = created.filter((row) => row.uplinkUrl === 'https://a.example').at(-1);
    liveA?.terminate('missed-pong');
    await waitMicro();
    expect(pool.candidates().find((row) => row.publicUrl === 'https://a.example')?.lastError).toBe(
      'missed-pong'
    );
    expect(
      pool.candidates().find((row) => row.publicUrl === 'https://b.example')?.lastError
    ).toBeNull();
  });

  test('被取代的 switch 连接失败记 superseded 且不污染目标诊断', async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const behavior: Record<string, FakeBehavior> = {
      'https://a.example': { failTimes: 3 },
    };
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example', 'https://c.example'],
      behavior,
      candidates: () => [
        {
          uplinkNodeId: ID.b,
          publicUrl: 'https://a.example',
          priority: 10,
        },
        {
          uplinkNodeId: ID.c,
          publicUrl: 'https://b.example',
          priority: 20,
        },
        {
          uplinkNodeId: 'dd'.repeat(16),
          publicUrl: 'https://c.example',
          priority: 30,
        },
      ],
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    expect(await pool.switchTo('https://a.example')).toEqual({ ok: true });
    expect(await pool.switchTo('https://b.example')).toEqual({ ok: true });
    expect(
      pool.candidates().find((row) => row.publicUrl === 'https://a.example')?.lastError
    ).toBeNull();
    behavior['https://a.example'] = {
      gate: { wait: () => gateA },
      error: 'connect-failed',
      failTimes: 1,
    };
    const first = pool.switchTo('https://a.example');
    await waitMicro();
    expect(await pool.switchTo('https://c.example')).toEqual({ ok: true });
    expect(await first).toEqual({ ok: false, reason: 'superseded' });
    releaseA();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://c.example');
    expect(
      pool.candidates().find((row) => row.publicUrl === 'https://a.example')?.lastError
    ).toBeNull();
  });

  test('多次成功切换后 pool stop 信号上的 abort 监听器不累积', async () => {
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    const stop = pool.stopSignal();
    if (!stop) throw new Error('missing stop signal');
    let added = 0;
    let removed = 0;
    const origAdd = stop.addEventListener.bind(stop);
    const origRemove = stop.removeEventListener.bind(stop);
    stop.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      if (args[0] === 'abort') added += 1;
      origAdd(...args);
    }) as AbortSignal['addEventListener'];
    stop.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      if (args[0] === 'abort') removed += 1;
      origRemove(...args);
    }) as AbortSignal['removeEventListener'];
    const leftoverAfter = async (url: string) => {
      const ac = new AbortController();
      expect(await pool.switchTo(url, ac.signal)).toEqual({ ok: true });
      return added - removed;
    };
    const leftover = await leftoverAfter('https://a.example');
    for (let i = 0; i < 5; i += 1) {
      const url = i % 2 === 0 ? 'https://b.example' : 'https://a.example';
      expect(await leftoverAfter(url)).toBe(leftover);
    }
  });

  test('在线链路 heartbeat-lost / kicked 写入 per-URL 诊断', async () => {
    const behavior: Record<string, FakeBehavior> = { 'https://a.example': {} };
    const { pool, created } = boot({ urls: ['https://a.example'], behavior });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    behavior['https://a.example'] = { hang: true };
    created[0]?.terminate('missed-pong');
    await waitMicro();
    expect(pool.attachedUplink()).toBeNull();
    expect(pool.candidates().find((row) => row.publicUrl === 'https://a.example')?.lastError).toBe(
      'missed-pong'
    );
    await pool.stop();

    const kicked: Record<string, FakeBehavior> = { 'https://b.example': {} };
    const second = boot({ urls: ['https://b.example'], behavior: kicked });
    second.pool.start();
    await waitMicro();
    kicked['https://b.example'] = { hang: true };
    second.created[0]?.terminate('kicked:password_rotated');
    await waitMicro();
    expect(
      second.pool.candidates().find((row) => row.publicUrl === 'https://b.example')?.lastError
    ).toBe('kicked:password_rotated');
    await second.pool.stop();
  });

  test('path-rerace 立刻重连且不记候选失败', async () => {
    const scheduler = new ManualScheduler();
    const { pool, created } = boot({
      urls: ['https://relay.example'],
      scheduler,
    });
    pool.start();
    await waitMicro();
    expect(created).toHaveLength(1);
    expect(pool.attachedUplink()?.publicUrl).toBe('https://relay.example');
    created[0]?.terminate('path-rerace');
    await waitMicro();
    expect(
      pool.candidates().find((row) => row.publicUrl === 'https://relay.example')?.lastError
    ).toBeNull();
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created.at(-1)?.state).toBe('online');
    await pool.stop();
  });

  test('overlapping probe ticks are in-flight-guarded and the period is jittered ±20%', async () => {
    const scheduler = new ManualScheduler();
    let probeStarted = 0;
    let releaseProbe: () => void = () => {};
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
      scheduler,
      probeJitter: UPLINK_POOL_PROBE_JITTER,
      probe: async () => {
        probeStarted += 1;
        await new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        return false;
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    const intervalMs = scheduler.intervals.find((row) => !row.cleared)?.ms ?? 0;
    expect(intervalMs).toBeGreaterThanOrEqual(Math.floor(60_000 * 0.8));
    expect(intervalMs).toBeLessThanOrEqual(Math.ceil(60_000 * 1.2));
    await scheduler.advance(intervalMs);
    await waitMicro();
    expect(probeStarted).toBe(1);
    await scheduler.advance(intervalMs);
    await waitMicro();
    expect(probeStarted).toBe(1);
    releaseProbe();
    await waitMicro();
    await scheduler.advance(intervalMs);
    await waitMicro();
    expect(probeStarted).toBe(2);
  });

  test('pending client cannot inject relay or key-log fork events', async () => {
    const scheduler = new ManualScheduler();
    const forks: KeyLogForkEvent[] = [];
    const relays: string[] = [];
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { hang: true } },
      scheduler,
      onKeyLogFork: (event) => forks.push(event),
    });
    pool.setOnRelayStream((_stream, from) => {
      relays.push(from);
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()).toBeNull();
    expect(created[0]?.uplinkUrl).toBe('https://a.example');
    created[0]?.emitRelay(ID.c);
    created[0]?.emitFork();
    expect(relays).toEqual([]);
    expect(forks).toEqual([]);
  });

  test('promote uses sendStatusIfChanged instead of a forced sendStatus', async () => {
    const { pool, created } = boot({ urls: ['https://a.example'] });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(created[0]?.statusIfChangedCalls).toBeGreaterThanOrEqual(1);
  });

  test('logs every candidate attempt, failure, failover and records lastError', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { pool } = boot({
        urls: ['https://a.example', 'https://b.example'],
        behavior: { 'https://a.example': { failTimes: 3 } },
      });
      pool.start();
      await waitMicro();
      expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
      const a = pool.candidates().find((row) => row.publicUrl === 'https://a.example');
      const b = pool.candidates().find((row) => row.publicUrl === 'https://b.example');
      expect(a?.lastError).toBe('connect-failed');
      expect(a?.lastErrorAt).toBeGreaterThan(0);
      expect(a?.lastAttemptAt).toBeGreaterThan(0);
      expect(b?.lastError).toBeNull();
      expect(b?.lastErrorAt).toBeNull();
      expect(b?.lastAttemptAt).toBeGreaterThan(0);
      expect(
        lines.some((row) => row.includes('[uplink] try url=https://a.example idx=1/2 transport=ws'))
      ).toBe(true);
      expect(
        lines.some((row) =>
          /\[uplink] candidate failed url=https:\/\/a\.example err=connect-failed fails=\d+/.test(
            row
          )
        )
      ).toBe(true);
      expect(lines.some((row) => row.includes('[uplink] failover → url=https://b.example'))).toBe(
        true
      );
      expect(
        lines.some((row) => row.includes('[uplink] try url=https://b.example idx=2/2 transport=ws'))
      ).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });

  test('rate-limits identical candidate failure lines to once per 60s per URL', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const scheduler = new ManualScheduler();
      const { pool } = boot({
        urls: ['https://a.example'],
        behavior: { 'https://a.example': { failTimes: 99 } },
        scheduler,
      });
      pool.start();
      await waitMicro();
      const failed = () =>
        lines.filter((row) =>
          row.includes('[uplink] candidate failed url=https://a.example err=connect-failed')
        );
      expect(failed().length).toBe(1);
      await scheduler.advance(1_000);
      await waitMicro();
      expect(failed().length).toBe(1);
      await scheduler.advance(60_000);
      await waitMicro();
      expect(failed().length).toBeGreaterThan(1);
      const a = pool.candidates()[0];
      expect(a?.lastError).toBe('connect-failed');
    } finally {
      console.info = originalInfo;
    }
  });

  test('logs probe result and switch-back', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const scheduler = new ManualScheduler();
      let aHealthy = false;
      const { pool } = boot({
        urls: ['https://a.example', 'https://b.example'],
        behavior: { 'https://a.example': { failTimes: 3 } },
        scheduler,
        probe: async (url) => url === 'https://a.example' && aHealthy,
      });
      pool.start();
      await waitMicro();
      expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
      aHealthy = true;
      await scheduler.advance(60_000);
      await waitMicro();
      expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
      expect(lines.some((row) => row.includes('[uplink] probe ok url=https://a.example'))).toBe(
        true
      );
      expect(
        lines.some((row) => row.includes('[uplink] switch-back → url=https://a.example'))
      ).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });

  test('candidate logs print origin only without userinfo query or fragment', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const dirty = 'https://user:secret@hub.example:8443/uplink?token=abc#frag';
      const { pool } = boot({
        urls: [dirty],
        behavior: { [dirty]: { failTimes: 3 } },
        candidates: () => [
          {
            uplinkNodeId: ID.b,
            publicUrl: dirty,
            priority: 10,
          },
        ],
      });
      pool.start();
      await waitMicro();
      expect(lines.some((row) => row.includes('secret') || row.includes('token=abc'))).toBe(false);
      expect(
        lines.some((row) => row.includes('[uplink] try url=https://hub.example:8443 idx='))
      ).toBe(true);
      expect(
        lines.some((row) =>
          row.includes('[uplink] candidate failed url=https://hub.example:8443 err=connect-failed')
        )
      ).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });

  test('requestProbeNow probes the preferred hub immediately then debounces 2s', async () => {
    const scheduler = new ManualScheduler();
    const probed: string[] = [];
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
      scheduler,
      probe: async (url) => {
        probed.push(url);
        return false;
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://b.example');
    probed.length = 0;

    pool.requestProbeNow();
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);

    pool.requestProbeNow();
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);

    await scheduler.advance(1_999);
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);

    await scheduler.advance(1);
    await waitMicro();
    expect(probed).toEqual(['https://a.example', 'https://a.example']);
  });

  test('requestProbeNow coalesces while a probe is in flight', async () => {
    const scheduler = new ManualScheduler();
    let probeStarted = 0;
    let releaseProbe: () => void = () => {};
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
      scheduler,
      probe: async () => {
        probeStarted += 1;
        await new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        return false;
      },
    });
    pool.start();
    await waitMicro();
    pool.requestProbeNow();
    await waitMicro();
    expect(probeStarted).toBe(1);

    pool.requestProbeNow();
    pool.requestProbeNow();
    await waitMicro();
    expect(probeStarted).toBe(1);

    releaseProbe();
    await waitMicro();
    expect(probeStarted).toBe(1);

    await scheduler.advance(2_000);
    await waitMicro();
    expect(probeStarted).toBe(2);
  });

  test('healthz probes record rtt only on success and clear it on failure', async () => {
    const scheduler = new ManualScheduler();
    let healthy = true;
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 300_000,
      probe: async () => healthy,
    });
    pool.start();
    await waitMicro();
    await scheduler.advance(300_000);
    await waitMicro();
    expect(
      pool
        .candidates()
        .every((row) => typeof row.rttMs === 'number' && row.rttAt === scheduler.nowMs)
    ).toBe(true);
    healthy = false;
    await scheduler.advance(300_000);
    await waitMicro();
    expect(pool.candidates().every((row) => row.rttMs === null && row.rttAt === null)).toBe(true);
  });

  test('periodic RTT probe runs every 5 minutes when enabled and there are 2+ candidates', async () => {
    const scheduler = new ManualScheduler();
    const probed: string[] = [];
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 300_000,
      probe: async (url) => {
        probed.push(url);
        return true;
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(probed).toEqual([]);
    const rttHandle = scheduler.intervals.find((row) => !row.cleared && row.ms === 300_000);
    expect(rttHandle).toBeTruthy();
    await scheduler.advance(300_000);
    await waitMicro();
    expect(probed.sort()).toEqual(['https://a.example', 'https://b.example']);
    const snap = pool.candidates();
    expect(
      snap.every((row) => typeof row.rttMs === 'number' && row.rttAt === scheduler.nowMs)
    ).toBe(true);
  });

  test('periodic RTT probe is skipped in tests unless enabled', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe('https://a.example');
    expect(scheduler.intervals.filter((row) => !row.cleared)).toEqual([]);
  });

  test('RTT hysteresis requires 30% and 15ms improvement', () => {
    expect(isRttSwitchWorth(100, 80)).toBe(false);
    expect(isRttSwitchWorth(100, 70)).toBe(true);
    expect(isRttSwitchWorth(20, 6)).toBe(false);
    expect(isRttSwitchWorth(20, 5)).toBe(true);
  });

  test('ten consecutive identical failures log at most two uplink lines', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const scheduler = new ManualScheduler();
      const { pool } = boot({
        urls: ['https://a.example'],
        behavior: { 'https://a.example': { failTimes: 99 } },
        scheduler,
      });
      pool.start();
      await waitMicro();
      for (let i = 0; i < 10; i += 1) {
        await scheduler.advance(2_000);
        await waitMicro();
      }
      const uplink = lines.filter((row) => row.includes('[uplink]') && row.includes('a.example'));
      expect(uplink.length).toBeLessThanOrEqual(2);
    } finally {
      console.info = originalInfo;
    }
  });
});

async function waitMicro(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
