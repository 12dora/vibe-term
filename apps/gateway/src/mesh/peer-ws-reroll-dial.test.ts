import { afterEach, describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerDialer } from './peer-dialer';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { createPeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { dummyUplink } from './peer-test-fixtures';
import { DirectDialLimiter } from './peer-ws-race';
import { dropStaleWsReroll, sharePeerDialInflight } from './peer-ws-reroll-dial';
import type { RtcDialBreaker } from './rtc/rtc-dial-breaker';
import { ImmediateScheduler, seedNodeIdentity, seedUser } from './test-support';

const PEER = 'ff'.repeat(16);

describe('sharePeerDialInflight', () => {
  test('前台复用在途 Promise，后台遇到在途则放弃', async () => {
    const map = new Map<string, Promise<string | null>>();
    let resolveFirst!: (value: string | null) => void;
    const first = sharePeerDialInflight(map, PEER, 'background', () => {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });
    expect(map.has(PEER)).toBe(true);
    const background = await sharePeerDialInflight(map, PEER, 'background', async () => 'second');
    expect(background).toBeNull();
    const foreground = sharePeerDialInflight(map, PEER, 'foreground', async () => 'second');
    resolveFirst('first');
    expect(await first).toBe('first');
    expect(await foreground).toBe('first');
    expect(map.has(PEER)).toBe(false);
  });

  test('首个与复用方拿到同一个 Promise，失败照样 reject 给双方，槽位随后释放', async () => {
    const map = new Map<string, Promise<string | null>>();
    const first = sharePeerDialInflight(map, PEER, 'background', () =>
      Promise.reject(new Error('dial failed'))
    );
    const foreground = sharePeerDialInflight(map, PEER, 'foreground', async () => 'second');
    expect(foreground).toBe(first);
    await expect(first).rejects.toThrow('dial failed');
    await expect(foreground).rejects.toThrow('dial failed');
    expect(map.has(PEER)).toBe(false);
  });
});

describe('dropStaleWsReroll', () => {
  test('live 仍是预期 session 时放行；否则以 reroll-stale 关掉', async () => {
    const expected = createInMemoryLinkPair()[0];
    const stale = createInMemoryLinkPair()[0];
    const other = createInMemoryLinkPair()[0];
    const state = { live: new Map([[PEER, { session: expected }]]) } as never;
    expect(dropStaleWsReroll(state, PEER, stale, expected)).toBe(false);
    expect(dropStaleWsReroll(state, PEER, stale, other)).toBe(true);
    expect((await stale.closed).reason).toBe('reroll-stale');
  });
});

describe('PeerDialer ws re-roll inflight / stale', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup(linkFactory: (nodeId: string, signal: AbortSignal) => Promise<LinkSession>) {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0x11) });
    const peer = seedNodeIdentity(store, 'user-1', { nodeId: new Uint8Array(16).fill(0xff) });
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const scheduler = new ImmediateScheduler();
    const state = createPeerManagerState({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      scheduler,
      endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
    });
    const tracked: LinkSession[] = [];
    const breaker = {
      shouldTry: () => ({
        allow: false,
        cooling: false,
        until: null,
        failures: 0,
        level: 0,
        disabled: false,
      }),
      snapshot: () => ({
        cooling: false,
        until: null,
        failures: 0,
        level: 0,
        lastFailureKind: null,
        disabled: false,
      }),
    } as unknown as RtcDialBreaker;
    const dialer = new PeerDialer(state, {
      rtc: null,
      linkFactory,
      wsFactory: () => {
        throw new Error('no-ws');
      },
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      interfacesFn: () => ({}),
      refreshLocalInterfaces: null,
      deps: {
        dcBreaker: breaker,
        track: (session) => {
          tracked.push(session);
          return session;
        },
        requireTrusted: () => undefined,
        getLink: async () => {
          throw new Error('unused');
        },
        maybeUpgrade: () => undefined,
        nextDcAttemptId: () => 'dc:1',
        signalingFor: () => ({ send: () => undefined, onMessage: () => () => undefined }),
        dispatchRtcWake: () => undefined,
        releaseRtcWakeAttempt: () => undefined,
        onLocalFingerprintChanged: () => undefined,
        onPeerEndpointChanged: () => undefined,
        listenPort: () => undefined,
      },
    });
    const [old] = createInMemoryLinkPair();
    state.live.set(peer.nodeId, {
      session: old,
      transport: 'ws-secure',
      peerNodeId: peer.nodeId,
      quiesceCapable: true,
    } as unknown as LivePeer);
    return { dialer, state, peer, tracked, old };
  }

  test('foreground forceProbe 与 reroll 共享 inflight，只 track 一次', async () => {
    let release!: (session: LinkSession) => void;
    const { dialer, peer, tracked } = setup(
      () =>
        new Promise<LinkSession>((resolve) => {
          release = resolve;
        })
    );
    const rerollP = dialer.dialWsReroll(peer.nodeId);
    await Promise.resolve();
    expect(dialer.hasWsRerollInflight(peer.nodeId)).toBe(true);
    const probeP = dialer.forceProbe(peer.nodeId);
    const [next] = createInMemoryLinkPair();
    release(next);
    expect(await rerollP).toBe(next);
    expect(await probeP).toBe(next);
    expect(tracked).toEqual([next]);
  });

  test('已有 foreground ws 在途时 reroll 放弃', async () => {
    let release!: (session: LinkSession) => void;
    const { dialer, peer, tracked } = setup(
      () =>
        new Promise<LinkSession>((resolve) => {
          release = resolve;
        })
    );
    const probeP = dialer.forceProbe(peer.nodeId);
    await Promise.resolve();
    expect(dialer.hasWsRerollInflight(peer.nodeId)).toBe(true);
    expect(await dialer.dialWsReroll(peer.nodeId)).toBeNull();
    const [next] = createInMemoryLinkPair();
    release(next);
    expect(await probeP).toBe(next);
    expect(tracked).toEqual([next]);
  });

  test('live 已换人时 reroll 以 reroll-stale 关掉且不 track', async () => {
    const [next] = createInMemoryLinkPair();
    const [intruder] = createInMemoryLinkPair();
    const { dialer, state, peer, tracked, old } = setup(async () => {
      state.live.set(peer.nodeId, {
        session: intruder,
        transport: 'ws-secure',
        peerNodeId: peer.nodeId,
        quiesceCapable: false,
      } as unknown as LivePeer);
      return next;
    });
    expect(await dialer.dialWsReroll(peer.nodeId)).toBeNull();
    expect(tracked).toEqual([]);
    expect((await next.closed).reason).toBe('reroll-stale');
    expect(state.live.get(peer.nodeId)?.session).toBe(intruder);
    expect(old).toBeTruthy();
  });
});
