import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { orderRelaysByPreferred } from './relay-preferred';
import { seedUser } from './test-support';
import type {
  KeyLogApplier,
  MeshIdentity,
  MeshScheduler,
  PooledUplink,
  UplinkState,
} from './types';
import type { UplinkClientOptions } from './uplink-client';
import {
  UPLINK_POOL_AUTH_DEADLINE_MS,
  UPLINK_POOL_FAIL_LIMIT,
  type UplinkCandidate,
  UplinkPool,
} from './uplink-pool';

const SH = 'https://sh.example';
const TK = 'https://tk.example';
const JP = 'https://jp.example';
const ID = { a: 'aa'.repeat(16) };

const ROWS = [
  { url: SH, priority: 0 },
  { url: TK, priority: 1 },
  { url: JP, priority: 2 },
];

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

class ManualScheduler implements MeshScheduler {
  nowMs = 1_000;
  readonly intervals: Array<{ fn: () => void; ms: number; cleared: boolean; dueAt: number }> = [];
  private sleepers: Array<{ at: number; resolve: () => void; reject: (err: Error) => void }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      const entry = { at: this.nowMs + ms, resolve, reject };
      this.sleepers.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((row) => row !== entry);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true }
      );
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

class FakeUplink {
  state: UplinkState = 'offline';
  link: { closed: Promise<{ reason?: string }> } | null = null;
  uplinkUrl: string;
  userId: string;
  identity: MeshIdentity;
  lastConnectError: { reason: string; at: number } | null = null;
  lastKeyLogHead = null;
  private readonly fail: { times: number };
  private readonly listeners: Array<(state: UplinkState) => void> = [];
  private closeResolve: ((info: { reason?: string }) => void) | null = null;

  constructor(opts: UplinkClientOptions, fail: { times: number }) {
    this.uplinkUrl = opts.uplinkUrl;
    this.identity = opts.identity;
    this.userId = typeof opts.userId === 'function' ? opts.userId() : opts.userId;
    this.fail = fail;
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  setOnRelayStream(): void {}

  async attemptConnect(): Promise<void> {
    if (this.fail.times > 0) {
      this.fail.times -= 1;
      this.setState('offline');
      throw new Error('connect-failed');
    }
    this.link = {
      closed: new Promise((resolve) => {
        this.closeResolve = resolve;
      }),
    };
    this.setState('online');
  }

  async connectWithLink(): Promise<void> {
    await this.attemptConnect();
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

  sendCtl(): void {}
  sendStatus(): void {}
  sendStatusIfChanged(): boolean {
    return true;
  }
  async openRelay(): Promise<never> {
    throw new Error('no relay');
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
  requestCatchUpNow(): void {}

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.listeners) cb(state);
  }
}

async function waitMicro(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function cand(row: { url: string; priority: number }): UplinkCandidate {
  return {
    uplinkNodeId: null,
    publicUrl: row.url,
    mode: 'active',
    writerEpoch: 0,
    priority: row.priority,
    caFingerprint: null,
  };
}

describe('autoPreferred vs probePreferred ping-pong', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('auto switch to priority 2 is not pulled back; downed auto-preferred failsover', async () => {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const scheduler = new ManualScheduler();
    let autoPreferred: string | null = null;
    const failByUrl: Record<string, { times: number }> = {
      [SH]: { times: 0 },
      [TK]: { times: 0 },
      [JP]: { times: 0 },
    };
    const created: FakeUplink[] = [];
    const pool = new UplinkPool({
      identity: { nodeId: ID.a, edSecretKey: new Uint8Array(32).fill(7) },
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
      candidates: () => orderRelaysByPreferred(ROWS, autoPreferred).map(cand),
      scheduler,
      failLimit: UPLINK_POOL_FAIL_LIMIT,
      authDeadlineMs: UPLINK_POOL_AUTH_DEADLINE_MS,
      probeIntervalMs: 60_000,
      probeTimeoutMs: 5_000,
      probeJitter: 0,
      enablePeriodicRttProbe: false,
      probeHealthz: async () => true,
      createClient: ((opts: UplinkClientOptions) => {
        const fake = new FakeUplink(opts, failByUrl[opts.uplinkUrl] ?? { times: 0 });
        created.push(fake);
        return fake as unknown as PooledUplink;
      }) as never,
    });
    fixtures.push({ close, stop: () => pool.stop() });
    pool.start();
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe(SH);

    expect(await pool.switchTo(JP)).toEqual({ ok: true });
    expect(pool.attachedUplink()?.publicUrl).toBe(JP);
    autoPreferred = JP;
    pool.refreshCandidates();
    expect(pool.candidates()[0]?.publicUrl).toBe(JP);

    for (let i = 0; i < 3; i += 1) {
      await scheduler.advance(60_000);
      await waitMicro();
    }
    expect(pool.attachedUplink()?.publicUrl).toBe(JP);

    failByUrl[JP].times = 3;
    created
      .filter((row) => row.uplinkUrl === JP)
      .at(-1)
      ?.drop();
    await waitMicro();
    await scheduler.advance(1_000);
    await waitMicro();
    expect(pool.attachedUplink()?.publicUrl).toBe(SH);
  });
});
