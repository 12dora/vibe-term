import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import type { PeerManagerState } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { PeerStatusSync } from './peer-status-sync';

const PEER = 'ab'.repeat(16);

function seed(userStore: UserStore): void {
  userStore.create({
    id: 'user-1',
    username: 'alice',
    rootPublicKey: new Uint8Array(32),
    rootEpoch: 0,
    kdfParamsJson: '{}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now: 1,
  });
  userStore.upsertCert({
    nodeId: PEER,
    userId: 'user-1',
    admitRecordSeq: 1,
    certificateBytes: new Uint8Array(8),
    certSig: new Uint8Array(64),
    authorizationBytes: new Uint8Array(8),
    authorizationSig: new Uint8Array(64),
  });
  userStore.upsertPeer({
    nodeId: PEER,
    name: 'studio',
    endpointsJson: '[]',
    inventoryJson: '{}',
    directCapable: false,
    lastSeenAt: 1,
    listVersion: 1,
    version: '2.8.0',
  });
}

describe('PeerStatusSync capabilities', () => {
  test('version, inventory, or directCapable resets once; endpoints and repeats do not', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seed(userStore);
      let now = 10;
      const caps: string[] = [];
      const endpoints: string[] = [];
      const sync = new PeerStatusSync(
        {
          identity: { nodeId: 'cd'.repeat(16) },
          userStore,
          uplink: { userId: 'user-1' },
          scheduler: { now: () => now },
        } as PeerManagerState,
        {
          deps: {
            sendPeerCtl: () => undefined,
            notifyPeerEndpointsChanged: (nodeId) => {
              if (nodeId) endpoints.push(nodeId);
            },
            onPeerCapabilitiesChanged: (nodeId) => caps.push(nodeId),
            listenPort: () => undefined,
          },
        }
      );
      const live = { peerNodeId: PEER } as LivePeer;
      await sync.applyPeerStatus(live, {
        version: '2.9.0',
        endpoints: [],
        inventory: {},
        direct_capable: false,
      });
      expect(caps).toEqual([PEER]);
      expect(endpoints).toEqual([]);
      expect(userStore.getPeer(PEER)?.version).toBe('2.9.0');
      expect(userStore.getPeer(PEER)?.name).toBe('studio');

      now = 20;
      await sync.applyPeerStatus(live, {
        version: '2.9.0',
        endpoints: [],
        inventory: {},
        direct_capable: false,
      });
      expect(caps).toEqual([PEER]);
      expect(endpoints).toEqual([]);
      expect(userStore.getPeer(PEER)?.lastSeenAt).toBe(20);

      await sync.applyPeerStatus(live, {
        version: '2.9.0',
        endpoints: ['ws://10.0.0.8:39001/peer'],
        inventory: {},
        direct_capable: false,
      });
      expect(caps).toEqual([PEER]);
      expect(endpoints).toEqual([PEER]);

      await sync.applyPeerStatus(live, {
        version: '2.9.0',
        endpoints: ['ws://10.0.0.8:39001/peer'],
        inventory: { tmux: true },
        direct_capable: true,
      });
      expect(caps).toEqual([PEER, PEER]);
      expect(endpoints).toEqual([PEER, PEER]);
    } finally {
      close();
    }
  });
});
