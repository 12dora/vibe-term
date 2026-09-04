import { describe, expect, test } from 'bun:test';
import { RelayConfigStore } from '../relay/relay-config-store';
import { RelayTenantStore } from '../relay/relay-tenant-store';
import { HubTrustStore } from './hub-trust-store';
import { KeyLogStore } from './key-log-store';
import { MeshHubStore } from './mesh-hub-store';
import { MeshMembershipStore } from './mesh-membership-store';
import { MeshRelayStore } from './mesh-relay-store';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const ROOT_PK = Uint8Array.from({ length: 32 }, () => 7);
const HEAD_HASH = Uint8Array.from({ length: 32 }, () => 8);
const CRED = Uint8Array.from({ length: 20 }, (_, i) => i);
const COSE = Uint8Array.from({ length: 64 }, (_, i) => 100 + i);
const ENROLL_PK = Uint8Array.from({ length: 32 }, () => 9);
const AUTH_SIG = Uint8Array.from({ length: 64 }, () => 3);
const CERT = Uint8Array.from({ length: 48 }, () => 4);
const CERT_SIG = Uint8Array.from({ length: 64 }, () => 5);
const AUTH_BYTES = Uint8Array.from({ length: 40 }, () => 6);
const ED = crypto.getRandomValues(new Uint8Array(32));
const X25519 = crypto.getRandomValues(new Uint8Array(32));
const IDENTITY_SIG = crypto.getRandomValues(new Uint8Array(64));
const PREV = Uint8Array.from({ length: 32 }, () => 1);
const HASH = Uint8Array.from({ length: 32 }, () => 2);
const BYTES = Uint8Array.from({ length: 12 }, (_, i) => i + 3);
const LOG_SIG = Uint8Array.from({ length: 64 }, () => 9);

