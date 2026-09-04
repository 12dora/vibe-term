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
  PooledUplink,
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
  hubSupportsNearestAttach,
  isCaFingerprintHex,
  isRttSwitchWorth,
  isSelfHubCandidate,
  mergeUplinkCandidates,
  orderCandidatesByNearest,
  parseSingleCaCertificate,
  recordsFromNodeList,
  redactUrl,
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

const TEST_CA_NO_KEYCERTSIGN_PEM = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUT8FY+W5hug6nG5vueMwXaDshVRkwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQTm9LZXlDZXJ0U2lnbiBDQTAeFw0yNjA5MDExNDI0MjlaFw0z
NjA4MjkxNDI0MjlaMBsxGTAXBgNVBAMMEE5vS2V5Q2VydFNpZ24gQ0EwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQcItg/y6rTlmK2LBi9wmymzf3VY/cFmbHWthsN
NvkJyibdpK1z42aUuCAkyIYSxSJ8ptzgWkhUBBo/wWENvgifo2MwYTAdBgNVHQ4E
FgQU0nBKs235Pe9UYsE2dM9Cryc50AIwHwYDVR0jBBgwFoAU0nBKs235Pe9UYsE2
dM9Cryc50AIwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCB4AwCgYIKoZI
zj0EAwIDSQAwRgIhAI9VqjBY1tl4Z2KDLSw+UwjoUyZq661vR7SB82sW+tk5AiEA
1UwXwTgvvf5XSWFcFGOm79IWF8xB3qCwSCMOOMtcOfo=
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
  test('globally sorts active (epoch desc, priority asc), then standby, then unknown-mode seeds', () => {
    const stored = [
      {
        hubNodeId: ID.c,
        publicUrl: 'https://standby.example',
        mode: 'standby' as const,
        writerEpoch: 1,
        priority: 20,
        caFingerprint: 'ab'.repeat(32),
      },
      {
        hubNodeId: ID.b,
        publicUrl: 'https://active.example',
        mode: 'active' as const,
        writerEpoch: 3,
        priority: 10,
        caFingerprint: null,
      },
    ];
    const merged = mergeUplinkCandidates(stored, [
      'https://active.example/',
      'https://seed-a.example',
      'https://seed-b.example',
    ]);
    expect(merged.map((row) => row.publicUrl)).toEqual([
      'https://active.example',
      'https://seed-a.example',
      'https://seed-b.example',
      'https://standby.example',
    ]);
    expect(merged[1]).toMatchObject({
      hubNodeId: null,
      mode: 'active',
      writerEpoch: 0,
      priority: UPLINK_SEED_PRIORITY_BASE,
    });
    expect(merged[2]?.priority).toBe(UPLINK_SEED_PRIORITY_BASE + 1);
    expect(sameHubUrl('HTTPS://Active.Example:443/', 'https://active.example')).toBe(true);
  });

  test('fresh standby own row plus TMEX_HUB_URL seed ranks the seed active above own standby', () => {
    const own = {
      hubNodeId: ID.a,
      publicUrl: 'https://self.example',
      mode: 'standby' as const,
      writerEpoch: 1,
      priority: 20,
      caFingerprint: null,
    };
    const merged = mergeUplinkCandidates([own], ['https://hub.example']);
    expect(merged.map((row) => row.publicUrl)).toEqual([
      'https://hub.example',
      'https://self.example',
    ]);
    expect(merged[0]).toMatchObject({
      hubNodeId: null,
      mode: 'active',
      writerEpoch: 0,
      priority: UPLINK_SEED_PRIORITY_BASE,
    });
    expect(merged[1]).toMatchObject({
      hubNodeId: ID.a,
      mode: 'standby',
      writerEpoch: 1,
      priority: 20,
    });
  });
});

