import { describe, expect, spyOn, test } from 'bun:test';
import { decodeBase64url } from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import {
  HUB_PEER_POLL_FAST_INTERVAL_MS,
  HUB_PEER_POLL_FAST_WINDOW_MS,
  HUB_PEER_POLL_INTERVAL_MS,
  HUB_PEER_POLL_JITTER,
  HubPeerPoller,
  peerPollDelayMs,
  shouldAutoPromote,
  shouldFastPeerPoll,
  shouldRequestUplinkProbe,
  stableImmediateJitterMs,
} from './hub-peer-poller';
import { HubRuntime } from './hub-runtime';
import {
  createHubTestStack,
  ctlInbox,
  seedAdmittedNode,
  seedUser,
  sendCtl,
  signAuth,
} from './hub-test-helpers';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const OTHER = 'cc'.repeat(16);
const PEER_URL = 'https://peer.example';

function statusBody(over: Record<string, unknown> = {}) {
  return {
    hubNodeId: PEER,
    publicUrl: PEER_URL,
    mode: 'active',
    priority: 50,
    writerEpoch: 2,
    name: 'peer',
    caFingerprint: null,
    now: 1_000,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function seedPeerRow(
  meshHubs: MeshHubStore,
  over: Partial<{
    hubNodeId: string;
    publicUrl: string;
    mode: 'active' | 'standby';
    writerEpoch: number;
    online: boolean;
  }> = {}
) {
  meshHubs.upsert(
    {
      hubNodeId: over.hubNodeId ?? PEER,
      publicUrl: over.publicUrl ?? PEER_URL,
      name: 'peer',
      mode: over.mode ?? 'standby',
      priority: 200,
      writerEpoch: over.writerEpoch ?? 1,
      caFingerprint: null,
      online: over.online ?? true,
      lastSeenAt: 1,
    },
    1
  );
}

async function authAttached(
  hub: HubRuntime,
  userStore: ReturnType<typeof createHubTestStack>['userStore'],
  userId: string
) {
  const node = seedAdmittedNode(userStore, userId, { name: 'entry' });
  const [nodeLink, hubLink] = createInMemoryLinkPair();
  const inbox = ctlInbox(nodeLink);
  hub.attachLocalNode(hubLink);
  const challenge = await inbox.take();
  if (challenge.t !== 'auth.challenge') throw new Error('expected challenge');
  sendCtl(nodeLink, {
    t: 'auth.response',
    node_id: node.nodeId,
    sig: signAuth(node.ed.secretKey, decodeBase64url(challenge.nonce)),
  });
  expect((await inbox.take()).t).toBe('auth.ok');
  expect((await inbox.take()).t).toBe('node.list');
  return { node, nodeLink, inbox };
}

describe('peerPollDelayMs jitter', () => {
  test('60s ±20% 落在 [48000, 72000]', () => {
    for (let i = 0; i < 200; i++) {
      const ms = peerPollDelayMs(HUB_PEER_POLL_INTERVAL_MS, HUB_PEER_POLL_JITTER);
      expect(ms).toBeGreaterThanOrEqual(48_000);
      expect(ms).toBeLessThanOrEqual(72_000);
    }
  });

  test('fast 3s ±20% 落在 [2400, 3600]', () => {
    for (let i = 0; i < 200; i++) {
      const ms = peerPollDelayMs(HUB_PEER_POLL_FAST_INTERVAL_MS, HUB_PEER_POLL_JITTER);
      expect(ms).toBeGreaterThanOrEqual(2_400);
      expect(ms).toBeLessThanOrEqual(3_600);
    }
  });

  test('immediate poll jitter is stable per seed and in [0, 500]', () => {
    const a = stableImmediateJitterMs(SELF);
    const b = stableImmediateJitterMs(SELF);
    const c = stableImmediateJitterMs(PEER);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(500);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(500);
  });
});

describe('shouldFastPeerPoll', () => {
  const authorized = [
    { hubNodeId: SELF, mode: 'standby' as const, writerEpoch: 2, priority: 200 },
    { hubNodeId: PEER, mode: 'standby' as const, writerEpoch: 1, priority: 100 },
  ];

  test('standby attached to self within the fast window polls fast', () => {
    expect(
      shouldFastPeerPoll({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 2,
        attachedHubId: SELF,
        now: 5_000,
        fastWindowStartedAt: 1_000,
        fastWindowMs: HUB_PEER_POLL_FAST_WINDOW_MS,
        authorized,
      })
    ).toBe(true);
  });

  test('no authorized active with epoch ≥ ours polls fast', () => {
    expect(
      shouldFastPeerPoll({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 2,
        attachedHubId: PEER,
        now: 5_000,
        fastWindowStartedAt: 1_000,
        fastWindowMs: HUB_PEER_POLL_FAST_WINDOW_MS,
        authorized,
      })
    ).toBe(true);
  });

  test('attached hub is not the known writer polls fast', () => {
    expect(
      shouldFastPeerPoll({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 1,
        attachedHubId: OTHER,
        now: 5_000,
        fastWindowStartedAt: 1_000,
        fastWindowMs: HUB_PEER_POLL_FAST_WINDOW_MS,
        authorized: [
          { hubNodeId: SELF, mode: 'standby', writerEpoch: 1, priority: 200 },
          { hubNodeId: PEER, mode: 'active', writerEpoch: 3, priority: 100 },
        ],
      })
    ).toBe(true);
  });

  test('writer attached and healthy stays on the slow cadence', () => {
    expect(
      shouldFastPeerPoll({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 1,
        attachedHubId: PEER,
        now: 5_000,
        fastWindowStartedAt: 1_000,
        fastWindowMs: HUB_PEER_POLL_FAST_WINDOW_MS,
        authorized: [
          { hubNodeId: SELF, mode: 'standby', writerEpoch: 1, priority: 200 },
          { hubNodeId: PEER, mode: 'active', writerEpoch: 3, priority: 100 },
        ],
      })
    ).toBe(false);
  });

  test('active hub never enters fast poll', () => {
    expect(
      shouldFastPeerPoll({
        selfMode: 'active',
        selfId: SELF,
        selfEpoch: 3,
        attachedHubId: SELF,
        now: 5_000,
        fastWindowStartedAt: 1_000,
        fastWindowMs: HUB_PEER_POLL_FAST_WINDOW_MS,
        authorized: [{ hubNodeId: SELF, mode: 'active', writerEpoch: 3, priority: 100 }],
      })
    ).toBe(false);
  });

  test('fast window expiry falls back to 60s even if still attached to self', () => {
    expect(
      shouldFastPeerPoll({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 2,
        attachedHubId: SELF,
        now: 1_000 + HUB_PEER_POLL_FAST_WINDOW_MS + 1,
        fastWindowStartedAt: 1_000,
        fastWindowMs: HUB_PEER_POLL_FAST_WINDOW_MS,
        authorized,
      })
    ).toBe(false);
  });
});

describe('shouldRequestUplinkProbe', () => {
  test('standby attached to self notifies when a peer is the writer', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 1,
        attachedHubId: SELF,
        attachedEpoch: 1,
        writerId: PEER,
        writerEpoch: 3,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 3 }],
      })
    ).toBe(true);
  });

  test('learned active with epoch ≥ attached epoch notifies', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 1,
        attachedHubId: OTHER,
        attachedEpoch: 2,
        writerId: OTHER,
        writerEpoch: 2,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 2 }],
      })
    ).toBe(true);
  });

  test('healthy writer attachment with only standby peers does not notify', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 1,
        attachedHubId: PEER,
        attachedEpoch: 3,
        writerId: PEER,
        writerEpoch: 3,
        learnedActive: [],
      })
    ).toBe(false);
  });

  test('active hub does not notify', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'active',
        selfId: SELF,
        selfEpoch: 3,
        attachedHubId: SELF,
        attachedEpoch: 3,
        writerId: SELF,
        writerEpoch: 3,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 4 }],
      })
    ).toBe(false);
  });

  test('attached to self does not notify for a lower-epoch active hub', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 10,
        attachedHubId: SELF,
        attachedEpoch: 10,
        writerId: PEER,
        writerEpoch: 8,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 8 }],
      })
    ).toBe(false);
  });

  test('attached to self notifies for an equal-epoch active hub', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 10,
        attachedHubId: SELF,
        attachedEpoch: 10,
        writerId: PEER,
        writerEpoch: 10,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 10 }],
      })
    ).toBe(true);
  });

  test('attached to self notifies for a higher-epoch active hub', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 10,
        attachedHubId: SELF,
        attachedEpoch: 10,
        writerId: PEER,
        writerEpoch: 11,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 11 }],
      })
    ).toBe(true);
  });

  test('learned writer must beat max(selfEpoch, attachedEpoch) from the uplink attachment', () => {
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 10,
        attachedHubId: OTHER,
        attachedEpoch: 8,
        writerId: PEER,
        writerEpoch: 9,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 9 }],
      })
    ).toBe(false);
    expect(
      shouldRequestUplinkProbe({
        selfMode: 'standby',
        selfId: SELF,
        selfEpoch: 8,
        attachedHubId: OTHER,
        attachedEpoch: 10,
        writerId: PEER,
        writerEpoch: 10,
        learnedActive: [{ hubNodeId: PEER, writerEpoch: 10 }],
      })
    ).toBe(true);
  });
});

