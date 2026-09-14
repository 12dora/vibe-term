import { describe, expect, test } from 'bun:test';
import type { LinkSession, LinkStream, StreamCloseInfo } from '@vibeterm/shared/link';
import { RelayCaPinStore } from '../auth/relay-ca-pin-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { reconfigureUplinkPool } from './relay-wiring';
import { seedUser, waitUntil } from './test-support';
import type { KeyLogApplier, PooledUplink, UplinkState, UplinkStatus } from './types';
import { type UplinkCandidate, UplinkPool } from './uplink-pool';

const applier: KeyLogApplier = {
  async head() {
    return { seq: 0n, hash: new Uint8Array(32) };
  },
  async applyMany() {
    return { applied: 0 };
  },
};

function status(): UplinkStatus {
  return {
    version: '1.1.23',
    tmux: true,
    direct_capable: false,
    inventory: {},
    endpoints: [],
  };
}

/** 只实现池子用到的公开面，用来验证候选切换时的构造与拆装。 */
class FakePooledClient implements PooledUplink {
  readonly identity = { nodeId: 'ab'.repeat(16), edSecretKey: new Uint8Array(32) };
  readonly userId = 'user-1';
  readonly lastKeyLogHead = null;
  state: UplinkState = 'offline';
  link: LinkSession | null = null;
  lastConnectError: { reason: string; at: number } | null = null;
  stopped = 0;
  relayStreams: LinkStream[] = [];

  private readonly listeners: Array<(state: UplinkState) => void> = [];
  private closeWaiters: Array<() => void> = [];

  constructor(readonly uplinkUrl: string) {}

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
  setOnRelayStream(): void {}
  async attemptConnect(): Promise<void> {
    this.link = {} as LinkSession;
    this.setState('online');
  }
  async connectWithLink(): Promise<void> {
    this.link = {} as LinkSession;
    this.setState('online');
  }
  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    if (this.state === 'offline') return Promise.resolve();
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  async stop(): Promise<void> {
    this.stopped += 1;
    this.link = null;
    this.setState('offline');
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const waiter of waiters) waiter();
  }
  sendCtl(): void {}
  sendStatus(): void {}
  sendStatusIfChanged(): boolean {
    return false;
  }
  openRelay(): Promise<LinkStream> {
    const stream = this.relayStreams.shift();
    return stream ? Promise.resolve(stream) : Promise.reject(new Error('not supported'));
  }
  async queryKeyLogHead(): Promise<null> {
    return null;
  }
  async queryKeyLogAt(): Promise<null> {
    return null;
  }
  async appendAndAck(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
  requestCatchUpNow(): void {}

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.listeners) cb(state);
  }
}

function controlledRelayStream(): { stream: LinkStream; finish: () => void } {
  let resolveClosed!: (info: StreamCloseInfo) => void;
  const closed = new Promise<StreamCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    stream: {
      id: 1,
      openPayload: new Uint8Array(0),
      readable: new ReadableStream(),
      async write() {},
      async end() {},
      reset(reason) {
        resolveClosed({ reason: 'rst', ...(reason ? { message: reason } : {}) });
      },
      closed,
      onAbort() {},
    },
    finish: () => resolveClosed({ reason: 'end' }),
  };
}

function candidate(publicUrl: string): UplinkCandidate {
  return {
    uplinkNodeId: null,
    publicUrl,
    priority: 0,
  };
}

describe('UplinkPool 上级种类切换', () => {
  test('reconfigure 拆掉现有会话并按新的 candidates/createClient 重建', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seedUser(userStore);
      let kind: 'first' | 'second' = 'first';
      const created: FakePooledClient[] = [];
      const pool = new UplinkPool({
        identity: { nodeId: 'ab'.repeat(16), edSecretKey: new Uint8Array(32) },
        userId: 'user-1',
        keyLogApplier: applier,
        userStore,
        statusProvider: status,
        caPins: new RelayCaPinStore(db),
        enablePeriodicRttProbe: false,
        relayDrainRecheckMs: 5,
        relayDrainTimeoutMs: 50,
        candidates: () =>
          kind === 'second'
            ? [candidate('https://relay.example')]
            : [candidate('https://first.example')],
        createClient: (opts) => {
          const client = new FakePooledClient(opts.uplinkUrl);
          created.push(client);
          return client;
        },
      });
      pool.start();
      await waitUntil(() => pool.attachedUplink() !== null);
      expect(pool.attachedUplink()?.publicUrl).toBe('https://first.example');
      expect(created).toHaveLength(1);

      kind = 'second';
      await reconfigureUplinkPool(pool);
      expect(created[0]?.stopped).toBeGreaterThan(0);
      expect(pool.attachedUplink()).toBeNull();

      await waitUntil(() => pool.attachedUplink()?.publicUrl === 'https://relay.example', 5_000);
      expect(created.at(-1)?.uplinkUrl).toBe('https://relay.example');
      await pool.stop();
    } finally {
      close();
    }
  });

  test('reconfigure waits for current relay streams and then rebuilds the pool', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seedUser(userStore);
      let kind: 'first' | 'relay' = 'first';
      const created: FakePooledClient[] = [];
      const pool = new UplinkPool({
        identity: { nodeId: 'ab'.repeat(16), edSecretKey: new Uint8Array(32) },
        userId: 'user-1',
        keyLogApplier: applier,
        userStore,
        statusProvider: status,
        caPins: new RelayCaPinStore(db),
        enablePeriodicRttProbe: false,
        relayDrainRecheckMs: 5,
        relayDrainTimeoutMs: 100,
        candidates: () => [candidate(`https://${kind}.example`)],
        createClient: (opts) => {
          const client = new FakePooledClient(opts.uplinkUrl);
          created.push(client);
          return client;
        },
      });
      pool.start();
      await waitUntil(() => pool.attachedUplink() !== null);
      const old = created[0];
      const active = controlledRelayStream();
      old?.relayStreams.push(active.stream);
      await pool.openRelay('cd'.repeat(16));
      kind = 'relay';

      let reconfigured = false;
      const pending = reconfigureUplinkPool(pool).then(() => {
        reconfigured = true;
      });
      await Bun.sleep(20);
      expect(reconfigured).toBe(false);
      expect(old?.stopped).toBe(0);

      active.finish();
      await pending;
      expect(old?.stopped).toBeGreaterThan(0);
      await waitUntil(() => pool.attachedUplink()?.publicUrl === 'https://relay.example');
      await pool.stop();
    } finally {
      close();
    }
  });

  test('reconfigure enforces the relay drain hard cap', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seedUser(userStore);
      const created: FakePooledClient[] = [];
      const pool = new UplinkPool({
        identity: { nodeId: 'ab'.repeat(16), edSecretKey: new Uint8Array(32) },
        userId: 'user-1',
        keyLogApplier: applier,
        userStore,
        statusProvider: status,
        caPins: new RelayCaPinStore(db),
        enablePeriodicRttProbe: false,
        relayDrainRecheckMs: 5,
        relayDrainTimeoutMs: 20,
        candidates: () => [candidate('https://relay.example')],
        createClient: (opts) => {
          const client = new FakePooledClient(opts.uplinkUrl);
          created.push(client);
          return client;
        },
      });
      pool.start();
      await waitUntil(() => pool.attachedUplink() !== null);
      const active = controlledRelayStream();
      created[0]?.relayStreams.push(active.stream);
      await pool.openRelay('cd'.repeat(16));

      const startedAt = performance.now();
      await reconfigureUplinkPool(pool);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(15);
      expect(created[0]?.stopped).toBeGreaterThan(0);
      await pool.stop();
    } finally {
      close();
    }
  });
});
