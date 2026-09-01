import { afterEach, describe, expect, test } from 'bun:test';
import type { HubMode } from '@tmex/shared/uplink';
import { HubTrustStore } from '../auth/hub-trust-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { seedUser } from './test-support';
import type { KeyLogApplier, MeshIdentity, MeshScheduler, UplinkState } from './types';
import type { UplinkClient, UplinkClientOptions } from './uplink-client';
import {
  UPLINK_POOL_AUTH_DEADLINE_MS,
  UPLINK_POOL_FAIL_LIMIT,
  UPLINK_SEED_PRIORITY_BASE,
  type UplinkCandidate,
  UplinkPool,
  mergeUplinkCandidates,
  recordsFromNodeList,
  sameHubUrl,
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

type FakeBehavior = { failTimes?: number; hang?: boolean };

class FakeUplink {
  state: UplinkState = 'offline';
  link: { closed: Promise<{ reason?: string }> } | null = null;
  hubUrl: string;
  userId: string;
  identity: MeshIdentity;
  tlsCa: string[] | null;
  connectCalls = 0;
  statusSends = 0;
  stopped = false;
  failTimes: number;
  hang: boolean;
  private readonly sharedFail: FakeBehavior;
  lastConnectError: { reason: string; at: number } | null = null;
  lastKeyLogHead = null;
  readonly opts: UplinkClientOptions;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private closeResolve: ((info: { reason?: string }) => void) | null = null;
  private hangReject: ((err: Error) => void) | null = null;

  constructor(opts: UplinkClientOptions, behavior: FakeBehavior) {
    this.opts = opts;
    this.hubUrl = opts.hubUrl;
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

  setOnRelayStream(): void {}

  start(): void {}

  async attemptConnect(signal?: AbortSignal): Promise<void> {
    this.connectCalls += 1;
    this.setState('connecting');
    if (this.hang) {
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
    if ((this.sharedFail.failTimes ?? 0) > 0) {
      this.sharedFail.failTimes = (this.sharedFail.failTimes ?? 0) - 1;
      this.failTimes += 1;
      this.setState('offline');
      throw new Error('connect-failed');
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
      hub: { nodeId: ID.b, publicUrl: this.hubUrl },
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

  emitStaleList(list: UplinkNodeList): void {
    this.opts.onNodeList?.(list);
  }

  sendCtl(): void {}
  sendStatus(): void {
    this.statusSends += 1;
  }
  sendStatusIfChanged(): boolean {
    this.sendStatus();
    return true;
  }
  async openRelay(): Promise<never> {
    throw new Error('no relay');
  }
  async queryHubHead() {
    return null;
  }
  async queryKeyLogAt() {
    return null;
  }
  async appendAndAck() {
    return { ok: false as const, error: 'offline' };
  }
  async connectWithLink(): Promise<void> {}

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.stateListeners) cb(state);
  }
}

describe('mergeUplinkCandidates', () => {
  test('keeps stored order and appends unmatched seeds with priority 1000+index', () => {
    const stored = [
      {
        hubNodeId: ID.b,
        publicUrl: 'https://active.example',
        mode: 'active' as const,
        writerEpoch: 3,
        priority: 10,
        caFingerprint: null,
      },
      {
        hubNodeId: ID.c,
        publicUrl: 'https://standby.example',
        mode: 'standby' as const,
        writerEpoch: 1,
        priority: 20,
        caFingerprint: 'ab'.repeat(32),
      },
    ];
    const merged = mergeUplinkCandidates(stored, [
      'https://active.example/',
      'https://seed-a.example',
      'https://seed-b.example',
    ]);
    expect(merged.map((row) => row.publicUrl)).toEqual([
      'https://active.example',
      'https://standby.example',
      'https://seed-a.example',
      'https://seed-b.example',
    ]);
    expect(merged[2]).toMatchObject({
      hubNodeId: null,
      mode: 'active',
      writerEpoch: 0,
      priority: UPLINK_SEED_PRIORITY_BASE,
    });
    expect(merged[3]?.priority).toBe(UPLINK_SEED_PRIORITY_BASE + 1);
    expect(sameHubUrl('HTTPS://Active.Example:443/', 'https://active.example')).toBe(true);
  });
});

describe('recordsFromNodeList', () => {
  test('uses hubs[] when present and synthesizes a legacy hub record otherwise', () => {
    const fromHubs = recordsFromNodeList({
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
      hub: { nodeId: ID.b, publicUrl: 'https://old.example' },
      hubs: [
        {
          nodeId: ID.c,
          publicUrl: 'https://new.example',
          mode: 'standby',
          priority: 40,
          writerEpoch: 2,
        },
      ],
    });
    expect(fromHubs).toHaveLength(1);
    expect(fromHubs[0]?.hubNodeId).toBe(ID.c);
    expect(fromHubs[0]?.mode).toBe('standby');

    const legacy = recordsFromNodeList({
      t: 'node.list',
      version: 1,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
      hub: { nodeId: ID.b, publicUrl: 'https://old.example', name: 'hub' },
      writerEpoch: 9,
    });
    expect(legacy).toEqual([
      {
        hubNodeId: ID.b,
        publicUrl: 'https://old.example',
        name: 'hub',
        mode: 'active',
        priority: 100,
        writerEpoch: 9,
        caFingerprint: null,
        online: true,
        lastSeenAt: null,
      },
    ]);
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
    fetchCaPem?: (url: string) => Promise<string>;
    fingerprintPem?: (pem: string) => string;
  }) {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const hubTrust = new HubTrustStore(db);
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
      candidates: () =>
        input.urls.map((publicUrl, index) => ({
          hubNodeId: index === 0 ? ID.b : index === 1 ? ID.c : null,
          publicUrl,
          mode: (index === 0 ? 'active' : 'standby') as HubMode,
          writerEpoch: index === 0 ? 3 : 1,
          priority: 10 + index,
          caFingerprint: null,
        })),
      hubTrust,
      scheduler,
      failLimit: UPLINK_POOL_FAIL_LIMIT,
      authDeadlineMs: UPLINK_POOL_AUTH_DEADLINE_MS,
      probeIntervalMs: 60_000,
      probeTimeoutMs: 5_000,
      probeHealthz: async (url) => (input.probe ? input.probe(url) : false),
      fetchCaPem: input.fetchCaPem,
      fingerprintPem: input.fingerprintPem,
      createClient: ((opts: UplinkClientOptions) => {
        const fake = new FakeUplink(opts, input.behavior?.[opts.hubUrl] ?? {});
        created.push(fake);
        return fake as unknown as UplinkClient;
      }) as (opts: UplinkClientOptions) => UplinkClient,
    });
    fixtures.push({ close, stop: () => pool.stop() });
    return { pool, created, hubTrust, scheduler, close };
  }

  test('tries candidates in order and attaches the first that authenticates', async () => {
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 1 } },
    });
    pool.start();
    await waitMicro();
    expect(created.map((row) => row.hubUrl)).toEqual(['https://a.example']);
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    expect(pool.state).toBe('online');
    expect(created[0]?.statusSends).toBeGreaterThanOrEqual(1);
  });

  test('fails over after 3 consecutive connect failures', async () => {
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.start();
    await waitMicro();
    expect(created[0]?.connectCalls).toBe(3);
    expect(created.some((row) => row.hubUrl === 'https://b.example')).toBe(true);
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
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
    expect(created[0]?.hubUrl).toBe('https://a.example');
    expect(pool.attachedHub()).toBeNull();
    await scheduler.advance(UPLINK_POOL_AUTH_DEADLINE_MS);
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
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
    expect(pool.attachedHub()).toBeNull();
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    const standby = created.find((row) => row.hubUrl === 'https://b.example');
    const origStop = standby?.stop.bind(standby);
    if (standby && origStop) {
      standby.stop = async () => {
        order.push('stop:b');
        await origStop();
      };
    }
    await pool.switchTo('https://a.example');
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    const preferred = created.filter((row) => row.hubUrl === 'https://a.example').at(-1);
    expect(preferred?.statusSends).toBeGreaterThanOrEqual(1);
    expect(order.indexOf('attach:https://a.example')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stop:b')).toBeGreaterThan(order.indexOf('attach:https://a.example') - 1);
    expect(standby?.stopped).toBe(true);
  });

  test('generation guard drops node.list from a superseded link', async () => {
    const lists: Array<{ url: string; generation: number }> = [];
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
    });
    pool.onNodeList((_list, meta) => {
      lists.push({ url: pool.attachedHub()?.publicUrl ?? '', generation: meta.generation });
    });
    pool.start();
    await waitMicro();
    const gen = pool.currentGeneration();
    expect(gen).toBeGreaterThan(0);
    const stale = created.find((row) => row.hubUrl === 'https://a.example');
    stale?.emitStaleList({
      t: 'node.list',
      version: 9,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
      hub: { nodeId: ID.b, publicUrl: 'https://a.example' },
    });
    expect(lists.every((row) => row.generation === gen)).toBe(true);
    expect(lists.some((row) => row.url === 'https://a.example' && row.generation === gen)).toBe(
      false
    );
  });

  test('pins a per-URL CA only when the advertised fingerprint arrived on the live link', async () => {
    const { pool, created, hubTrust } = boot({
      urls: ['https://a.example'],
      fetchCaPem: async () => '-----BEGIN CERTIFICATE-----\nPINNED\n-----END CERTIFICATE-----',
      fingerprintPem: () => 'ab'.repeat(32),
    });
    pool.start();
    await waitMicro();
    const live = created[0];
    live?.emitStaleList({
      t: 'node.list',
      version: 2,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
      hubs: [
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          caFingerprint: 'ab'.repeat(32),
        },
      ],
    });
    await waitMicro();
    expect(hubTrust.get('https://b.example')?.fingerprint).toBe('ab'.repeat(32));
    expect(created[0]?.tlsCa).toBeNull();
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    aHealthy = true;
    await scheduler.advance(60_000);
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    expect(created.filter((row) => row.hubUrl === 'https://a.example').length).toBeGreaterThan(1);
  });
});

async function waitMicro(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
