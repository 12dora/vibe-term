import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerDialer } from './peer-dialer';
import { gateDcDial } from './peer-dialer-dc-gate';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { PeerManager } from './peer-manager';
import { createPeerManagerState } from './peer-manager-state';
import { dummyUplink } from './peer-test-fixtures';
import { DirectDialLimiter } from './peer-ws-race';
import type { RtcPeerManager } from './rtc';
import type { RtcDialBreaker } from './rtc/rtc-dial-breaker';
import { ImmediateScheduler, seedNodeIdentity, seedUser } from './test-support';

describe('PeerDialer skips fake-IP endpoints', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  function setup(endpointsJson: string) {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson,
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const dialed: string[] = [];
    const backoff = new PeerEndpointBackoff({ now: () => 1_000 });
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store, async () => {
        throw new Error('no-relay');
      }),
      peerPort: 0,
      startServer: false,
      scheduler: new ImmediateScheduler(),
      connectTimeoutMs: 20,
      dialLimiter: new DirectDialLimiter(4),
      endpointBackoff: backoff,
      wsFactory: (url) => {
        dialed.push(url);
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });
    fixtures.push({ close, stop: () => manager.stop() });
    return { manager, peer, dialed, backoff };
  }

  test('does not dial advertised fake-IP and does not back it off', async () => {
    const { manager, peer, dialed, backoff } = setup(
      JSON.stringify(['ws://198.18.0.1:39001/peer', 'ws://[::ffff:198.19.0.2]:39001/peer'])
    );
    const session = await manager.forceProbe(peer.nodeId);
    expect(session).toBeNull();
    expect(dialed).toEqual([]);
    expect(backoff.nextEligibleAt(peer.nodeId, 'ws://198.18.0.1:39001/peer')).toBeNull();
  });

  test('dials remaining real endpoints and skips mapped fake-IP', async () => {
    const real = 'ws://10.0.0.9:39001/peer';
    const { manager, peer, dialed } = setup(
      JSON.stringify(['ws://198.18.0.1:39001/peer', real, 'ws://[::ffff:198.18.0.1]:39001/peer'])
    );
    await manager.forceProbe(peer.nodeId);
    expect(dialed).toEqual([real]);
  });

  test('forceProbe explicit fake-IP list is also skipped', async () => {
    const { manager, peer, dialed } = setup(JSON.stringify(['ws://10.0.0.9:39001/peer']));
    const session = await manager.forceProbe(peer.nodeId, [
      'ws://198.18.0.1:39001/peer',
      'ws://[::ffff:c612:1]:39001/peer',
    ]);
    expect(session).toBeNull();
    expect(dialed).toEqual([]);
  });
});

describe('PeerDialer peer-initiated DC while breaker cooling', () => {
  const cooling = {
    allow: false,
    cooling: true,
    until: 99_000,
    failures: 3,
    level: 4,
    disabled: false,
  };
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  test('gateDcDial skips the breaker only when peerInitiated', () => {
    const blocked = gateDcDial({
      peer: 'aa',
      capable: true,
      aboveDc: true,
      peerInitiated: false,
      decision: cooling,
    });
    expect(blocked).toEqual({ allow: false, coolingUntil: 99_000 });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const allowed = gateDcDial({
        peer: 'aa',
        capable: true,
        aboveDc: true,
        peerInitiated: true,
        decision: cooling,
      });
      expect(allowed).toEqual({ allow: true });
    } finally {
      console.log = orig;
    }
    expect(
      lines.some((line) => line.includes('[mesh][rtc] answer while cooling peer=aa level=4'))
    ).toBe(true);
  });

  test('dial attempts DC while cooling only if peerInitiated', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    store.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: true,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    let dcCalls = 0;
    const rtc = {
      available: true,
      ready: async () => true,
      currentIceConfig: () => ({ stun: [] as string[], turn: null }),
      connectToPeer: async () => {
        dcCalls += 1;
        throw new Error('dc-fail');
      },
    } as unknown as RtcPeerManager;
    const breaker = {
      shouldTry: () => cooling,
      snapshot: () => ({
        cooling: true,
        until: cooling.until,
        failures: cooling.failures,
        level: cooling.level,
        lastFailureKind: 'timeout',
        disabled: false,
      }),
      beginAttempt: () => undefined,
      noteFailure: () => ({ counted: false, opened: false, open: true }),
    } as unknown as RtcDialBreaker;
    const scheduler = new ImmediateScheduler();
    const dialer = new PeerDialer(
      createPeerManagerState({
        identity: self,
        userStore: store,
        uplink: dummyUplink(self, store, async () => {
          throw new Error('no-relay');
        }),
        scheduler,
        endpointBackoff: new PeerEndpointBackoff({ now: () => scheduler.now() }),
      }),
      {
        rtc,
        linkFactory: null,
        wsFactory: () => {
          throw new Error('no-ws');
        },
        connectTimeoutMs: 20,
        dialLimiter: new DirectDialLimiter(4),
        interfacesFn: () => ({}),
        refreshLocalInterfaces: null,
        deps: {
          dcBreaker: breaker,
          track: (session) => session,
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
      }
    );

    await expect(dialer.dial(peer.nodeId)).rejects.toBeTruthy();
    expect(dcCalls).toBe(0);
    await expect(dialer.dial(peer.nodeId, { peerInitiated: true })).rejects.toBeTruthy();
    expect(dcCalls).toBe(1);
  });
});
