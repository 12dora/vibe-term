import { describe, expect, test } from 'bun:test';
import {
  createNodeCertificate,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nodeIdToHex,
} from '@tmex/shared/auth';
import type { HubEndpointInfo, MeshUplinkNodeList } from '@tmex/shared/uplink';
import { MeshHubStore } from '../auth/mesh-hub-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { HubRuntime } from './hub-runtime';
import { createHubTestStack, seedAdmittedNode, seedUser } from './hub-test-helpers';

const SELF = 'aa'.repeat(16);
const WRITER = 'bb'.repeat(16);
const UNKNOWN = 'cc'.repeat(16);

function listOf(nodes: MeshUplinkNodeList['nodes'], hubs?: HubEndpointInfo[]): MeshUplinkNodeList {
  return {
    t: 'node.list',
    version: 1,
    key_log_head: { seq: 0n, hash: new Uint8Array(32) },
    rtc: { stun: [], turn: null },
    nodes,
    ...(hubs ? { hubs } : {}),
  };
}

function endpoint(nodeId: string, over: Partial<HubEndpointInfo> = {}): HubEndpointInfo {
  return {
    nodeId,
    publicUrl: `https://${nodeId.slice(0, 4)}.example`,
    mode: 'active',
    priority: 100,
    writerEpoch: 2,
    online: true,
    ...over,
  };
}

function makeHub(db: ReturnType<typeof createMigratedAuthDb>['db'], now = 9_000) {
  const { userStore, keyLogSource } = createHubTestStack(db);
  const user = seedUser(userStore, { now });
  const hub = new HubRuntime({
    db,
    userStore,
    keyLogSource,
    config: {
      publicUrl: 'https://standby.example',
      stun: [],
      mode: 'standby',
      priority: 200,
      writerEpoch: 1,
      hubNodeId: SELF,
      nodeId: SELF,
      authorizedHubIds: [WRITER],
    },
    authenticate: () => ({ userId: user.id, entryNodeId: SELF }),
    now: () => now,
  });
  return { hub, userStore, user };
}