describe('redactUrl', () => {
  test('prints origin only and strips userinfo, query and fragment', () => {
    expect(redactUrl('https://user:secret@hub.example:8443/path?q=1#frag')).toBe(
      'https://hub.example:8443'
    );
    expect(redactUrl('http://hub.example/foo')).toBe('http://hub.example');
    expect(redactUrl('https://hub.example:443/')).toBe('https://hub.example');
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
    connectLocal?: (client: PooledUplink, signal: AbortSignal) => Promise<void>;
    onNodeList?: (list: UplinkNodeList) => void;
    onKeyLogFork?: (event: KeyLogForkEvent) => void;
    probeJitter?: number;
    enablePeriodicRttProbe?: boolean;
    rttProbeIntervalMs?: number;
    failbackDebounceMs?: number;
    preferNearest?: boolean | null;
    localRoles?: { hub?: boolean; node?: boolean; relay?: boolean };
    rttSwitchDwellMs?: number;
    versions?: Record<string, string>;
    onHubTokens?: (msg: import('@tmex/shared/uplink').HubTokensMessage) => void;
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
            version: input.versions?.[publicUrl] ?? '1.1.13',
          }))),
      hubTrust,
      scheduler,
      failLimit: UPLINK_POOL_FAIL_LIMIT,
      authDeadlineMs: UPLINK_POOL_AUTH_DEADLINE_MS,
      probeIntervalMs: 60_000,
      probeTimeoutMs: 5_000,
      probeJitter: input.probeJitter ?? 0,
      enablePeriodicRttProbe: input.enablePeriodicRttProbe,
      rttProbeIntervalMs: input.rttProbeIntervalMs,
      failbackDebounceMs: input.failbackDebounceMs,
      preferNearest: input.preferNearest,
      localRoles: input.localRoles,
      rttSwitchDwellMs: input.rttSwitchDwellMs,
      onHubTokens: input.onHubTokens
        ? (msg) => {
            input.onHubTokens?.(msg);
          }
        : undefined,
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

  test('fresh standby with own stored row plus hub seed dials the seed first and self only as fallback', async () => {
    const selfUrl = 'https://self.example';
    const seedUrl = 'https://hub.example';
    const stored = [
      {
        hubNodeId: ID.a,
        publicUrl: selfUrl,
        mode: 'standby' as const,
        writerEpoch: 1,
        priority: 20,
        caFingerprint: null,
      },
    ];
    const { pool, created } = boot({
      urls: [selfUrl, seedUrl],
      candidates: () => mergeUplinkCandidates(stored, [seedUrl]),
      isLocalCandidate: (cand) => cand.publicUrl === selfUrl,
      connectLocal: async (client) => {
        await (client as unknown as FakeUplink).connectWithLink();
      },
    });
    pool.start();
    await waitMicro();
    expect(created[0]?.hubUrl).toBe(seedUrl);
    expect(created[0]?.transport).toBe('ws');
    expect(pool.attachedHub()?.publicUrl).toBe(seedUrl);
    expect(created.some((row) => row.hubUrl === selfUrl)).toBe(false);
  });

  test('attached to self standby still probes when a higher-ranked seed exists', async () => {
    const scheduler = new ManualScheduler();
    const selfUrl = 'https://self.example';
    const seedUrl = 'https://hub.example';
    const stored = [
      {
        hubNodeId: ID.a,
        publicUrl: selfUrl,
        mode: 'standby' as const,
        writerEpoch: 1,
        priority: 20,
        caFingerprint: null,
      },
    ];
    let seedHealthy = true;
    const { pool, created } = boot({
      urls: [selfUrl, seedUrl],
      behavior: { [seedUrl]: { failTimes: 3 } },
      scheduler,
      candidates: () => mergeUplinkCandidates(stored, [seedUrl]),
      isLocalCandidate: (cand) => cand.publicUrl === selfUrl,
      connectLocal: async (client) => {
        await (client as unknown as FakeUplink).connectWithLink();
      },
      probe: async (url) => url === seedUrl && seedHealthy,
    });
    pool.start();
    await waitMicro();
    expect(created[0]?.hubUrl).toBe(seedUrl);
    expect(pool.attachedHub()?.publicUrl).toBe(selfUrl);
    expect(created.find((row) => row.hubUrl === selfUrl)?.transport).toBe('memory');
    const probeHandle = scheduler.intervals.find((row) => !row.cleared);
    expect(probeHandle).toBeTruthy();
    seedHealthy = true;
    await scheduler.advance(probeHandle?.ms ?? 60_000);
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe(seedUrl);
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
    expect(pool.attachedHub()).toMatchObject({
      publicUrl: 'https://a.example',
      hubNodeId: ID.b,
      mode: 'standby',
      writerEpoch: 1,
    });
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
    expect(() => parseSingleCaCertificate(TEST_CA_NO_KEYCERTSIGN_PEM)).toThrow(
      'ca_no_key_cert_sign'
    );
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
      expect(a?.lastErrorAt).toBeGreaterThan(0);
      expect(a?.lastAttemptAt).toBeGreaterThan(0);
      expect(b?.lastError).toBeNull();
      expect(b?.lastErrorAt).toBeNull();
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
            hubNodeId: ID.b,
            publicUrl: dirty,
            mode: 'active',
            writerEpoch: 3,
            priority: 10,
            caFingerprint: null,
          },
        ],
      });
      pool.start();
      await waitMicro();
      expect(lines.some((row) => row.includes('secret') || row.includes('token=abc'))).toBe(false);
      expect(
        lines.some((row) =>
          row.includes('[uplink] try hub=https://hub.example:8443 mode=active epoch=3')
        )
      ).toBe(true);
      expect(
        lines.some((row) =>
          row.includes('[uplink] candidate failed hub=https://hub.example:8443 err=connect-failed')
        )
      ).toBe(true);
    } finally {
      console.info = originalInfo;
    }
  });

  test('node.list writer flipping online triggers an immediate failback probe', async () => {
    const scheduler = new ManualScheduler();
    let aHealthy = false;
    const probed: string[] = [];
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      behavior: { 'https://a.example': { failTimes: 3 } },
      scheduler,
      probe: async (url) => {
        probed.push(url);
        return url === 'https://a.example' && aHealthy;
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    expect(probed).toEqual([]);

    const live = created.find((row) => row.hubUrl === 'https://b.example');
    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
          online: false,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');

    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
          online: false,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);

    await scheduler.advance(5_000);
    aHealthy = true;
    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
          online: true,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    expect(probed.length).toBeGreaterThanOrEqual(2);
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    expect(scheduler.intervals.filter((row) => !row.cleared && row.ms >= 50_000).length).toBe(0);
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
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

  test('requestProbeNow with a sooner deadline replaces a pending 5s failback probe', async () => {
    const scheduler = new ManualScheduler();
    const probed: string[] = [];
    const { pool, created } = boot({
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    const live = created.find((row) => row.hubUrl === 'https://b.example');
    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
          online: true,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);
    probed.length = 0;

    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 4,
          online: true,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    expect(probed).toEqual([]);

    pool.requestProbeNow();
    await waitMicro();
    expect(probed).toEqual([]);

    await scheduler.advance(1_999);
    await waitMicro();
    expect(probed).toEqual([]);

    await scheduler.advance(1);
    await waitMicro();
    expect(probed).toEqual(['https://a.example']);
  });

  test('node.list failback probes are debounced to 5s and coalesced while in flight', async () => {
    const scheduler = new ManualScheduler();
    let probeStarted = 0;
    let releaseProbe: () => void = () => {};
    const { pool, created } = boot({
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
    const live = created.find((row) => row.hubUrl === 'https://b.example');
    const offlineWriter = hubStatusList([
      {
        nodeId: ID.b,
        publicUrl: 'https://a.example',
        mode: 'active',
        priority: 10,
        writerEpoch: 3,
        online: false,
      },
      {
        nodeId: ID.c,
        publicUrl: 'https://b.example',
        mode: 'standby',
        priority: 20,
        writerEpoch: 1,
        online: true,
      },
    ]);
    live?.emitStaleList(offlineWriter);
    await waitMicro();
    expect(probeStarted).toBe(1);

    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 4,
          online: true,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    expect(probeStarted).toBe(1);

    releaseProbe();
    await waitMicro();
    expect(probeStarted).toBe(1);

    await scheduler.advance(5_000);
    await waitMicro();
    expect(probeStarted).toBe(2);
  });

  test('node.list does not probe when hub view is unchanged', async () => {
    const scheduler = new ManualScheduler();
    const probed: string[] = [];
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const { pool, created } = boot({
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
      const live = created.find((row) => row.hubUrl === 'https://b.example');
      const list = hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
          online: false,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ]);
      live?.emitStaleList(list);
      await waitMicro();
      expect(probed).toEqual(['https://a.example']);
      const triggers = () =>
        lines.filter((row) => row.includes('[uplink] failback probe triggered by node.list'));
      expect(triggers().length).toBe(1);

      live?.emitStaleList(list);
      await waitMicro();
      expect(probed).toEqual(['https://a.example']);
      expect(triggers().length).toBe(1);
      expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    } finally {
      console.info = originalInfo;
    }
  });

  test('healthz probes record per-URL rttMs and rttAt on the candidate snapshot', async () => {
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
    const live = created.find((row) => row.hubUrl === 'https://b.example');
    aHealthy = true;
    live?.emitStaleList(
      hubStatusList([
        {
          nodeId: ID.b,
          publicUrl: 'https://a.example',
          mode: 'active',
          priority: 10,
          writerEpoch: 3,
          online: true,
        },
        {
          nodeId: ID.c,
          publicUrl: 'https://b.example',
          mode: 'standby',
          priority: 20,
          writerEpoch: 1,
          online: true,
        },
      ])
    );
    await waitMicro();
    const a = pool.candidates().find((row) => row.publicUrl === 'https://a.example');
    expect(a?.rttMs).toEqual(expect.any(Number));
    expect(a?.rttMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(a?.rttAt).toBe(scheduler.nowMs);
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
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
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    expect(scheduler.intervals.filter((row) => !row.cleared)).toEqual([]);
  });

  test('nearest ordering uses EWMA samples and keeps epoch/priority without them', () => {
    const writer: UplinkCandidate = {
      hubNodeId: ID.b,
      publicUrl: 'https://a.example',
      mode: 'active',
      writerEpoch: 3,
      priority: 10,
      caFingerprint: null,
      version: '1.1.13',
    };
    const standby: UplinkCandidate = {
      hubNodeId: ID.c,
      publicUrl: 'https://b.example',
      mode: 'standby',
      writerEpoch: 1,
      priority: 20,
      caFingerprint: null,
      version: '1.1.13',
    };
    const rtts = new Map<string, { ewma: number; samples: number }>();
    const orderedWithout = orderCandidatesByNearest([writer, standby], {
      rttOf: (url) => rtts.get(url) ?? null,
      writerHubId: ID.b,
      versionOf: (cand) => cand.version,
    });
    expect(orderedWithout.map((row) => row.publicUrl)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    rtts.set('https://a.example', { ewma: 80, samples: 2 });
    rtts.set('https://b.example', { ewma: 20, samples: 2 });
    const ordered = orderCandidatesByNearest([writer, standby], {
      rttOf: (url) => rtts.get(url) ?? null,
      writerHubId: ID.b,
      versionOf: (cand) => cand.version,
    });
    expect(ordered.map((row) => row.publicUrl)).toEqual(['https://b.example', 'https://a.example']);
    rtts.set('https://b.example', { ewma: 20, samples: 1 });
    const notEnough = orderCandidatesByNearest([writer, standby], {
      rttOf: (url) => rtts.get(url) ?? null,
      writerHubId: ID.b,
      versionOf: (cand) => cand.version,
    });
    expect(notEnough.map((row) => row.publicUrl)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  test('legacy hubs below 1.1.13 are never ordered over the writer', () => {
    const writer: UplinkCandidate = {
      hubNodeId: ID.b,
      publicUrl: 'https://a.example',
      mode: 'active',
      writerEpoch: 3,
      priority: 10,
      caFingerprint: null,
      version: '1.1.13',
    };
    const legacy: UplinkCandidate = {
      hubNodeId: ID.c,
      publicUrl: 'https://b.example',
      mode: 'standby',
      writerEpoch: 1,
      priority: 20,
      caFingerprint: null,
      version: '1.1.12',
    };
    const rtts = new Map([
      ['https://a.example', { ewma: 80, samples: 2 }],
      ['https://b.example', { ewma: 5, samples: 2 }],
    ]);
    const ordered = orderCandidatesByNearest([writer, legacy], {
      rttOf: (url) => rtts.get(url) ?? null,
      writerHubId: ID.b,
      versionOf: (cand) => cand.version,
    });
    expect(ordered[0]?.publicUrl).toBe('https://a.example');
    expect(hubSupportsNearestAttach('1.1.12')).toBe(false);
    expect(hubSupportsNearestAttach('1.1.13')).toBe(true);
  });

  test('RTT hysteresis requires 30% and 15ms improvement', () => {
    expect(isRttSwitchWorth(100, 80)).toBe(false);
    expect(isRttSwitchWorth(100, 70)).toBe(true);
    expect(isRttSwitchWorth(20, 6)).toBe(false);
    expect(isRttSwitchWorth(20, 5)).toBe(true);
  });

  test('prefer-nearest switches to a faster hub after two samples', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      preferNearest: true,
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 1_000,
      rttSwitchDwellMs: 60_000,
      probe: async (url) => {
        await Bun.sleep(url === 'https://a.example' ? 40 : 5);
        return true;
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
  });

  test('prefer-nearest dwell blocks a second RTT-motivated switch', async () => {
    const scheduler = new ManualScheduler();
    let aDelay = 50;
    let bDelay = 5;
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      preferNearest: true,
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 1_000,
      rttSwitchDwellMs: 60_000,
      probe: async (url) => {
        await Bun.sleep(url === 'https://a.example' ? aDelay : bDelay);
        return true;
      },
    });
    pool.start();
    await waitMicro();
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
    aDelay = 5;
    bDelay = 50;
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    expect(pool.attachedHub()?.publicUrl).toBe('https://b.example');
  });

  test('legacy standby is not chosen over the writer even with better RTT', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      preferNearest: true,
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 1_000,
      versions: { 'https://a.example': '1.1.13', 'https://b.example': '1.1.12' },
      probe: async (url) => {
        await Bun.sleep(url === 'https://a.example' ? 40 : 5);
        return true;
      },
    });
    pool.start();
    await waitMicro();
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
  });

  test('hub 角色禁用 RTT 切换，保持写者控制面上行', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      preferNearest: true,
      localRoles: { hub: true, node: true, relay: false },
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 1_000,
      probe: async (url) => {
        await Bun.sleep(url === 'https://a.example' ? 40 : 5);
        return true;
      },
    });
    pool.start();
    await waitMicro();
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
  });

  test('被替换 uplink 上迟到的 hub.tokens 丢弃', async () => {
    const received: unknown[] = [];
    const scheduler = new ManualScheduler();
    const { pool, created } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      preferNearest: false,
      onHubTokens: (msg) => {
        received.push(msg);
      },
    });
    pool.start();
    await waitMicro();
    expect(created.length).toBeGreaterThan(0);
    const first = created[0];
    await pool.switchTo('https://b.example');
    first?.opts.onHubTokens?.({
      t: 'hub.tokens',
      op: 'upsert',
      revision: { epoch: 1, seq: 1 },
      tokens: [],
    });
    expect(received).toEqual([]);
  });

  test('forced-off prefer-nearest keeps epoch/priority attach', async () => {
    const scheduler = new ManualScheduler();
    const { pool } = boot({
      urls: ['https://a.example', 'https://b.example'],
      scheduler,
      preferNearest: false,
      enablePeriodicRttProbe: true,
      rttProbeIntervalMs: 1_000,
      probe: async (url) => {
        await Bun.sleep(url === 'https://a.example' ? 40 : 5);
        return true;
      },
    });
    pool.start();
    await waitMicro();
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    await scheduler.advance(1_000);
    await Bun.sleep(120);
    expect(pool.attachedHub()?.publicUrl).toBe('https://a.example');
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

function hubStatusList(
  hubs: Array<{
    nodeId: string;
    publicUrl: string;
    mode: HubMode;
    priority: number;
    writerEpoch: number;
    online?: boolean;
  }>
): UplinkNodeList {
  const writer = hubs.find((row) => row.mode === 'active') ?? hubs[0];
  return {
    t: 'node.list',
    version: 2,
    key_log_head: { seq: 0n, hash: new Uint8Array(32) },
    rtc: { stun: [], turn: null },
    nodes: [],
    hub: writer ? { nodeId: writer.nodeId, publicUrl: writer.publicUrl } : undefined,
    writerHubId: writer?.nodeId,
    writerEpoch: writer?.writerEpoch,
    hubs: hubs.map((row) => ({
      nodeId: row.nodeId,
      publicUrl: row.publicUrl,
      mode: row.mode,
      priority: row.priority,
      writerEpoch: row.writerEpoch,
      online: row.online,
    })),
  };
}

async function waitMicro(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