describe('HubPeerPoller', () => {
  test('授权的更高 epoch active 会 fencing 本机并重播 node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore);
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs);
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          nodeId: SELF,
          hubNodeId: SELF,
          siteName: 'hub-a',
          mode: 'active',
          priority: 100,
          writerEpoch: 1,
          authorizedHubIds: [PEER],
        },
        authenticate: () => null,
        fetchPeerStatus: async () => jsonResponse(statusBody()),
      });
      const { inbox } = await authAttached(hub, userStore, user.id);
      expect(hub.mode()).toBe('active');
      const logged: string[] = [];
      const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]));
      });
      await hub.pollPeersNow();
      expect(hub.mode()).toBe('standby');
      expect(logged.some((line) => line.includes('[hub] fenced by peer status'))).toBe(true);
      expect(meshHubs.get(PEER)?.mode).toBe('active');
      expect(meshHubs.get(PEER)?.writerEpoch).toBe(2);
      expect(meshHubs.get(PEER)?.online).toBe(true);
      const listed = await inbox.take();
      expect(listed.t).toBe('node.list');
      if (listed.t !== 'node.list') throw new Error('expected list');
      expect(listed.writerHubId).toBe(PEER);
      expect(listed.writerEpoch).toBe(2);
      error.mockRestore();
      await hub.stop();
    } finally {
      close();
    }
  });

  test('body 里的 hubNodeId 与行 id 不一致则忽略', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs);
      const warns: string[] = [];
      const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warns.push(String(args[0]));
      });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          hubNodeId: SELF,
          mode: 'active',
          writerEpoch: 1,
          authorizedHubIds: [PEER],
        },
        authenticate: () => null,
        fetchPeerStatus: async () => jsonResponse(statusBody({ hubNodeId: OTHER })),
      });
      await hub.pollPeersNow();
      expect(hub.mode()).toBe('active');
      expect(meshHubs.get(PEER)?.mode).toBe('standby');
      expect(meshHubs.get(PEER)?.writerEpoch).toBe(1);
      expect(meshHubs.get(OTHER)).toBeNull();
      expect(warns.some((line) => line.includes('hubNodeId') && line.includes('mismatch'))).toBe(
        true
      );
      warn.mockRestore();
      await hub.stop();
    } finally {
      close();
    }
  });

  test('同等 epoch 的另一个 active 只警告不降级', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs);
      const warns: string[] = [];
      const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warns.push(String(args[0]));
      });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          hubNodeId: SELF,
          mode: 'active',
          writerEpoch: 2,
          authorizedHubIds: [PEER],
        },
        authenticate: () => null,
        fetchPeerStatus: async () => jsonResponse(statusBody({ writerEpoch: 2 })),
      });
      await hub.pollPeersNow();
      expect(hub.mode()).toBe('active');
      expect(warns.some((line) => line.includes('split-brain'))).toBe(true);
      expect(meshHubs.get(SELF)?.mode).toBe('active');
      warn.mockRestore();
      await hub.stop();
    } finally {
      close();
    }
  });

  test('连续 3 次失败后标 offline，不删行', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { online: true });
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER,
        applyStatus: () => {
          throw new Error('should not apply');
        },
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
        timeoutMs: 50,
      });
      await poller.pollNow();
      expect(meshHubs.get(PEER)?.online).toBe(true);
      await poller.pollNow();
      expect(meshHubs.get(PEER)?.online).toBe(true);
      await poller.pollNow();
      expect(meshHubs.get(PEER)?.online).toBe(false);
      expect(meshHubs.get(PEER)).not.toBeNull();
      expect(meshHubs.list().some((row) => row.hubNodeId === PEER)).toBe(true);
    } finally {
      close();
    }
  });

  test('超时会 abort fetch', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs);
      let aborted = false;
      const started = Date.now();
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER,
        applyStatus: () => {},
        timeoutMs: 40,
        fetch: (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      });
      await poller.pollNow();
      expect(aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      close();
    }
  });

  test('setMode 变化后立刻探测', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs);
      let fetches = 0;
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        meshHubs,
        config: {
          publicUrl: 'https://hub.example',
          stun: [],
          hubNodeId: SELF,
          mode: 'active',
          writerEpoch: 1,
          authorizedHubIds: [PEER],
        },
        authenticate: () => null,
        fetchPeerStatus: async () => {
          fetches += 1;
          return jsonResponse(statusBody({ mode: 'standby', writerEpoch: 1 }));
        },
      });
      expect(fetches).toBe(0);
      hub.setMode('standby');
      await new Promise((r) => setTimeout(r, 600));
      expect(fetches).toBeGreaterThanOrEqual(1);
      await hub.stop();
    } finally {
      close();
    }
  });
});

