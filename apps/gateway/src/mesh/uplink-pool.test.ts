import { afterEach, describe, expect, test } from 'bun:test';
import type { HubMode } from '@tmex/shared/uplink';
import { HubTrustStore } from '../auth/hub-trust-store';
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
import type { UplinkClient, UplinkClientOptions } from './uplink-client';
import {
  CA_BOOTSTRAP_MAX_BYTES,
  CA_BOOTSTRAP_TIMEOUT_MS,
  UPLINK_POOL_AUTH_DEADLINE_MS,
  UPLINK_POOL_FAIL_LIMIT,
  UPLINK_POOL_PROBE_JITTER,
  UPLINK_SEED_PRIORITY_BASE,
  type UplinkCandidate,
  UplinkPool,
  defaultFetchCaPem,
  isCaFingerprintHex,
  isSelfHubCandidate,
  mergeUplinkCandidates,
  parseSingleCaCertificate,
  recordsFromNodeList,
  sameHubUrl,
  spkiFingerprintFromPem,
} from './uplink-pool';
import type { UplinkNodeList } from './uplink-protocol';

const ID = {
  a: 'aa'.repeat(16),
  b: 'bb'.repeat(16),
  c: 'cc'.repeat(16),
};

const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBiTCCAS+gAwIBAgIUfcjUcjvqps+j66WfMK5nTB66IH0wCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHVGVzdCBDQTAeFw0yNjA5MDExMjQyMjVaFw0yNzA5MDExMjQy
MjVaMBIxEDAOBgNVBAMMB1Rlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AARW79kGjEFW4+Ueb2FviAO2IBOJdD2lWN6VopKfvyneN4Lut5OF/fMlSx5kKT9f
95QVrN1GPSkKnj52IdkENXPmo2MwYTAdBgNVHQ4EFgQU2KZVtCMikJHT2kNkteml
Z5MJzTAwHwYDVR0jBBgwFoAU2KZVtCMikJHT2kNktemlZ5MJzTAwDwYDVR0TAQH/
BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIhAJD13Sun
1WG27lzbwfxd5b6+xw+yDPORYStFfSEmgr6gAiAdpUqdYmGGVAEZXKxNP7FnGg6J
2fAjmnqZT1C+bcCDYg==
-----END CERTIFICATE-----`;

const TEST_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBZjCCAQugAwIBAgIUN7ce5vb8y1fkTeruYZraeDcsW/AwCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHVGVzdCBDQTAeFw0yNjA5MDExMjQyMjVaFw0yNjEwMDExMjQy
MjVaMA8xDTALBgNVBAMMBGxlYWYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS8
dNZ6oH3CoG9L0B/3uEMo9hSUzpam7+l6/5Ar25yzx5fMyiDxUpTVdSE2WIOK0cBP
1lQ9lPIXf/3EWxD//lDko0IwQDAdBgNVHQ4EFgQU+ymFVu6zJO165XlRhKu6947W
AHUwHwYDVR0jBBgwFoAU2KZVtCMikJHT2kNktemlZ5MJzTAwCgYIKoZIzj0EAwID
SQAwRgIhAPsGRvByfJSuRGKWp38ahUIFUnjw/hjBpz3vhYfxzyUoAiEAzCb/a+gc
dFY2r3AWRAnKtpOstYUq4ef+2DGeszC8j4k=
-----END CERTIFICATE-----`;

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
  error?: string;
};

