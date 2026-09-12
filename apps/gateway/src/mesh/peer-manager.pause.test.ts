import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { resetNodePauseForTests, setNodePaused } from './node-pause';
import { PeerManager } from './peer-manager';
import { dummyUplink } from './peer-test-fixtures';
import { seedNodeIdentity, seedUser } from './test-support';
import { NodeUnreachableError } from './types';

describe('PeerManager pause gate', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    resetNodePauseForTests();
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  async function pair() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const peer = seedNodeIdentity(store, 'user-1');
    const managerA = new PeerManager({
      identity: self,
      userStore: store,
      uplink: dummyUplink(self, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: true,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => managerA.stop() });
    await managerA.start();
    store.upsertPeer({
      nodeId: self.nodeId,
      name: 'self',
      endpointsJson: JSON.stringify([`ws://127.0.0.1:${managerA.listenPort}/peer`]),
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const managerB = new PeerManager({
      identity: peer,
      userStore: store,
      uplink: dummyUplink(peer, store),
      peerPort: 0,
      hostname: '127.0.0.1',
      startServer: false,
      idleMs: 60_000,
    });
    fixtures.push({ close, stop: () => managerB.stop() });
    return { self, managerB };
  }

  test('user getLink rejects paused even with an inbound live; management returns it', async () => {
    const { self, managerB } = await pair();
    const live = await managerB.getLink(self.nodeId);
    expect(live).toBeTruthy();
    setNodePaused(self.nodeId, true);
    await expect(managerB.getLink(self.nodeId)).rejects.toBeInstanceOf(NodeUnreachableError);
    await expect(managerB.getLink(self.nodeId, { purpose: 'user' })).rejects.toMatchObject({
      code: 'NODE_UNREACHABLE',
    });
    expect(await managerB.getLink(self.nodeId, { purpose: 'management' })).toBe(live);
  });

  test('dropPausedPeer clears live so management must redial', async () => {
    const { self, managerB } = await pair();
    const live = await managerB.getLink(self.nodeId);
    setNodePaused(self.nodeId, true);
    managerB.dropPausedPeer(self.nodeId);
    expect(managerB.getLive(self.nodeId)).toBeNull();
    const again = await managerB.getLink(self.nodeId, { purpose: 'management' });
    expect(again).toBeTruthy();
    expect(again).not.toBe(live);
  });

  test('forceProbe skips paused peers', async () => {
    const { self, managerB } = await pair();
    await managerB.getLink(self.nodeId);
    setNodePaused(self.nodeId, true);
    expect(await managerB.forceProbe(self.nodeId)).toBeNull();
  });
});