function tableCount(
  sqlite: { query: (sql: string) => { get: () => unknown } },
  table: string
): number {
  const row = sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('MeshMembershipStore.clearAll', () => {
  test('deletes users, derived rows, nodes, enrollments, peers, hub_trust, mesh_hubs, mesh_relays, mesh_secrets, and node_identity', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      const keyLog = new KeyLogStore(db);
      const sessions = new NodeSessionStore(db);
      const identity = new NodeIdentityStore(db);
      const trust = new HubTrustStore(db);
      const hubs = new MeshHubStore(db);

      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: ROOT_PK,
        rootEpoch: 0,
        kdfParamsJson: '{"kdf":"argon2id"}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: HEAD_HASH,
        now: 1_000,
      });
      users.insertKey({
        id: 'key-1',
        userId: 'user-1',
        credentialId: CRED,
        publicKey: COSE,
        rpId: 'localhost',
        origin: 'http://localhost',
        counter: 0,
        logSeq: 1,
        now: 1,
      });
      keyLog.append({
        userId: 'user-1',
        seq: 1,
        prevHash: PREV,
        hash: HASH,
        rootEpoch: 0,
        type: 'reset-root',
        recordBytes: BYTES,
        sig: LOG_SIG,
        payloadJson: '{}',
        createdAt: 2_000,
      });
      sessions.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: new Uint8Array(32),
        delegationMethod: 'root',
        now: 1_000,
      });
      users.upsertCert({
        nodeId: 'node-a',
        userId: 'user-1',
        admitRecordSeq: 1,
        certificateBytes: CERT,
        certSig: CERT_SIG,
        authorizationBytes: AUTH_BYTES,
        authorizationSig: AUTH_SIG,
      });
      users.createNode({ id: 'node-a-reg', userId: 'user-1', name: 'hub', now: 1 });
      users.createEnrollmentToken({
        id: 'tok-1',
        userId: 'user-1',
        enrollPublicKey: ENROLL_PK,
        authorizationJson: '{}',
        authorizationSig: AUTH_SIG,
        expiresAt: 9_999,
      });
      users.upsertPeer({
        nodeId: 'peer-1',
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 10,
        listVersion: 1,
      });
      trust.put({
        hubUrl: 'https://hub.example',
        caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        fingerprint: 'ab'.repeat(32),
      });
      await identity.save({
        nodeId: 'node-1',
        hubUrl: 'https://hub.example',
        edPrivateKey: ED,
        x25519PrivateKey: X25519,
        certificateJson: '{}',
        certSig: IDENTITY_SIG,
        userId: 'user-1',
      });
      hubs.upsert(
        {
          hubNodeId: 'aa'.repeat(16),
          publicUrl: 'https://hub.example',
          name: 'stale-hub',
          mode: 'active',
          priority: 1,
          writerEpoch: 1,
          caFingerprint: null,
          online: true,
          lastSeenAt: 10,
        },
        1_000
      );
      expect(hubs.list()).toHaveLength(1);

      // 中继模式的落库状态：租户令牌 + K_log / K_meta + uplink_kind / name
      const relays = new MeshRelayStore(db);
      await relays.replaceRelays(
        [
          {
            url: 'https://relay.example',
            tenantId: 'ab'.repeat(16),
            token: Uint8Array.from({ length: 32 }, () => 7),
            priority: 0,
          },
        ],
        1_000
      );
      await relays.putSecret(
        'log',
        0,
        Uint8Array.from({ length: 32 }, () => 1),
        1_000
      );
      await relays.putSecret(
        'meta',
        1,
        Uint8Array.from({ length: 32 }, () => 2),
        1_000
      );
      relays.setUplinkKind('relay');
      relays.setLocalName('studio');
      expect(relays.listRelayRows()).toHaveLength(1);
      expect(relays.listSecretEpochs('meta')).toEqual([1]);

      new MeshMembershipStore(db).clearAll();

      for (const table of [
        'users',
        'user_keys',
        'user_key_log',
        'node_sessions',
        'node_certs',
        'nodes',
        'enrollment_tokens',
        'peer_cache',
        'hub_trust',
        'mesh_hubs',
        'mesh_relays',
        'mesh_secrets',
        'node_identity',
      ]) {
        expect(tableCount(sqlite, table)).toBe(0);
      }
      // uplink_kind / name 随 node_identity 整行消失，退出后不残留租户密钥
      expect(relays.listRelayRows()).toHaveLength(0);
      expect(relays.listSecretEpochs('log')).toEqual([]);
      expect(relays.uplinkKind()).toBe('hub');
      expect(relays.localName()).toBeNull();
      expect(users.listUsers()).toHaveLength(0);
      expect(await identity.load()).toBeNull();
      expect(trust.get('https://hub.example')).toBeNull();
      expect(hubs.list()).toHaveLength(0);
    } finally {
      close();
    }
  });

  test('clearMeshMembership keeps relay operator tables', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: ROOT_PK,
        rootEpoch: 0,
        kdfParamsJson: '{"kdf":"argon2id"}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: HEAD_HASH,
        now: 1_000,
      });
      new RelayConfigStore(db).ensure(1_000);
      new RelayTenantStore(db).create({
        id: 'ab'.repeat(16),
        rootPublicKey: Uint8Array.from({ length: 32 }, () => 3),
        rootEpoch: 0,
        tokenHash: 'aa'.repeat(32),
        tokenEpoch: 0,
        now: 1_000,
      });
      new MeshMembershipStore(db).clearMeshMembership();
      expect(tableCount(sqlite, 'users')).toBe(0);
      expect(tableCount(sqlite, 'relay_config')).toBe(1);
      expect(tableCount(sqlite, 'relay_tenants')).toBe(1);
    } finally {
      close();
    }
  });

  test('clearRelayOperatorState keeps mesh membership', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: ROOT_PK,
        rootEpoch: 0,
        kdfParamsJson: '{"kdf":"argon2id"}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: HEAD_HASH,
        now: 1_000,
      });
      new RelayConfigStore(db).ensure(1_000);
      new RelayTenantStore(db).create({
        id: 'ab'.repeat(16),
        rootPublicKey: Uint8Array.from({ length: 32 }, () => 3),
        rootEpoch: 0,
        tokenHash: 'aa'.repeat(32),
        tokenEpoch: 0,
        now: 1_000,
      });
      new MeshMembershipStore(db).clearRelayOperatorState();
      expect(tableCount(sqlite, 'users')).toBe(1);
      expect(tableCount(sqlite, 'relay_config')).toBe(0);
      expect(tableCount(sqlite, 'relay_tenants')).toBe(0);
    } finally {
      close();
    }
  });

  test('clearAll wipes both mesh membership and relay operator state', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: ROOT_PK,
        rootEpoch: 0,
        kdfParamsJson: '{"kdf":"argon2id"}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: HEAD_HASH,
        now: 1_000,
      });
      new RelayConfigStore(db).ensure(1_000);
      new MeshMembershipStore(db).clearAll();
      expect(tableCount(sqlite, 'users')).toBe(0);
      expect(tableCount(sqlite, 'relay_config')).toBe(0);
    } finally {
      close();
    }
  });
});
