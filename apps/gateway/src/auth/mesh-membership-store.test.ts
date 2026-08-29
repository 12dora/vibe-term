import { describe, expect, test } from 'bun:test';
import { HubTrustStore } from './hub-trust-store';
import { KeyLogStore } from './key-log-store';
import { MeshMembershipStore } from './mesh-membership-store';
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
  test('deletes users, derived rows, nodes, enrollments, peers, hub_trust, and node_identity', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      const keyLog = new KeyLogStore(db);
      const sessions = new NodeSessionStore(db);
      const identity = new NodeIdentityStore(db);
      const trust = new HubTrustStore(db);

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
        'node_identity',
      ]) {
        expect(tableCount(sqlite, table)).toBe(0);
      }
      expect(users.listUsers()).toHaveLength(0);
      expect(await identity.load()).toBeNull();
      expect(trust.get('https://hub.example')).toBeNull();
    } finally {
      close();
    }
  });
});
