import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { PeerManager } from './peer-manager';
import { dummyUplink } from './peer-test-fixtures';
import { DirectDialLimiter } from './peer-ws-race';
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
