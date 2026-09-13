import { afterEach, describe, expect, test } from 'bun:test';
import { encodeRelayStatusBlob, generateTenantKey, sealEnvelope } from '@vibeterm/shared/relay';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { applyUplinkNodeList } from './node-list-apply';
import { membersProbeSnapshot, resetPortReachForTest } from './port-reach';
import { relayListToNodeList } from './relay-node-list';
import type { RelaySecrets } from './relay-secrets';

describe('relayListToNodeList', () => {
  afterEach(() => {
    resetPortReachForTest();
  });

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

  test('pending / revoked 成员不进入可达节点列表', async () => {
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
      const admitted = 'ab'.repeat(16);
      const pending = 'cd'.repeat(16);
      const revoked = 'ef'.repeat(16);
      for (const nodeId of [admitted, pending, revoked]) {
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
          name: nodeId,
          endpointsJson: '[]',
          inventoryJson: '{}',
          directCapable: false,
          lastSeenAt: 1,
          listVersion: 1,
          version: '1.1.22',
        });
      }
      const listed = await relayListToNodeList(
        {
          t: 'relay.list',
          version: 3,
          nodes: [
            { id: admitted, online: true, status: 'admitted' },
            { id: pending, online: true, status: 'pending' },
            { id: revoked, online: false, status: 'revoked' },
          ],
          rtc: { stun: [], turn: null },
          key_log_head_seq: 0,
        },
        {
          selfNodeId: '11'.repeat(16),
          userId: 'user-1',
          userStore,
          secrets: { metaKey: async () => null } as unknown as RelaySecrets,
          now: 2,
        }
      );
      expect(listed.nodes.map((n) => n.id)).toEqual([admitted]);
    } finally {
      close();
    }
  });

  test('可解密状态块在单中继模式下写入 peer_cache.version', async () => {
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
      const metaKey = generateTenantKey();
      const sealed = await sealEnvelope(
        metaKey,
        'status',
        encodeRelayStatusBlob({
          name: 'peer-b',
          version: '2.2.4',
          tmux: true,
          direct_capable: true,
          inventory: { version: '2.2.4' },
          endpoints: [],
        }),
        1
      );
      const listed = await relayListToNodeList(
        {
          t: 'relay.list',
          version: 4,
          nodes: [
            {
              id: nodeId,
              online: true,
              status: 'admitted',
              epoch: 1,
              blob: sealed,
            },
          ],
          rtc: { stun: [], turn: null },
          key_log_head_seq: 0,
        },
        {
          selfNodeId: 'cd'.repeat(16),
          userId: 'user-1',
          userStore,
          secrets: {
            metaKey: async (epoch: number) => (epoch === 1 ? metaKey : null),
          } as unknown as RelaySecrets,
          now: 2,
        }
      );
      expect(listed.nodes[0]?.version).toBe('2.2.4');
      expect(userStore.getPeer(nodeId)?.version).toBe('2.2.4');

      const hubStore = new MeshHubStore(db);
      const primaryUrl = 'https://relay.example';
      applyUplinkNodeList(
        {
          state: { lastNodeList: null, hubPresenceLive: false, hubGeneration: 0, lastRtc: null },
          rtcSourceUrl: primaryUrl,
          retainPeerIds: () => [nodeId],
          extraListedNodes: () => [],
          identity: { nodeIdHex: 'cd'.repeat(16) },
          hubStore,
          scheduler: { now: () => 3 },
          userIdOf: () => 'user-1',
          userStore,
          peerHolder: { manager: null },
          emitListNodeEvent: () => {},
          opts: {},
        },
        listed,
        () => false
      );
      expect(userStore.getPeer(nodeId)?.version).toBe('2.2.4');
    } finally {
      close();
    }
  });

  test('解不开状态块且 cache 无 version 时不写入空 version 行', async () => {
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
      const listed = await relayListToNodeList(
        {
          t: 'relay.list',
          version: 5,
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
      const hubStore = new MeshHubStore(db);
      applyUplinkNodeList(
        {
          state: { lastNodeList: null, hubPresenceLive: false, hubGeneration: 0, lastRtc: null },
          rtcSourceUrl: 'https://relay.example',
          retainPeerIds: () => [],
          extraListedNodes: () => [],
          identity: { nodeIdHex: 'cd'.repeat(16) },
          hubStore,
          scheduler: { now: () => 3 },
          userIdOf: () => 'user-1',
          userStore,
          peerHolder: { manager: null },
          emitListNodeEvent: () => {},
          opts: {},
        },
        listed,
        () => false
      );
      expect(userStore.getPeer(nodeId)).toBeNull();
    } finally {
      close();
    }
  });

  test('turn_ok 按 relayUrl 分桶，缺席则不摄入', async () => {
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
      const metaKey = generateTenantKey();
      const sealed = await sealEnvelope(
        metaKey,
        'status',
        encodeRelayStatusBlob({
          name: 'peer-b',
          version: '2.3.5',
          tmux: true,
          direct_capable: true,
          inventory: null,
          endpoints: [],
          turn_ok: true,
        }),
        1
      );
      const ctx = {
        selfNodeId: 'cd'.repeat(16),
        userId: 'user-1',
        userStore,
        secrets: {
          metaKey: async (epoch: number) => (epoch === 1 ? metaKey : null),
        } as unknown as RelaySecrets,
        now: 2,
      };
      const msg = {
        t: 'relay.list' as const,
        version: 6,
        nodes: [{ id: nodeId, online: true, status: 'admitted' as const, epoch: 1, blob: sealed }],
        rtc: { stun: [], turn: null },
        key_log_head_seq: 0,
      };
      await relayListToNodeList(msg, ctx);
      expect(membersProbeSnapshot('https://jp.example')).toBeNull();
      await relayListToNodeList(msg, { ...ctx, relayUrl: 'https://jp.example' });
      expect(membersProbeSnapshot('https://jp.example')).toMatchObject({ ok: 1, total: 1 });
      expect(membersProbeSnapshot('https://sh.example')).toBeNull();
    } finally {
      close();
    }
  });
});