type FakeTimer = {
  id: number;
  fn: () => void;
  ms: number;
  due: number;
  cleared: boolean;
};

function fakeTimers() {
  const delays: number[] = [];
  const pending: FakeTimer[] = [];
  let nextId = 1;
  let now = 0;
  const fireDue = () => {
    const due = pending.filter((row) => !row.cleared && row.due <= now);
    for (const row of due) {
      row.cleared = true;
      row.fn();
    }
  };
  return {
    delays,
    pending,
    now: () => now,
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = nextId++;
      const delay = ms ?? 0;
      delays.push(delay);
      pending.push({ id, fn, ms: delay, due: now + delay, cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
      const row = pending.find((item) => item.id === (id as unknown as number));
      if (row) row.cleared = true;
    }) as typeof clearTimeout,
    fireAll() {
      const due = pending.filter((row) => !row.cleared);
      for (const row of due) {
        row.cleared = true;
        row.fn();
      }
    },
    async advance(ms: number) {
      now += ms;
      fireDue();
      await Promise.resolve();
    },
  };
}

describe('HubPeerPoller adaptive cadence', () => {
  test('startDelayMs 0 polls immediately and arms a fast interval when attached to self', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'standby', writerEpoch: 1 });
      const timers = fakeTimers();
      let fetches = 0;
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: () => {},
        selfMode: () => 'standby',
        attachedHubId: () => SELF,
        selfWriterEpoch: () => 1,
        startDelayMs: 0,
        immediateJitterMs: 0,
        jitter: 0,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: async () => {
          fetches += 1;
          return jsonResponse(statusBody({ mode: 'standby', writerEpoch: 1 }));
        },
        timeoutMs: 50,
      });
      poller.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);
      expect(poller.inFastPoll()).toBe(true);
      expect(timers.delays.some((ms) => ms === HUB_PEER_POLL_FAST_INTERVAL_MS)).toBe(true);
      expect(timers.delays.every((ms) => ms !== HUB_PEER_POLL_INTERVAL_MS)).toBe(true);
      poller.stop();
    } finally {
      close();
    }
  });

  test('start with a delay does not poll until the timer fires', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs);
      const timers = fakeTimers();
      let fetches = 0;
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER,
        applyStatus: () => {},
        startDelayMs: 2_000,
        immediateJitterMs: 0,
        jitter: 0,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: async () => {
          fetches += 1;
          return jsonResponse(statusBody({ mode: 'standby', writerEpoch: 1 }));
        },
        timeoutMs: 50,
      });
      poller.start();
      await Promise.resolve();
      expect(fetches).toBe(0);
      expect(timers.delays).toEqual([2_000]);
      timers.fireAll();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);
      poller.stop();
    } finally {
      close();
    }
  });

  test('falls back to 60s once a healthy writer is attached', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'active', writerEpoch: 3 });
      const timers = fakeTimers();
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: () => {},
        selfMode: () => 'standby',
        attachedHubId: () => PEER,
        selfWriterEpoch: () => 1,
        startDelayMs: 0,
        immediateJitterMs: 0,
        jitter: 0,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: async () => jsonResponse(statusBody({ mode: 'active', writerEpoch: 3 })),
        timeoutMs: 50,
      });
      poller.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(poller.inFastPoll()).toBe(false);
      expect(timers.delays.filter((ms) => ms === HUB_PEER_POLL_INTERVAL_MS).length).toBeGreaterThan(
        0
      );
      poller.stop();
    } finally {
      close();
    }
  });

  test('noteRoleTransition polls immediately and restarts the fast window', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'standby', writerEpoch: 1 });
      const timers = fakeTimers();
      let now = 1_000;
      let fetches = 0;
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: () => {},
        now: () => now,
        selfMode: () => 'standby',
        attachedHubId: () => SELF,
        selfWriterEpoch: () => 2,
        startDelayMs: 2_000,
        immediateJitterMs: 0,
        jitter: 0,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: async () => {
          fetches += 1;
          return jsonResponse(statusBody({ mode: 'standby', writerEpoch: 1 }));
        },
        timeoutMs: 50,
      });
      poller.start();
      await Promise.resolve();
      expect(fetches).toBe(0);
      now = 1_000 + HUB_PEER_POLL_FAST_WINDOW_MS + 50_000;
      expect(poller.inFastPoll()).toBe(false);
      poller.noteRoleTransition();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);
      expect(poller.inFastPoll()).toBe(true);
      expect(timers.delays.includes(HUB_PEER_POLL_FAST_INTERVAL_MS)).toBe(true);
      poller.stop();
    } finally {
      close();
    }
  });

  test('learning an active peer while attached to self notifies uplink re-eval', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'standby', writerEpoch: 1 });
      const learned: string[] = [];
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: (id, ad) => {
          const existing = meshHubs.get(id);
          if (!existing) return;
          meshHubs.upsert(
            {
              ...existing,
              mode: ad.mode,
              writerEpoch: ad.writerEpoch,
              publicUrl: ad.publicUrl,
              online: true,
            },
            1
          );
        },
        selfMode: () => 'standby',
        attachedHubId: () => SELF,
        selfWriterEpoch: () => 1,
        onWriterLearned: () => {
          learned.push('probe');
        },
        fetch: async () => jsonResponse(statusBody({ mode: 'active', writerEpoch: 3 })),
        timeoutMs: 50,
      });
      await poller.pollNow();
      expect(meshHubs.get(PEER)?.mode).toBe('active');
      expect(learned).toEqual(['probe']);
    } finally {
      close();
    }
  });

  test('lower-epoch active while attached to self does not notify; equal/higher does', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'standby', writerEpoch: 1 });
      meshHubs.upsert(
        {
          hubNodeId: SELF,
          publicUrl: 'https://self.example',
          name: 'self',
          mode: 'standby',
          priority: 200,
          writerEpoch: 10,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      const learned: string[] = [];
      let peerEpoch = 8;
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: (id, ad) => {
          const existing = meshHubs.get(id);
          if (!existing) return;
          meshHubs.upsert(
            {
              ...existing,
              mode: ad.mode,
              writerEpoch: ad.writerEpoch,
              publicUrl: ad.publicUrl,
              online: true,
            },
            1
          );
        },
        selfMode: () => 'standby',
        attachedHubId: () => SELF,
        attachedEpoch: () => 10,
        selfWriterEpoch: () => 10,
        onWriterLearned: () => {
          learned.push(`e${peerEpoch}`);
        },
        fetch: async () => jsonResponse(statusBody({ mode: 'active', writerEpoch: peerEpoch })),
        timeoutMs: 50,
      });
      await poller.pollNow();
      expect(meshHubs.get(PEER)?.writerEpoch).toBe(8);
      expect(learned).toEqual([]);

      peerEpoch = 10;
      await poller.pollNow();
      expect(learned).toEqual(['e10']);

      learned.length = 0;
      peerEpoch = 12;
      await poller.pollNow();
      expect(learned).toEqual(['e12']);
    } finally {
      close();
    }
  });

  test('poll longer than the fast interval arms the next poll after completion', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'standby', writerEpoch: 1 });
      const timers = fakeTimers();
      let fetches = 0;
      let release: () => void = () => {};
      let holdFirst = true;
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: () => {},
        selfMode: () => 'standby',
        attachedHubId: () => SELF,
        selfWriterEpoch: () => 1,
        startDelayMs: 0,
        immediateJitterMs: 0,
        jitter: 0,
        fastIntervalMs: 3_000,
        timeoutMs: 30_000,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: async () => {
          fetches += 1;
          if (holdFirst && fetches === 1) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return jsonResponse(statusBody({ mode: 'standby', writerEpoch: 1 }));
        },
      });
      poller.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);

      await timers.advance(3_000);
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);

      holdFirst = false;
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);

      await timers.advance(2_999);
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(1);

      await timers.advance(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(2);
      poller.stop();
    } finally {
      close();
    }
  });

  test('refreshCadence on slow→fast re-arms within the fast interval', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedPeerRow(meshHubs, { mode: 'active', writerEpoch: 3 });
      const timers = fakeTimers();
      let attached = PEER;
      let fetches = 0;
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: () => {},
        selfMode: () => 'standby',
        attachedHubId: () => attached,
        selfWriterEpoch: () => 1,
        startDelayMs: 0,
        immediateJitterMs: 0,
        jitter: 0,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: async () => {
          fetches += 1;
          return jsonResponse(statusBody({ mode: 'active', writerEpoch: 3 }));
        },
        timeoutMs: 50,
      });
      poller.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(poller.inFastPoll()).toBe(false);
      expect(fetches).toBe(1);
      const slow = timers.pending.filter(
        (row) => !row.cleared && row.ms === HUB_PEER_POLL_INTERVAL_MS
      );
      expect(slow.length).toBeGreaterThan(0);

      attached = SELF;
      expect(poller.inFastPoll()).toBe(true);
      poller.refreshCadence();
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBe(2);
      expect(slow.every((row) => row.cleared)).toBe(true);
      expect(
        timers.pending.some((row) => !row.cleared && row.ms === HUB_PEER_POLL_FAST_INTERVAL_MS)
      ).toBe(true);
      poller.stop();
    } finally {
      close();
    }
  });
});

