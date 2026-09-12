import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { persistUplinkPeerCache } from './uplink-peer-persist';
import type { UplinkNodeList } from './uplink-protocol';

const SELF = 'cd'.repeat(16);
const PEER = 'ab'.repeat(16);

function seedUser(userStore: UserStore): void {
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
}

function listWith(nodes: UplinkNodeList['nodes']): UplinkNodeList {
  return {
    t: 'node.list',
    version: 1,
    key_log_head: { seq: 0n, hash: new Uint8Array(32) },
    rtc: { stun: [], turn: null },
    nodes,
  };
}

describe('persistUplinkPeerCache', () => {
  test('可解密 blob 无 version 时仍建 peer_cache 行', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seedUser(userStore);
      persistUplinkPeerCache({
        userStore,
        userId: 'user-1',
        selfNodeId: SELF,
        now: 2,
        list: listWith([
          {
            id: PEER,
            name: PEER,
            online: true,
            endpoints: ['ws://10.0.0.2:39001/peer'],
            inventory: { tmux: true },
            direct_capable: false,
            version: null,
          },
        ]),
      });
      const row = userStore.getPeer(PEER);
      expect(row).not.toBeNull();
      expect(row?.version).toBeNull();
      expect(row?.endpointsJson).toBe(JSON.stringify(['ws://10.0.0.2:39001/peer']));
    } finally {
      close();
    }
  });

  test('只有 online、没有 blob 时不建空行', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      seedUser(userStore);
      persistUplinkPeerCache({
        userStore,
        userId: 'user-1',
        selfNodeId: SELF,
        now: 2,
        list: listWith([
          {
            id: PEER,
            name: PEER,
            online: true,
            endpoints: [],
            inventory: null,
            direct_capable: false,
            version: null,
          },
        ]),
      });
      expect(userStore.getPeer(PEER)).toBeNull();
    } finally {
      close();
    }
  });
});