class FakeUplink {
  state: UplinkState = 'offline';
  link: { closed: Promise<{ reason?: string }> } | null = null;
  hubUrl: string;
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

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
  }

  start(): void {}

  emitRelay(fromNodeId = ID.c): void {
    this.relayHandler?.({} as never, fromNodeId);
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
    if (this.sharedFail.gate) {
      const aborted = new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([this.sharedFail.gate.wait(), aborted]);
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
    this.statusIfChangedCalls += 1;
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
    candidates?: () => UplinkCandidate[];
    isLocalCandidate?: (cand: UplinkCandidate) => boolean;
    connectLocal?: (client: UplinkClient, signal: AbortSignal) => Promise<void>;
    onNodeList?: (list: UplinkNodeList) => void;
    onKeyLogFork?: (event: KeyLogForkEvent) => void;
    probeJitter?: number;
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
      candidates:
        input.candidates ??
        (() =>
          input.urls.map((publicUrl, index) => ({
            hubNodeId: index === 0 ? ID.b : index === 1 ? ID.c : null,
            publicUrl,
            mode: (index === 0 ? 'active' : 'standby') as HubMode,
            writerEpoch: index === 0 ? 3 : 1,
            priority: 10 + index,
            caFingerprint: null,
          }))),
      hubTrust,
      scheduler,
      failLimit: UPLINK_POOL_FAIL_LIMIT,
      authDeadlineMs: UPLINK_POOL_AUTH_DEADLINE_MS,
      probeIntervalMs: 60_000,
      probeTimeoutMs: 5_000,
      probeJitter: input.probeJitter ?? 0,
      probeHealthz: async (url) => (input.probe ? input.probe(url) : false),
      fetchCaPem: input.fetchCaPem,
      fingerprintPem: input.fingerprintPem,
      isLocalCandidate: input.isLocalCandidate,
      connectLocal: input.connectLocal,
      onNodeList: input.onNodeList
        ? (list) => {
            input.onNodeList?.(list);
          }
        : undefined,
      onKeyLogFork: input.onKeyLogFork,
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

  test('dual-role standby dials the remote active over WS, falls back to in-memory self, then probes back', async () => {
    const scheduler = new ManualScheduler();
    const selfUrl = 'https://self.example';
    const activeUrl = 'https://a.example';
    const aBehavior: FakeBehavior = {};
    const behavior: Record<string, FakeBehavior> = { [activeUrl]: aBehavior };
    let activeHealthy = true;
    const { pool, created } = boot({
      urls: [activeUrl, selfUrl],
      behavior,
      scheduler,
      candidates: () => [
        {
          hubNodeId: ID.b,
          publicUrl: activeUrl,
          mode: 'active',
          writerEpoch: 3,
          priority: 10,
          caFingerprint: null,
        },
        {
          hubNodeId: ID.a,
          publicUrl: selfUrl,
          mode: 'standby',
          writerEpoch: 1,
          priority: 20,
          caFingerprint: null,
        },
      ],
      isLocalCandidate: (cand) => cand.publicUrl === selfUrl,
      connectLocal: async (client) => {
        await (client as unknown as FakeUplink).connectWithLink();
      },
      probe: async (url) => url === activeUrl && activeHealthy,
    });
    pool.start();
    await waitMicro();
    expect(created[0]?.hubUrl).toBe(activeUrl);
    expect(created[0]?.transport).toBe('ws');
    expect(pool.attachedHub()?.publicUrl).toBe(activeUrl);

    aBehavior.failTimes = 99;
    created[0]?.drop();
    for (let i = 0; i < 16 && pool.attachedHub()?.publicUrl !== selfUrl; i += 1) {
      await scheduler.advance(1_000);
      await waitMicro();
    }
    const selfClient = created.find((row) => row.hubUrl === selfUrl);
    expect(selfClient?.transport).toBe('memory');
    expect(pool.attachedHub()?.publicUrl).toBe(selfUrl);

    aBehavior.failTimes = 0;
    activeHealthy = true;
    const probeHandle = scheduler.intervals.find((row) => !row.cleared);
    expect(probeHandle).toBeTruthy();
    await scheduler.advance(probeHandle?.ms ?? 60_000);
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe(activeUrl);
    expect(created.filter((row) => row.hubUrl === activeUrl).at(-1)?.transport).toBe('ws');
  });

  test('live node.list refreshes attached hubNodeId/mode/epoch and starts probe when attached is no longer preferred', async () => {
    const scheduler = new ManualScheduler();
    let rows: UplinkCandidate[] = [
      {
        hubNodeId: null,
        publicUrl: 'https://a.example',
        mode: 'active',
        writerEpoch: 1,
        priority: 10,
        caFingerprint: null,
      },
      {
        hubNodeId: ID.c,
        publicUrl: 'https://b.example',
        mode: 'standby',
        writerEpoch: 1,
        priority: 20,
        caFingerprint: null,
      },
    ];
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      candidates: () => rows,
      probe: async (url) => url === 'https://b.example',
      onNodeList: (list) => {
        rows = recordsFromNodeList(list).map((row) => ({
          hubNodeId: row.hubNodeId,
          publicUrl: row.publicUrl,
          mode: row.mode,
          writerEpoch: row.writerEpoch,
          priority: row.priority,
          caFingerprint: row.caFingerprint,
        }));
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.hubNodeId).toBeNull();

    created[0]?.emitStaleList({
      t: 'node.list',
      version: 2,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
      hub: { nodeId: ID.b, publicUrl: 'https://b.example' },
      hubs: [
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 4,
        },
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
        },
      ],
    });
    await waitMicro();
    expect(pool.attachedHub()).toMatchObject({
      publicUrl: 'https://a.example',
      hubNodeId: ID.b,
      mode: 'standby',
      writerEpoch: 1,
    });
    await scheduler.advance(60_000);
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
  });

  test('onNodeList meta.hubNodeId is the authenticated attached hub, not list.hub (writer)', async () => {
    const metas: Array<{ hubNodeId: string | null; generation: number }> = [];
    const { pool, created } = boot({
      urls: ['https://standby.example'],
      candidates: () => [
        {
          hubNodeId: ID.c,
          publicUrl: 'https://standby.example',
          mode: 'standby',
          writerEpoch: 1,
          priority: 20,
          caFingerprint: null,
        },
      ],
    });
    pool.onNodeList((_list, meta) => {
      metas.push(meta);
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.hubNodeId).toBe(ID.c);
    created[0]?.emitStaleList({
      t: 'node.list',
      version: 2,
      key_log_head: { seq: 0n, hash: new Uint8Array(32) },
      rtc: { stun: [], turn: null },
      nodes: [],
      hub: { nodeId: ID.b, publicUrl: 'https://writer.example' },
      hubs: [
        {
          nodeId: ID.b,
          publicUrl: 'https://writer.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://standby.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
        },
      ],
    });
    await waitMicro();
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((row) => row.hubNodeId === ID.c)).toBe(true);
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
          hubNodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          writerEpoch: 3,
          priority: 10,
          caFingerprint: null,
        },
        {
          hubNodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          writerEpoch: 1,
          priority: 20,
          caFingerprint: null,
        },
        {
          hubNodeId: 'dd'.repeat(16),
          publicUrl: 'https://c.example',
          mode: 'standby',
          writerEpoch: 1,
          priority: 30,
          caFingerprint: null,
        },
      ],
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    behavior['https://a.example'] = { gate: { wait: () => gateA } };
    const first = pool.switchTo('https://a.example');
    await waitMicro();
    const second = pool.switchTo('https://c.example');
    await second;
    expect(pool.attachedHub()?.publicUrl).toBe('https://c.example');
    releaseA();
    await first.catch(() => {});
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://c.example');
    expect(created.filter((row) => row.hubUrl === 'https://c.example').at(-1)?.stopped).toBe(false);
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
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
    expect(pool.attachedHub()).toBeNull();
    expect(created[0]?.hubUrl).toBe('https://a.example');
    created[0]?.emitRelay(ID.c);
    created[0]?.emitFork();
    expect(relays).toEqual([]);
    expect(forks).toEqual([]);
  });

  test('promote uses sendStatusIfChanged instead of a forced sendStatus', async () => {
    const { pool, created } = boot({ urls: ['https://a.example'] });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    expect(created[0]?.statusIfChangedCalls).toBeGreaterThanOrEqual(1);
  });

  test('isSelfHubCandidate matches own node id or normalized public URL', () => {
    expect(
      isSelfHubCandidate(
        {
          hubNodeId: ID.a,
          publicUrl: 'https://hub.example',
        },
        { nodeId: ID.a, publicUrl: 'https://other.example' }
      )
    ).toBe(true);
    expect(
      isSelfHubCandidate(
        {
          hubNodeId: ID.b,
          publicUrl: 'HTTPS://Hub.Example:443/',
        },
        { nodeId: ID.a, publicUrl: 'https://hub.example' }
      )
    ).toBe(true);
    expect(
      isSelfHubCandidate(
        {
          hubNodeId: ID.b,
          publicUrl: 'https://remote.example',
        },
        { nodeId: ID.a, publicUrl: 'https://hub.example' }
      )
    ).toBe(false);
  });

  test('accepts exactly one CA certificate and rejects two PEMs / non-CA / bad fingerprint', () => {
    const ca = parseSingleCaCertificate(TEST_CA_PEM);
    expect(ca.ca).toBe(true);
    expect(spkiFingerprintFromPem(TEST_CA_PEM)).toBe(
      '0f47afc79f7ccd374c52146fc47c9e30896b899a119966fcefc3c912014c76bd'
    );
    expect(() => parseSingleCaCertificate(`${TEST_CA_PEM}\n${TEST_LEAF_PEM}`)).toThrow();
    expect(() => parseSingleCaCertificate(TEST_LEAF_PEM)).toThrow();
    expect(isCaFingerprintHex('ab'.repeat(32))).toBe(true);
    expect(isCaFingerprintHex('ab'.repeat(31))).toBe(false);
    expect(isCaFingerprintHex('zz'.repeat(32))).toBe(false);
  });

  test('oversized body, two PEMs, non-CA cert and hanging fetch are rejected and nothing is pinned', async () => {
    const fp = '0f47afc79f7ccd374c52146fc47c9e30896b899a119966fcefc3c912014c76bd';
    const fetches: string[] = [];
    const { pool, created, hubTrust } = boot({
      urls: ['https://a.example'],
      fetchCaPem: async (publicUrl) => {
        fetches.push(publicUrl);
        if (publicUrl === 'https://oversized.example') {
          return defaultFetchCaPem(publicUrl, {
            fetch: async () => new Response('x'.repeat(CA_BOOTSTRAP_MAX_BYTES + 1)),
            timeoutMs: 30,
          });
        }
        if (publicUrl === 'https://two-pem.example') {
          return defaultFetchCaPem(publicUrl, {
            fetch: async () => new Response(`${TEST_CA_PEM}\n${TEST_LEAF_PEM}`),
            timeoutMs: 30,
          });
        }
        if (publicUrl === 'https://leaf.example') {
          return defaultFetchCaPem(publicUrl, {
            fetch: async () => new Response(TEST_LEAF_PEM),
            timeoutMs: 30,
          });
        }
        if (publicUrl === 'https://hang.example') {
          return defaultFetchCaPem(publicUrl, {
            fetch: () => new Promise<Response>(() => {}),
            timeoutMs: 30,
          });
        }
        throw new Error(`unexpected fetch ${publicUrl}`);
      },
    });
    pool.start();
    await waitMicro();
    const live = created[0];
    const emit = (url: string, fingerprint: string, version: number) => {
      live?.emitStaleList({
        t: 'node.list',
        version,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hubs: [
          {
            nodeId: ID.c,
            publicUrl: url,
            mode: 'standby',
            priority: 20,
            writerEpoch: 1,
            caFingerprint: fingerprint,
          },
        ],
      });
    };
    emit('https://oversized.example', fp, 2);
    emit('https://two-pem.example', fp, 3);
    emit('https://leaf.example', spkiFingerprintFromPem(TEST_LEAF_PEM), 4);
    emit('https://hang.example', fp, 5);
    emit('https://badfp.example', 'not-a-fingerprint', 6);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hubTrust.get('https://oversized.example')).toBeNull();
    expect(hubTrust.get('https://two-pem.example')).toBeNull();
    expect(hubTrust.get('https://leaf.example')).toBeNull();
    expect(hubTrust.get('https://hang.example')).toBeNull();
    expect(hubTrust.get('https://badfp.example')).toBeNull();
    expect(fetches).not.toContain('https://badfp.example');
    expect(CA_BOOTSTRAP_TIMEOUT_MS).toBe(5_000);
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
      expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
      const a = pool.candidates().find((row) => row.publicUrl === 'https://a.example');
      const b = pool.candidates().find((row) => row.publicUrl === 'https://b.example');
      expect(a?.lastError).toBe('connect-failed');
      expect(a?.lastAttemptAt).toBeGreaterThan(0);
      expect(b?.lastError).toBeNull();
      expect(b?.lastAttemptAt).toBeGreaterThan(0);
      expect(
        lines.some((row) =>
          row.includes(
            '[uplink] try hub=https://a.example mode=active epoch=3 idx=1/2 transport=ws'
          )
        )
      ).toBe(true);
      expect(
        lines.some((row) =>
          /\[uplink] candidate failed hub=https:\/\/a\.example err=connect-failed fails=\d+/.test(
            row
          )
        )
      ).toBe(true);
      expect(lines.some((row) => row.includes('[uplink] failover → hub=https://b.example'))).toBe(
        true
      );
      expect(
        lines.some((row) =>
          row.includes(
            '[uplink] try hub=https://b.example mode=standby epoch=1 idx=2/2 transport=ws'
          )
        )
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
          row.includes('[uplink] candidate failed hub=https://a.example err=connect-failed')
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

  test('logs TLS failure when a candidate has no pin and no advertised fingerprint', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { pool } = boot({
        urls: ['https://b.example'],
        behavior: {
          'https://b.example': {
            failTimes: 3,
            error: 'unable to verify the first certificate',
          },
        },
        candidates: () => [
          {
            hubNodeId: ID.c,
            publicUrl: 'https://b.example',
            mode: 'standby',
            writerEpoch: 1,
            priority: 20,
            caFingerprint: null,
          },
        ],
      });
      pool.start();
      await waitMicro();
      expect(
        lines.some((row) =>
          row.includes('no CA pin for https://b.example and no advertised fingerprint')
        )
      ).toBe(true);
      expect(pool.candidates()[0]?.lastError).toContain('certificate');
    } finally {
      console.info = originalInfo;
    }
  });

  test('logs CA pin stored and bootstrap failures', async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const fp = 'ab'.repeat(32);
      const { pool, created } = boot({
        urls: ['https://a.example'],
        fetchCaPem: async (url) => {
          if (url === 'https://ok.example') return 'pem-ok';
          throw new Error('ca_unavailable');
        },
        fingerprintPem: () => fp,
      });
      pool.start();
      await waitMicro();
      created[0]?.emitStaleList({
        t: 'node.list',
        version: 2,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [],
        hubs: [
          {
            nodeId: ID.c,
            publicUrl: 'https://ok.example',
            mode: 'standby',
            priority: 20,
            writerEpoch: 1,
            caFingerprint: fp,
          },
          {
            nodeId: ID.b,
            publicUrl: 'https://bad.example',
            mode: 'standby',
            priority: 30,
            writerEpoch: 1,
            caFingerprint: fp,
          },
        ],
      });
      await waitMicro();
      expect(
        lines.some((row) => row.includes('[uplink] ca pin stored url=https://ok.example fp='))
      ).toBe(true);
      expect(
        lines.some((row) =>
          row.includes('[uplink] ca bootstrap failed url=https://bad.example err=ca_unavailable')
        )
      ).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });

  test('retries CA bootstrap immediately when a later node.list brings a fingerprint', async () => {
    const fetches: string[] = [];
    const fp = 'ab'.repeat(32);
    const { pool, created, hubTrust } = boot({
      urls: ['https://a.example'],
      fetchCaPem: async (url) => {
        fetches.push(url);
        return 'pem-ok';
      },
      fingerprintPem: () => fp,
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
          caFingerprint: null,
        },
      ],
    });
    await waitMicro();
    expect(fetches).toEqual([]);
    live?.emitStaleList({
      t: 'node.list',
      version: 3,
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
          caFingerprint: fp,
        },
      ],
    });
    await waitMicro();
    expect(fetches).toEqual(['https://b.example']);
    expect(hubTrust.get('https://b.example')?.fingerprint).toBe(fp);
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
      expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
      aHealthy = true;
      await scheduler.advance(60_000);
      await waitMicro();
      expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
      expect(lines.some((row) => row.includes('[uplink] probe ok hub=https://a.example'))).toBe(
        true
      );
      expect(
        lines.some((row) => row.includes('[uplink] switch-back → hub=https://a.example'))
      ).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });
});

async function waitMicro(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