describe('shouldAutoPromote', () => {
  const writer = PEER;
  const self = SELF;
  const other = OTHER;
  const fourth = 'dd'.repeat(16);

  function hubs(
    rows: Array<{ id: string; mode: 'active' | 'standby'; priority: number }>
  ): Array<{ hubNodeId: string; mode: 'active' | 'standby'; priority: number }> {
    return rows.map((row) => ({ hubNodeId: row.id, mode: row.mode, priority: row.priority }));
  }

  test('quorum matrix: 3 hubs need the other standby fresh unreachable view', () => {
    const authorized = hubs([
      { id: writer, mode: 'active', priority: 100 },
      { id: self, mode: 'standby', priority: 200 },
      { id: other, mode: 'standby', priority: 200 },
    ]);
    const base = {
      enabled: true,
      selfId: self,
      selfMode: 'standby' as const,
      writerId: writer,
      writerEpoch: 1,
      writerUnreachableSince: 0,
      now: 600_000,
      timeoutMs: 600_000,
      authorized,
      pollIntervalMs: 60_000,
    };
    expect(
      shouldAutoPromote({
        ...base,
        peerWriterViews: new Map([
          [
            other,
            {
              hubNodeId: writer,
              writerEpoch: 1,
              reachable: false,
              observedAt: 1,
              receivedAt: 600_000,
            },
          ],
        ]),
      })
    ).toBe(true);
    expect(shouldAutoPromote({ ...base, peerWriterViews: new Map() })).toBe(false);
    expect(
      shouldAutoPromote({
        ...base,
        peerWriterViews: new Map([
          [
            other,
            {
              hubNodeId: writer,
              writerEpoch: 1,
              reachable: true,
              observedAt: 1,
              receivedAt: 600_000,
            },
          ],
        ]),
      })
    ).toBe(false);
  });

  test('4 hubs need a strict majority of the other standbys', () => {
    const authorized = hubs([
      { id: writer, mode: 'active', priority: 100 },
      { id: self, mode: 'standby', priority: 150 },
      { id: other, mode: 'standby', priority: 200 },
      { id: fourth, mode: 'standby', priority: 210 },
    ]);
    const base = {
      enabled: true,
      selfId: self,
      selfMode: 'standby' as const,
      writerId: writer,
      writerEpoch: 1,
      writerUnreachableSince: 0,
      now: 600_000,
      timeoutMs: 600_000,
      authorized,
      pollIntervalMs: 60_000,
    };
    const unreachable = {
      hubNodeId: writer,
      writerEpoch: 1,
      reachable: false,
      observedAt: 1,
      receivedAt: 600_000,
    };
    expect(
      shouldAutoPromote({
        ...base,
        peerWriterViews: new Map([[other, unreachable]]),
      })
    ).toBe(false);
    expect(
      shouldAutoPromote({
        ...base,
        peerWriterViews: new Map([
          [other, unreachable],
          [fourth, unreachable],
        ]),
      })
    ).toBe(true);
  });

  test('2-hub waiver skips quorum', () => {
    expect(
      shouldAutoPromote({
        enabled: true,
        selfId: self,
        selfMode: 'standby',
        writerId: writer,
        writerEpoch: 1,
        writerUnreachableSince: 0,
        now: 600_000,
        timeoutMs: 600_000,
        authorized: hubs([
          { id: writer, mode: 'active', priority: 100 },
          { id: self, mode: 'standby', priority: 200 },
        ]),
        peerWriterViews: new Map(),
        pollIntervalMs: 60_000,
      })
    ).toBe(true);
  });

  test('not-lowest-priority standby does nothing', () => {
    expect(
      shouldAutoPromote({
        enabled: true,
        selfId: self,
        selfMode: 'standby',
        writerId: writer,
        writerEpoch: 1,
        writerUnreachableSince: 0,
        now: 600_000,
        timeoutMs: 600_000,
        authorized: hubs([
          { id: writer, mode: 'active', priority: 100 },
          { id: other, mode: 'standby', priority: 50 },
          { id: self, mode: 'standby', priority: 200 },
        ]),
        peerWriterViews: new Map([
          [
            other,
            {
              hubNodeId: writer,
              writerEpoch: 1,
              reachable: false,
              observedAt: 1,
              receivedAt: 600_000,
            },
          ],
        ]),
        pollIntervalMs: 60_000,
      })
    ).toBe(false);
  });

  test('stale writerView does not count toward quorum', () => {
    expect(
      shouldAutoPromote({
        enabled: true,
        selfId: self,
        selfMode: 'standby',
        writerId: writer,
        writerEpoch: 1,
        writerUnreachableSince: 0,
        now: 600_000,
        timeoutMs: 600_000,
        authorized: hubs([
          { id: writer, mode: 'active', priority: 100 },
          { id: self, mode: 'standby', priority: 200 },
          { id: other, mode: 'standby', priority: 200 },
        ]),
        peerWriterViews: new Map([
          [
            other,
            {
              hubNodeId: writer,
              writerEpoch: 1,
              reachable: false,
              observedAt: 600_000,
              receivedAt: 1,
            },
          ],
        ]),
        pollIntervalMs: 60_000,
      })
    ).toBe(false);
  });

  test('mismatched writerEpoch votes do not count; peer clock observedAt is ignored', () => {
    const authorized = hubs([
      { id: writer, mode: 'active', priority: 100 },
      { id: self, mode: 'standby', priority: 200 },
      { id: other, mode: 'standby', priority: 200 },
    ]);
    const base = {
      enabled: true,
      selfId: self,
      selfMode: 'standby' as const,
      writerId: writer,
      writerEpoch: 4,
      writerUnreachableSince: 0,
      now: 600_000,
      timeoutMs: 600_000,
      authorized,
      pollIntervalMs: 60_000,
    };
    expect(
      shouldAutoPromote({
        ...base,
        peerWriterViews: new Map([
          [
            other,
            {
              hubNodeId: writer,
              writerEpoch: 3,
              reachable: false,
              observedAt: 600_000,
              receivedAt: 600_000,
            },
          ],
        ]),
      })
    ).toBe(false);
    expect(
      shouldAutoPromote({
        ...base,
        peerWriterViews: new Map([
          [
            other,
            {
              hubNodeId: writer,
              writerEpoch: 4,
              reachable: false,
              observedAt: 1,
              receivedAt: 600_000,
            },
          ],
        ]),
      })
    ).toBe(true);
  });

  test('timeout not elapsed or a success reset blocks promote', () => {
    const authorized = hubs([
      { id: writer, mode: 'active', priority: 100 },
      { id: self, mode: 'standby', priority: 200 },
    ]);
    expect(
      shouldAutoPromote({
        enabled: true,
        selfId: self,
        selfMode: 'standby',
        writerId: writer,
        writerEpoch: 1,
        writerUnreachableSince: 500_000,
        now: 600_000,
        timeoutMs: 600_000,
        authorized,
        peerWriterViews: new Map(),
        pollIntervalMs: 60_000,
      })
    ).toBe(false);
    expect(
      shouldAutoPromote({
        enabled: true,
        selfId: self,
        selfMode: 'standby',
        writerId: writer,
        writerEpoch: 1,
        writerUnreachableSince: null,
        now: 600_000,
        timeoutMs: 600_000,
        authorized,
        peerWriterViews: new Map(),
        pollIntervalMs: 60_000,
      })
    ).toBe(false);
  });
});

