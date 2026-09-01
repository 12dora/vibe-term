import { describe, expect, spyOn, test } from 'bun:test';
import { decodeBase64url } from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import {
  HUB_PEER_POLL_INTERVAL_MS,
  HUB_PEER_POLL_JITTER,
  HubPeerPoller,
  peerPollDelayMs,
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
      await new Promise((r) => setTimeout(r, 20));
      expect(fetches).toBeGreaterThanOrEqual(1);
      await hub.stop();
    } finally {
      close();
    }
  });
});
