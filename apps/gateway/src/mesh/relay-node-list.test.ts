import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { relayListToNodeList } from './relay-node-list';
import type { RelaySecrets } from './relay-secrets';

describe('relayListToNodeList', () => {
  test('解不开状态块时回落 peer_cache.version', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
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
      const nodeId = 'ab'.repeat(16);
      userStore.upsertCert({
        nodeId,
        userId: 'user-1',
        admitRecordSeq: 1,
        certificateBytes: new Uint8Array(8),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      userStore.upsertPeer({
        nodeId,
        name: 'cached',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
        version: '1.1.22',
      });
      const listed = await relayListToNodeList(
        {
          t: 'relay.list',
          version: 2,
          nodes: [{ id: nodeId, online: true, status: 'admitted' }],
          rtc: { stun: [], turn: null },
          key_log_head_seq: 0,
        },
        {
          selfNodeId: 'cd'.repeat(16),
          userId: 'user-1',
          userStore,
          secrets: { metaKey: async () => null } as unknown as RelaySecrets,
          now: 2,
        }
      );
      expect(listed.nodes).toEqual([
        {
          id: nodeId,
          name: 'cached',
          online: true,
          endpoints: [],
          inventory: {},
          direct_capable: false,
          version: '1.1.22',
        },
      ]);
    } finally {
      close();
    }
  });
});
