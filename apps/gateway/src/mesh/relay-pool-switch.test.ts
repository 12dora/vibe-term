import { describe, expect, test } from 'bun:test';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import { HubTrustStore } from '../auth/hub-trust-store';
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

/** 只实现池子用到的公开面，用来验证 hub ↔ relay 切换时的构造与拆装。 */
class FakePooledClient implements PooledUplink {
  readonly identity = { nodeId: 'ab'.repeat(16), edSecretKey: new Uint8Array(32) };
  readonly userId = 'user-1';
  readonly lastKeyLogHead = null;
  state: UplinkState = 'offline';
  link: LinkSession | null = null;
  lastConnectError: { reason: string; at: number } | null = null;
  stopped = 0;

  private readonly listeners: Array<(state: UplinkState) => void> = [];
  private closeWaiters: Array<() => void> = [];

  constructor(readonly hubUrl: string) {}

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
  setOnRelayStream(): void {}
  async attemptConnect(): Promise<void> {
    this.setState('online');
  }
  async connectWithLink(): Promise<void> {
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
    return Promise.reject(new Error('not supported'));
  }
  async queryHubHead(): Promise<null> {
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

function candidate(publicUrl: string): UplinkCandidate {
  return {
    hubNodeId: null,
    publicUrl,
    mode: 'active',
    writerEpoch: 0,
    priority: 0,
    caFingerprint: null,
  };
}

describe('UplinkPool 上级种类切换', () => {
  test('reconfigure 拆掉现有会话并按新的 candidates/createClient 重建', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seedUser(userStore);
      let kind: 'hub' | 'relay' = 'hub';
      const created: FakePooledClient[] = [];
      const pool = new UplinkPool({
        identity: { nodeId: 'ab'.repeat(16), edSecretKey: new Uint8Array(32) },
        userId: 'user-1',
        keyLogApplier: applier,
        userStore,
        statusProvider: status,
        hubTrust: new HubTrustStore(db),
        enablePeriodicRttProbe: false,
        candidates: () =>
          kind === 'relay'
            ? [candidate('https://relay.example')]
            : [candidate('https://hub.example')],
        createClient: (opts) => {
          const client = new FakePooledClient(opts.hubUrl);
          created.push(client);
          return client;
        },
      });
      pool.start();
      await waitUntil(() => pool.attachedHub() !== null);
      expect(pool.attachedHub()?.publicUrl).toBe('https://hub.example');
      expect(created).toHaveLength(1);

      kind = 'relay';
      await reconfigureUplinkPool(pool);
      expect(created[0]?.stopped).toBeGreaterThan(0);
      expect(pool.attachedHub()).toBeNull();

      await waitUntil(() => pool.attachedHub()?.publicUrl === 'https://relay.example', 5_000);
      expect(created.at(-1)?.hubUrl).toBe('https://relay.example');
      await pool.stop();
    } finally {
      close();
    }
  });
});