describe('HubPeerPoller auto-promote', () => {
  const OTHER_URL = 'https://other.example';

  function seedSelf(meshHubs: MeshHubStore, mode: 'active' | 'standby' = 'standby') {
    meshHubs.upsert(
      {
        hubNodeId: SELF,
        publicUrl: 'https://self.example',
        name: 'self',
        mode,
        priority: 200,
        writerEpoch: 1,
        caFingerprint: null,
        online: true,
        lastSeenAt: 1,
      },
      1
    );
  }

  test('timeout resets on a single successful writer probe', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedSelf(meshHubs);
      seedPeerRow(meshHubs, { mode: 'active', writerEpoch: 1 });
      let now = 1_000;
      let writerOk = false;
      const promoted: string[] = [];
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === SELF,
        applyStatus: (id, ad) => {
          const existing = meshHubs.get(id);
          if (!existing) return;
          meshHubs.upsert(
            {
              ...existing,
              mode: ad.mode,
              writerEpoch: ad.writerEpoch,
              publicUrl: ad.publicUrl,
              online: true,
            },
            now
          );
        },
        now: () => now,
        autoPromote: true,
        autoPromoteTimeoutMs: 100,
        intervalMs: 10,
        selfMode: () => 'standby',
        selfPriority: () => 200,
        onAutoPromote: (id) => {
          promoted.push(id);
        },
        fetch: async (url) => {
          if (url.includes('peer.example')) {
            if (!writerOk) throw new Error('down');
            return jsonResponse(statusBody({ mode: 'active', writerEpoch: 1 }));
          }
          throw new Error('unexpected');
        },
        timeoutMs: 50,
      });
      await poller.pollNow();
      now = 1_050;
      writerOk = true;
      await poller.pollNow();
      now = 1_200;
      writerOk = false;
      await poller.pollNow();
      expect(promoted).toEqual([]);
      now = 1_300;
      await poller.pollNow();
      expect(promoted).toHaveLength(1);
      expect(promoted[0]?.startsWith('auto-')).toBe(true);
    } finally {
      close();
    }
  });

  test('GET-equivalent writerView is recorded from peer status', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const meshHubs = new MeshHubStore(db);
      seedSelf(meshHubs);
      seedPeerRow(meshHubs, { mode: 'active', writerEpoch: 1 });
      meshHubs.upsert(
        {
          hubNodeId: OTHER,
          publicUrl: OTHER_URL,
          name: 'other',
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          caFingerprint: null,
          online: true,
          lastSeenAt: 1,
        },
        1
      );
      const poller = new HubPeerPoller({
        meshHubs,
        selfHubId: () => SELF,
        isAuthorized: (id) => id === PEER || id === OTHER || id === SELF,
        applyStatus: () => {},
        now: () => 5_000,
        fetch: async (url) => {
          if (url.includes('peer.example')) throw new Error('down');
          return jsonResponse({
            hubNodeId: OTHER,
            publicUrl: OTHER_URL,
            mode: 'standby',
            priority: 200,
            writerEpoch: 1,
            writerView: {
              hubNodeId: PEER,
              writerEpoch: 1,
              reachable: false,
              observedAt: 4_900,
            },
          });
        },
        timeoutMs: 50,
      });
      await poller.pollNow();
      expect(poller.localWriterView()).toMatchObject({
        hubNodeId: PEER,
        reachable: false,
        observedAt: 5_000,
      });
    } finally {
      close();
    }
  });
});