describe('HubRuntime.applyReplicatedNodeList', () => {
  test('只 upsert 有未吊销证书的节点，缺席本地节点保持存在且不刷新 last_seen', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { hub, userStore, user } = makeHub(db, 9_000);
      const kept = seedAdmittedNode(userStore, user.id, { name: 'kept', now: 1_000 });
      const absent = seedAdmittedNode(userStore, user.id, { name: 'absent', now: 1_000 });
      const revoked = seedAdmittedNode(userStore, user.id, {
        name: 'revoked',
        now: 1_000,
        revoked: true,
      });
      const enroll = generateEd25519KeyPair();
      const certOnly = createNodeCertificate(enroll.secretKey, {
        uid: user.id,
        edPk: generateEd25519KeyPair().publicKey,
        x25519Pk: generateX25519KeyPair().publicKey,
        enrollPk: enroll.publicKey,
        now: 1_000,
      });
      const certOnlyId = nodeIdToHex(certOnly.nodeId);
      userStore.upsertCert({
        nodeId: certOnlyId,
        userId: user.id,
        admitRecordSeq: 1,
        certificateBytes: certOnly.certificateBytes,
        certSig: certOnly.certSig,
        authorizationBytes: enroll.publicKey,
        authorizationSig: new Uint8Array(64),
        revokedLogSeq: null,
      });
      expect(userStore.getNode(certOnlyId)).toBeNull();

      hub.applyReplicatedNodeList(
        listOf(
          [
            {
              id: kept.nodeId,
              name: 'kept-renamed',
              online: true,
              endpoints: [{ host: '10.0.0.1' }],
              inventory: { panes: 2 },
              direct_capable: true,
              version: '1.1.11',
            },
            {
              id: certOnlyId,
              name: 'new-from-cert',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '1.0.0',
            },
            {
              id: revoked.nodeId,
              name: 'should-not-enroll',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '9.9.9',
            },
            {
              id: UNKNOWN,
              name: 'ghost',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '1.0.0',
            },
          ],
          [endpoint(WRITER, { publicUrl: 'https://writer.example', name: 'writer' })]
        ),
        { hubNodeId: WRITER }
      );

      const keptRow = userStore.getNode(kept.nodeId);
      expect(keptRow?.name).toBe('kept-renamed');
      expect(keptRow?.version).toBe('1.1.11');
      expect(keptRow?.directCapable).toBe(true);
      expect(keptRow?.status).toBe('enrolled');
      expect(keptRow?.lastSeenAt).toBe(9_000);
      expect(JSON.parse(keptRow?.endpointsJson ?? 'null')).toEqual([{ host: '10.0.0.1' }]);
      expect(JSON.parse(keptRow?.inventoryJson ?? 'null')).toEqual({ panes: 2 });

      const created = userStore.getNode(certOnlyId);
      expect(created).not.toBeNull();
      expect(created?.name).toBe('new-from-cert');
      expect(created?.status).toBe('enrolled');
      expect(created?.userId).toBe(user.id);

      expect(userStore.getNode(UNKNOWN)).toBeNull();
      expect(userStore.getNode(revoked.nodeId)?.status).toBe('revoked');
      expect(userStore.getNode(revoked.nodeId)?.name).toBe('revoked');

      const absentRow = userStore.getNode(absent.nodeId);
      expect(absentRow).not.toBeNull();
      expect(absentRow?.name).toBe('absent');
      expect(absentRow?.lastSeenAt).toBeNull();

      expect(hub.meshHubs.get(WRITER)?.publicUrl).toBe('https://writer.example');
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      expect(hub.meshHubs.get(SELF)?.publicUrl).toBe('https://standby.example');
      hub.stop();
    } finally {
      close();
    }
  });

  test('source=self 的 node.list 被忽略', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { hub, userStore, user } = makeHub(db);
      const node = seedAdmittedNode(userStore, user.id, { name: 'local', now: 1_000 });
      hub.applyReplicatedNodeList(
        listOf(
          [
            {
              id: node.nodeId,
              name: 'hijacked',
              online: true,
              endpoints: [],
              inventory: {},
              direct_capable: false,
              version: '9.9.9',
            },
          ],
          [endpoint(WRITER, { publicUrl: 'https://should-not-appear.example' })]
        ),
        { hubNodeId: SELF }
      );
      expect(userStore.getNode(node.nodeId)?.name).toBe('local');
      expect(hub.meshHubs.get(WRITER)).toBeNull();
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      hub.stop();
    } finally {
      close();
    }
  });

  test('replaceAll 保留自身行，即使 list.hubs 未包含自己', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { hub } = makeHub(db);
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      hub.applyReplicatedNodeList(
        listOf([], [endpoint(WRITER, { mode: 'active', writerEpoch: 8 })]),
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      expect(hub.meshHubs.get(SELF)?.writerEpoch).toBe(1);
      expect(hub.meshHubs.get(SELF)?.online).toBe(true);
      expect(hub.meshHubs.get(WRITER)?.writerEpoch).toBe(8);
      hub.stop();
    } finally {
      close();
    }
  });

  test('自身行被删后仍从 config 快照写回，不依赖 store 残留', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { hub } = makeHub(db);
      hub.meshHubs.remove(SELF);
      expect(hub.meshHubs.get(SELF)).toBeNull();
      hub.applyReplicatedNodeList(
        listOf([], [endpoint(WRITER, { mode: 'active', writerEpoch: 8 })]),
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(SELF)).toMatchObject({
        mode: 'standby',
        priority: 200,
        writerEpoch: 1,
        publicUrl: 'https://standby.example',
        online: true,
      });
      hub.stop();
    } finally {
      close();
    }
  });

  test('legacy node.list 在合成 active 行 replaceAll 后仍写回自身 standby', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { hub } = makeHub(db);
      hub.meshHubs.replaceAll(
        [
          {
            hubNodeId: WRITER,
            publicUrl: 'https://writer.example',
            name: 'writer',
            mode: 'active',
            priority: 100,
            writerEpoch: 1,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        9_000
      );
      expect(hub.meshHubs.get(SELF)).toBeNull();
      hub.applyReplicatedNodeList(
        {
          t: 'node.list',
          version: 1,
          key_log_head: { seq: 0n, hash: new Uint8Array(32) },
          rtc: { stun: [], turn: null },
          nodes: [],
          hub: { nodeId: WRITER, publicUrl: 'https://writer.example', name: 'writer' },
          writerEpoch: 1,
        },
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(WRITER)).toMatchObject({
        mode: 'active',
        publicUrl: 'https://writer.example',
        writerEpoch: 1,
        online: true,
      });
      expect(hub.meshHubs.get(SELF)).toMatchObject({
        mode: 'standby',
        priority: 200,
        writerEpoch: 1,
        publicUrl: 'https://standby.example',
        online: true,
      });
      hub.stop();
    } finally {
      close();
    }
  });

  test('legacy 合成行仅在 authorized 或 source 时保留', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const stranger = 'dd'.repeat(16);
      const authorized = 'ee'.repeat(16);
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore, { now: 9_000 });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://standby.example',
          stun: [],
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          hubNodeId: SELF,
          nodeId: SELF,
          authorizedHubIds: [authorized],
        },
        authenticate: () => ({ userId: user.id, entryNodeId: SELF }),
        now: () => 9_000,
      });
      hub.meshHubs.replaceAll(
        [
          {
            hubNodeId: stranger,
            publicUrl: 'https://evil.example',
            name: 'evil',
            mode: 'active',
            priority: 100,
            writerEpoch: 99,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        9_000
      );
      hub.applyReplicatedNodeList(
        {
          t: 'node.list',
          version: 1,
          key_log_head: { seq: 0n, hash: new Uint8Array(32) },
          rtc: { stun: [], turn: null },
          nodes: [],
          hub: { nodeId: stranger, publicUrl: 'https://evil.example', name: 'evil' },
          writerEpoch: 99,
        },
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(stranger)).toBeNull();
      expect(hub.meshHubs.get(WRITER)).toBeNull();
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      hub.stop();
    } finally {
      close();
    }
  });

  test('legacy source hub 不在 authorizedHubIds 且无签名授权则不保留', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const authorized = 'ee'.repeat(16);
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore, { now: 9_000 });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://standby.example',
          stun: [],
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          hubNodeId: SELF,
          nodeId: SELF,
          authorizedHubIds: [authorized],
        },
        authenticate: () => ({ userId: user.id, entryNodeId: SELF }),
        now: () => 9_000,
      });
      hub.applyReplicatedNodeList(
        {
          t: 'node.list',
          version: 1,
          key_log_head: { seq: 0n, hash: new Uint8Array(32) },
          rtc: { stun: [], turn: null },
          nodes: [],
          hub: { nodeId: WRITER, publicUrl: 'https://writer.example' },
          writerEpoch: 4,
        },
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(WRITER)).toBeNull();
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      expect(hub.meshHubs.get(authorized)).toBeNull();
      hub.stop();
    } finally {
      close();
    }
  });

  test('source=self 的 legacy node.list 也被忽略', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { hub } = makeHub(db);
      hub.applyReplicatedNodeList(
        {
          t: 'node.list',
          version: 1,
          key_log_head: { seq: 0n, hash: new Uint8Array(32) },
          rtc: { stun: [], turn: null },
          nodes: [],
          hub: { nodeId: WRITER, publicUrl: 'https://should-not-appear.example' },
          writerEpoch: 9,
        },
        { hubNodeId: SELF }
      );
      expect(hub.meshHubs.get(WRITER)).toBeNull();
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      hub.stop();
    } finally {
      close();
    }
  });

  test('复制 hubs[] 只保留当前已授权 hub（含 self，不含未授权 source）', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const stranger = 'dd'.repeat(16);
      const authorized = 'ee'.repeat(16);
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore, { now: 9_000 });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://standby.example',
          stun: [],
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          hubNodeId: SELF,
          nodeId: SELF,
          authorizedHubIds: [authorized],
        },
        authenticate: () => ({ userId: user.id, entryNodeId: SELF }),
        now: () => 9_000,
      });
      hub.applyReplicatedNodeList(
        listOf(
          [],
          [
            endpoint(WRITER, { publicUrl: 'https://writer.example' }),
            endpoint(authorized, { publicUrl: 'https://peer.example', mode: 'standby' }),
            endpoint(stranger, { publicUrl: 'https://evil.example', writerEpoch: 99 }),
          ]
        ),
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(WRITER)).toBeNull();
      expect(hub.meshHubs.get(authorized)?.publicUrl).toBe('https://peer.example');
      expect(hub.meshHubs.get(stranger)).toBeNull();
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      hub.stop();
    } finally {
      close();
    }
  });

  test('signed-retired 的 source 即使匹配 seed/env 也不能写回 mesh_hubs', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const { userStore, keyLogSource } = createHubTestStack(db);
      const user = seedUser(userStore, { now: 9_000 });
      userStore.upsertHubAuthorization({
        userId: user.id,
        hubNodeId: WRITER,
        status: 'retired',
        publicUrl: 'https://writer.example',
        admitSeq: 1,
        retireSeq: 2,
        updatedSeq: 2,
      });
      const hub = new HubRuntime({
        db,
        userStore,
        keyLogSource,
        config: {
          publicUrl: 'https://standby.example',
          stun: [],
          mode: 'standby',
          priority: 200,
          writerEpoch: 1,
          hubNodeId: SELF,
          nodeId: SELF,
          authorizedHubIds: [WRITER],
        },
        authenticate: () => ({ userId: user.id, entryNodeId: SELF }),
        now: () => 9_000,
      });
      hub.meshHubs.replaceAll(
        [
          {
            hubNodeId: WRITER,
            publicUrl: 'https://writer.example',
            name: 'writer',
            mode: 'active',
            priority: 100,
            writerEpoch: 9,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        9_000
      );
      hub.applyReplicatedNodeList(
        listOf([], [endpoint(WRITER, { publicUrl: 'https://writer.example', writerEpoch: 99 })]),
        { hubNodeId: WRITER }
      );
      expect(hub.meshHubs.get(WRITER)).toBeNull();
      expect(hub.meshHubs.get(SELF)?.mode).toBe('standby');
      expect(hub.uplink.isAuthorizedHub(WRITER)).toBe(false);
      hub.stop();
    } finally {
      close();
    }
  });
});
