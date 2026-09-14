import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { legacyReleaseTarballName, releaseTarballName, wsBorsh } from '@vibeterm/shared';
import {
  DOMAIN_CERTIFICATE,
  encodeBase64url,
  encodeCertificate,
  hexToBytes,
} from '@vibeterm/shared/auth';
import { CONNECTION_HEADER } from '@vibeterm/shared/http/mesh-headers';
import type { LinkSession } from '@vibeterm/shared/link';
import { runMigrations } from '../db/migrate';
import { resetReleaseDownloadForTests } from '../system/release-download';
import {
  resetRemoteUpgradeJobsForTests,
  waitForRemoteUpgradeJob,
} from '../system/remote-upgrade-job';
import { resetLatestReleaseCache } from '../system/update-check';
import { restoreSigningKeys, signSums, useTestSigningKeys } from '../test-support/release-signing';
import {
  FakePeers,
  FakeStreams,
  NODE_ID,
  NODE_PK,
  asResponse,
  bootMesh,
  call,
  challengeAndLogin,
  dummyServer,
} from './auth-routes.test';
import {
  type CachedRtcConfig,
  MESH_REJECT_4401_KIND,
  MESH_WS_BACKPRESSURE_LIMIT_BYTES,
  MESH_WS_KIND,
  type MeshServerWebSocket,
  WS_CLOSE_LOGIN_REQUIRED,
} from './mesh-deps';
import { resetNodeOperationsForTests } from './node-operations';

beforeAll(() => {
  useTestSigningKeys();
});

afterAll(() => {
  restoreSigningKeys();
});

const PEER_ID = 'cc'.repeat(16);
const REVOKED_ID = 'dd'.repeat(16);

describe('mesh-routes', () => {
  test('GET /api/mesh/nodes merges certs, peer_cache, reach, loggedIn; includes self; drops revoked', async () => {
    const peers = new FakePeers();
    peers.reach.set(PEER_ID, 'lan');
    peers.transport.set(PEER_ID, 'dc');
    const mesh = await bootMesh({
      peers,
      listedNames: () => [{ id: PEER_ID, name: 'studio' }],
    });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{"version":"1.2.3"}',
        directCapable: true,
        lastSeenAt: 1,
        listVersion: 7,
      });
      mesh.userStore.upsertCert({
        nodeId: REVOKED_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 3,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(REVOKED_ID),
          ed_pk: new Uint8Array(32).fill(8),
          x25519_pk: new Uint8Array(32).fill(8),
          enroll_pk: new Uint8Array(32).fill(8),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
        revokedLogSeq: 9,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${PEER_ID}=xyz` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          name: string;
          publicKey: string;
          online: boolean;
          reach: string | null;
          transport: 'ws-secure' | 'relay' | 'dc' | null;
          loggedIn: boolean;
          direct_capable: boolean;
          version: string | null;
        }>;
      };
      const ids = body.nodes.map((n) => n.id);
      expect(ids).toContain(NODE_ID);
      expect(ids).toContain(PEER_ID);
      expect(ids).not.toContain(REVOKED_ID);
      const self = body.nodes.find((n) => n.id === NODE_ID);
      expect(self?.online).toBe(true);
      expect(self?.loggedIn).toBe(true);
      expect(self?.publicKey).toBe(encodeBase64url(NODE_PK));
      const peer = body.nodes.find((n) => n.id === PEER_ID);
      expect(peer?.name).toBe('studio');
      expect(peer?.online).toBe(true);
      expect(peer?.reach).toBe('lan');
      expect(peer?.transport).toBe('dc');
      expect((peer as { rttMs?: number | null })?.rttMs).toBeNull();
      expect(peer?.loggedIn).toBe(true);
      expect(peer?.direct_capable).toBe(true);
      expect(peer?.version).toBe('1.2.3');
      expect('isHub' in (self ?? {})).toBe(false);
      expect('isHub' in (peer ?? {})).toBe(false);
      expect(
        (self as { ports?: Array<{ purpose: string }> }).ports?.some(
          (row) => row.purpose === 'peer-signaling'
        )
      ).toBe(true);
      expect(
        (peer as { ports?: Array<{ purpose: string }> }).ports?.some(
          (row) => row.purpose === 'rtc-ice'
        )
      ).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes reports listVersion and pendingMembers', async () => {
    const mesh = await bootMesh({ peers: new FakePeers() });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const read = async () => {
        const res = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
          headers: { cookie: `vibeterm_s_self=${sid}` },
        });
        return (await res.json()) as { listVersion: number; pendingMembers: number };
      };

      // 证书已在、状态块还没解开、本进程也还没应用过成员列表：该成员算「还在同步」
      expect(await read()).toMatchObject({
        listVersion: 0,
        pendingMembers: 1,
        pendingMemberIds: [PEER_ID],
      });

      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 5,
      });
      expect(await read()).toMatchObject({
        listVersion: 5,
        pendingMembers: 0,
        pendingMemberIds: [],
      });
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes 不把「列表已应用但离线」的成员一直算作同步中', async () => {
    // 状态块只随活着的链路广播：列表已经应用过、这台又离线，就再也等不到了
    const mesh = await bootMesh({
      peers: new FakePeers(),
      listedNames: () => [{ id: PEER_ID, name: PEER_ID }],
    });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await res.json()) as {
        pendingMembers: number;
        nodes: Array<{ id: string; online: boolean }>;
      };
      expect(body.pendingMembers).toBe(0);
      expect(body.nodes.find((n) => n.id === PEER_ID)?.online).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes reports wan reach, transport and rttMs', async () => {
    const peers = new FakePeers();
    peers.reach.set(PEER_ID, 'wan');
    peers.transport.set(PEER_ID, 'ws-secure');
    peers.rtt.set(PEER_ID, 80);
    const mesh = await bootMesh({ peers });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          online: boolean;
          reach: string | null;
          transport: string | null;
          rttMs: number | null;
        }>;
      };
      const peer = body.nodes.find((n) => n.id === PEER_ID);
      expect(peer?.online).toBe(true);
      expect(peer?.reach).toBe('wan');
      expect(peer?.transport).toBe('ws-secure');
      expect(peer?.rttMs).toBe(80);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes reports viaRelay and relayPresence for relay links', async () => {
    const peers = new FakePeers();
    peers.reach.set(PEER_ID, 'relay');
    peers.transport.set(PEER_ID, 'relay');
    peers.rtt.set(PEER_ID, 44);
    (
      peers as FakePeers & {
        viaRelayOf: (id: string) => string | null;
        relayPresenceOf: (id: string) => string[] | undefined;
      }
    ).viaRelayOf = (id) => (id === PEER_ID ? 'https://sh.example' : null);
    (
      peers as FakePeers & {
        viaRelayOf: (id: string) => string | null;
        relayPresenceOf: (id: string) => string[] | undefined;
      }
    ).relayPresenceOf = (id) =>
      id === PEER_ID ? ['https://sh.example', 'https://ty.example'] : undefined;
    const mesh = await bootMesh({ peers });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          transport: string | null;
          viaRelay?: string | null;
          relayPresence?: string[];
        }>;
      };
      const peer = body.nodes.find((n) => n.id === PEER_ID);
      expect(peer?.transport).toBe('relay');
      expect(peer?.viaRelay).toBe('https://sh.example');
      expect(peer?.relayPresence).toEqual(['https://sh.example', 'https://ty.example']);
      const self = body.nodes.find((n) => n.id === NODE_ID);
      expect(self?.viaRelay).toBeUndefined();
      expect(self?.relayPresence).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes returns peerAddress, linkSinceAt, endpoints and directFailure', async () => {
    const peers = new FakePeers();
    peers.reach.set(PEER_ID, 'relay');
    peers.transport.set(PEER_ID, 'relay');
    peers.rtt.set(PEER_ID, 38);
    const details = {
      peerAddress: 'hub.example.com',
      linkSinceAt: 1_700_000_000_000,
      endpoints: ['ws://10.110.88.3:39001/peer', 'ws://172.17.0.1:39001/peer'],
      directFailure: {
        at: 1_700_000_000_100,
        ws: 'timeout ws://10.110.88.3:39001/peer',
        dc: 'datachannel unavailable',
      },
    };
    (
      peers as FakePeers & {
        linkDetailOf: (id: string) => typeof details | null;
      }
    ).linkDetailOf = (id) => (id === PEER_ID ? details : null);
    const mesh = await bootMesh({ peers });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'studio',
        endpointsJson: JSON.stringify(details.endpoints),
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          peerAddress?: string | null;
          linkSinceAt?: number | null;
          endpoints?: string[];
          directFailure?: { at: number; ws?: string | null; dc?: string | null } | null;
        }>;
      };
      const peer = body.nodes.find((n) => n.id === PEER_ID);
      expect(peer?.peerAddress).toBe('hub.example.com');
      expect(peer?.linkSinceAt).toBe(1_700_000_000_000);
      expect(peer?.endpoints).toEqual(details.endpoints);
      expect(peer?.directFailure).toEqual(details.directFailure);
      const self = body.nodes.find((n) => n.id === NODE_ID);
      expect(self?.peerAddress).toBeNull();
      expect(self?.linkSinceAt).toBeNull();
      expect(self?.endpoints).toEqual([]);
      expect(self?.directFailure).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes uses nodes registry names when peer_cache is empty', async () => {
    const mesh = await bootMesh({ roles: { node: true, relay: false } });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.createNode({
        id: PEER_ID,
        userId: mesh.boot.userId,
        name: 'node-a',
        now: 1,
      });
      mesh.userStore.createNode({
        id: NODE_ID,
        userId: mesh.boot.userId,
        name: 'hub-home',
        now: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{ id: string; name: string }>;
      };
      expect(body.nodes.find((n) => n.id === PEER_ID)?.name).toBe('node-a');
      expect(body.nodes.find((n) => n.id === NODE_ID)?.name).toBe('hub-home');
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes ignores a peer-advertised name in peer_cache', async () => {
    const mesh = await bootMesh({
      listedNames: () => [{ id: PEER_ID, name: 'studio' }],
    });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'production-db',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{ id: string; name: string }>;
      };
      expect(body.nodes.find((n) => n.id === PEER_ID)?.name).toBe('studio');
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes falls back to id when only peer_cache has a name', async () => {
    const mesh = await bootMesh();
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'production-db',
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{ id: string; name: string }>;
      };
      expect(body.nodes.find((n) => n.id === PEER_ID)?.name).toBe(PEER_ID);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes prefers listed names over raw ids in peer_cache', async () => {
    const mesh = await bootMesh({
      listedNames: () => [
        { id: PEER_ID, name: 'studio' },
        { id: NODE_ID, name: 'home' },
      ],
      selfName: () => 'home',
    });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: PEER_ID,
        endpointsJson: '[]',
        inventoryJson: '{}',
        directCapable: false,
        lastSeenAt: 1,
        listVersion: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{ id: string; name: string }>;
      };
      expect(body.nodes.find((n) => n.id === PEER_ID)?.name).toBe('studio');
      expect(body.nodes.find((n) => n.id === NODE_ID)?.name).toBe('home');
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes reports live self.direct_capable, version, and inventory', async () => {
    const mesh = await bootMesh({
      selfStatus: () => ({
        version: '9.9.9-test',
        tmux: true,
        direct_capable: true,
        inventory: { version: '9.9.9-test', devices: 1 },
        endpoints: ['ws://10.0.0.8:39001/peer'],
      }),
    });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          version: string | null;
          direct_capable: boolean;
          inventory: unknown;
        }>;
      };
      const self = body.nodes.find((n) => n.id === NODE_ID);
      expect(self?.direct_capable).toBe(true);
      expect(self?.version).toBe('9.9.9-test');
      expect(self?.inventory).toEqual({ version: '9.9.9-test', devices: 1 });
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes keeps uplink-list online without inventing reach', async () => {
    const peers = new FakePeers();
    peers.hubOnline.add(PEER_ID);
    const mesh = await bootMesh({ peers });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      const body = (await list.json()) as {
        nodes: Array<{ id: string; online: boolean; reach: string | null }>;
      };
      const peer = body.nodes.find((n) => n.id === PEER_ID);
      expect(peer?.online).toBe(true);
      expect(peer?.reach).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes broadcasts ENROLL_REDEEMED to the matching mesh socket', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const frames: Uint8Array[] = [];
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        send(d: Uint8Array) {
          frames.push(d);
          return d.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const enrollPk = new Uint8Array(32).fill(1);
      const certificate = new Uint8Array([9, 8, 7]);
      const certSig = new Uint8Array(64).fill(2);
      const otherFrames: Uint8Array[] = [];
      const other = {
        data: { kind: MESH_WS_KIND, sid: `${sid}-other`, uid: mesh.boot.userId },
        send(d: Uint8Array) {
          otherFrames.push(d);
          return d.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(other);
      mesh.runtime.mesh.forwardEnrollRedeemed({
        enrollPk,
        certificate,
        certSig,
        nodeId: PEER_ID,
        entrySid: sid,
      });
      expect(frames).toHaveLength(1);
      expect(otherFrames).toHaveLength(0);
      const frame = frames[0];
      if (!frame) throw new Error('missing ENROLL_REDEEMED frame');
      const env = wsBorsh.decodeEnvelope(frame);
      expect(env.kind).toBe(wsBorsh.KIND_ENROLL_REDEEMED);
      const payload = wsBorsh.decodePayload(wsBorsh.schema.EnrollRedeemedSchema, env.payload);
      expect(payload.nodeId).toBe(PEER_ID);
      expect(payload.enrollPk).toEqual(enrollPk);
      expect(payload.certificate).toEqual(certificate);
      expect(payload.certSig).toEqual(certSig);
      mesh.runtime.mesh.forwardEnrollRedeemed({
        enrollPk,
        certificate,
        certSig,
        nodeId: PEER_ID,
      });
      expect(frames).toHaveLength(1);
      expect(otherFrames).toHaveLength(0);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/rtc-config and POST /api/rtc/authorize', async () => {
    const mesh = await bootMesh({
      rtc: {
        config: { getRtcConfig: () => ({ stun: ['stun:ex'], turn: [] }) },
      },
    });
    try {
      const denied = await call(mesh.runtime, 'http://localhost/api/mesh/rtc-config');
      expect(denied.status).toBe(401);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cfg = await call(mesh.runtime, 'http://localhost/api/mesh/rtc-config', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(await cfg.json()).toEqual({ stun: ['stun:ex'], turn: [] });
    } finally {
      mesh.close();
    }

    const withSource = await bootMesh({
      rtc: {
        config: {
          getRtcConfig: () => ({
            stun: ['stun:ex'],
            turn: [],
            source: 'builtin',
          }),
        },
      },
    });
    try {
      const { sid } = await challengeAndLogin(withSource.runtime, withSource.boot);
      const cfg = await call(withSource.runtime, 'http://localhost/api/mesh/rtc-config', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(await cfg.json()).toEqual({ stun: ['stun:ex'], turn: [], source: 'builtin' });
    } finally {
      withSource.close();
    }

    const withTurnProbe = await bootMesh({
      rtc: {
        config: {
          getRtcConfig: () =>
            ({
              stun: ['stun:ex'],
              turn: [],
              turnConfigured: [
                {
                  url: 'turn:relay.example:3478',
                  username: 'u',
                  credential: 'p',
                },
              ],
              turnProbe: {
                url: 'turn:relay.example:3478',
                ok: false,
                rttMs: 2000,
                error: 'timeout',
                probedAt: 1,
              },
              turnProbes: [
                {
                  url: 'turn:relay.example:3478',
                  ok: false,
                  rttMs: 2000,
                  error: 'timeout',
                  probedAt: 1,
                },
              ],
              probes: [],
            }) as CachedRtcConfig,
        },
      },
    });
    try {
      const { sid } = await challengeAndLogin(withTurnProbe.runtime, withTurnProbe.boot);
      const cfg = await call(withTurnProbe.runtime, 'http://localhost/api/mesh/rtc-config', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(await cfg.json()).toEqual({
        stun: ['stun:ex'],
        turn: [],
        turnConfigured: [
          {
            url: 'turn:relay.example:3478',
            username: 'u',
            credential: 'p',
          },
        ],
        turnProbe: {
          url: 'turn:relay.example:3478',
          ok: false,
          rttMs: 2000,
          error: 'timeout',
          probedAt: 1,
        },
        turnProbes: [
          {
            url: 'turn:relay.example:3478',
            ok: false,
            rttMs: 2000,
            error: 'timeout',
            probedAt: 1,
          },
        ],
        probes: [],
      });
    } finally {
      withTurnProbe.close();
    }

    const noRtc = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(noRtc.runtime, noRtc.boot);
      const authz = await call(noRtc.runtime, 'http://localhost/api/rtc/authorize', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `vibeterm_s_self=${sid}`,
        },
        body: JSON.stringify({
          rtcSession: 's1',
          fp_browser: { algorithm: 'sha-256', value: 'AA' },
        }),
      });
      expect(authz.status).toBe(503);
      expect((await authz.json()).code).toBe('DIRECT_UNAVAILABLE');
    } finally {
      noRtc.close();
    }

    const withFp = await bootMesh();
    try {
      const runtime = new (await import('./mesh-http')).MeshHttpRuntime({
        roles: { node: true, relay: false },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: withFp.userStore,
        keyLogService: withFp.keyLogService,
        challengeStore: withFp.challengeStore,
        nodeSessionStore: withFp.nodeSessionStore,
        peers: withFp.peers,
        streams: withFp.streams,
        publisher: { publish() {} },
        rtc: {
          fingerprint: {
            authorizeBrowser: () => ({
              nonce: new Uint8Array(32).fill(7),
              fpNode: { algorithm: 'sha-256', value: 'BB' },
            }),
          },
        },
        primaryUserId: withFp.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, withFp.boot);
      const ok = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/rtc/authorize', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: `vibeterm_s_self=${sid}`,
            },
            body: JSON.stringify({
              rtcSession: 's1',
              fp_browser: { algorithm: 'sha-256', value: 'AA' },
            }),
          }),
          dummyServer
        )
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { nonce: string; fp_node: { value: string } };
      expect(body.fp_node.value).toBe('BB');
      expect(body.nonce.length).toBeGreaterThan(10);
      runtime.stop();
    } finally {
      withFp.close();
    }
  });

  test('GET /api/mesh/connection and authorize bind connectionId; 409 when multiple', async () => {
    const { MeshHttpRuntime } = await import('./mesh-http');
    const mesh = await bootMesh();
    try {
      const lookups: Array<{
        sid: string;
        via: string;
        connectionId?: string | null;
        cid?: string | null;
      }> = [];
      let mode: 'one' | 'many' | 'none' | 'match' = 'one';
      const runtime = new MeshHttpRuntime({
        roles: { node: true, relay: false },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        peers: mesh.peers,
        streams: mesh.streams,
        publisher: { publish() {} },
        rtc: {
          fingerprint: {
            authorizeBrowser: (input) => ({
              nonce: new Uint8Array(32).fill(7),
              fpNode: { algorithm: 'sha-256', value: input.connectionId ?? 'none' },
            }),
          },
        },
        connectionLookup: (input) => {
          lookups.push(input);
          if (mode === 'none') return { ok: false, code: 'NO_CONNECTION' };
          if (mode === 'many' && !input.connectionId && !input.cid) {
            return { ok: false, code: 'MULTIPLE_CONNECTIONS' };
          }
          if (input.cid) {
            return { ok: true, connectionId: `server-for-${input.cid}` };
          }
          return { ok: true, connectionId: input.connectionId || 'conn-latest' };
        },
        primaryUserId: mesh.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, mesh.boot);
      const cookie = `vibeterm_s_self=${sid}`;
      const one = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection', { headers: { cookie } }),
          dummyServer
        )
      );
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({ connectionId: 'conn-latest' });

      mode = 'many';
      const many = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection', { headers: { cookie } }),
          dummyServer
        )
      );
      expect(many.status).toBe(409);
      expect((await many.json()).code).toBe('MULTIPLE_CONNECTIONS');

      const headered = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection', {
            headers: { cookie, [CONNECTION_HEADER.name]: 'tab-a' },
          }),
          dummyServer
        )
      );
      expect(headered.status).toBe(200);
      expect(await headered.json()).toEqual({ connectionId: 'tab-a' });

      const byCid = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection?cid=tab-nonce', {
            headers: { cookie },
          }),
          dummyServer
        )
      );
      expect(byCid.status).toBe(200);
      expect(await byCid.json()).toEqual({ connectionId: 'server-for-tab-nonce' });
      expect(lookups.some((row) => row.cid === 'tab-nonce')).toBe(true);

      mode = 'none';
      const tooEarly = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection?cid=tab-nonce', {
            headers: { cookie },
          }),
          dummyServer
        )
      );
      expect(tooEarly.status).toBe(404);
      expect(await tooEarly.json()).toEqual({
        code: 'NO_CONNECTION',
        hint: 'open Gateway WS with ?cid=<tab-nonce> then GET /api/mesh/connection?cid=',
        retryAfterMs: 500,
      });
      mode = 'many';

      const conflict = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/rtc/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({
              rtcSession: 's1',
              fp_browser: { algorithm: 'sha-256', value: 'AA' },
            }),
          }),
          dummyServer
        )
      );
      expect(conflict.status).toBe(409);

      const ok = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/rtc/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({
              rtcSession: 's1',
              connectionId: 'tab-a',
              fp_browser: { algorithm: 'sha-256', value: 'AA' },
            }),
          }),
          dummyServer
        )
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { fp_node: { value: string } };
      expect(body.fp_node.value).toBe('tab-a');
      expect(lookups.some((row) => row.connectionId === 'tab-a')).toBe(true);
      runtime.stop();
    } finally {
      mesh.close();
    }
  });

  test('/mesh/ws requires session and broadcasts NODE_EVENT', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      let rejectData: unknown;
      const denyServer = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          rejectData = opts?.data;
          return true;
        },
      };
      const denied = await mesh.runtime.handleRequest(
        new Request('http://localhost/mesh/ws'),
        denyServer
      );
      expect(denied).toBeUndefined();
      expect(rejectData).toEqual({ kind: MESH_REJECT_4401_KIND });
      let closed: number | undefined;
      const rejectWs = {
        data: { kind: MESH_REJECT_4401_KIND },
        send() {},
        close(code?: number) {
          closed = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(rejectWs);
      expect(closed).toBe(WS_CLOSE_LOGIN_REQUIRED);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let data: { kind?: string; sid?: string; uid?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const up = await mesh.runtime.handleRequest(
        new Request('http://localhost/mesh/ws', { headers: { cookie: `vibeterm_s_self=${sid}` } }),
        server
      );
      expect(up).toBeUndefined();
      expect(data?.kind).toBe(MESH_WS_KIND);
      expect(data?.sid).toBe(sid);
      expect(data?.uid).toBe(mesh.boot.userId);

      const frames: Uint8Array[] = [];
      let loggedOut: number | undefined;
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        send(d: Uint8Array) {
          frames.push(d);
          return d.byteLength;
        },
        close(code?: number) {
          loggedOut = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      peers.emit({
        nodeId: PEER_ID,
        status: 'online',
        reach: 'wan',
        transport: 'ws-secure',
        rttMs: 80,
      });
      expect(frames.length).toBe(1);
      const frame = frames[0];
      if (!frame) throw new Error('missing NODE_EVENT frame');
      const env = wsBorsh.decodeEnvelope(frame);
      expect(env.kind).toBe(wsBorsh.KIND_NODE_EVENT);
      const decoded = wsBorsh.decodeNodeEvent(env.payload);
      expect(decoded.reach).toBe('wan');
      expect(decoded.viaRelay).toBeNull();
      expect(decoded.relayPresence).toBeNull();

      peers.emit({
        nodeId: PEER_ID,
        status: 'online',
        reach: 'relay',
        transport: 'relay',
        rttMs: 40,
        viaRelay: 'https://ty.example',
        relayPresence: ['https://sh.example', 'https://ty.example'],
      });
      const relayFrame = frames[1];
      if (!relayFrame) throw new Error('missing relay NODE_EVENT frame');
      const relayDecoded = wsBorsh.decodeNodeEvent(wsBorsh.decodeEnvelope(relayFrame).payload);
      expect(relayDecoded.viaRelay).toBe('https://ty.example');
      expect(relayDecoded.relayPresence).toEqual(['https://sh.example', 'https://ty.example']);

      const logout = await call(mesh.runtime, 'http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(logout.status).toBe(200);
      expect(loggedOut).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('/mesh/ws broadcast skips a client over 1MiB buffered and closes on send 0', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const frames: Uint8Array[] = [];
      const closed: Array<{ code?: number; reason?: string }> = [];
      let buffered = 0;
      let sendResult: number | undefined = 8;
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        getBufferedAmount() {
          return buffered;
        },
        send(d: Uint8Array) {
          frames.push(d);
          return sendResult;
        },
        close(code?: number, reason?: string) {
          closed.push({ code, reason });
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);

      buffered = MESH_WS_BACKPRESSURE_LIMIT_BYTES + 1;
      peers.emit({ nodeId: PEER_ID, status: 'online', reach: 'wan' });
      expect(frames).toHaveLength(0);
      expect(warns.filter((row) => row.includes('buffered')).length).toBe(1);
      peers.emit({ nodeId: PEER_ID, status: 'offline', reach: 'wan' });
      expect(frames).toHaveLength(0);
      expect(warns.filter((row) => row.includes('buffered')).length).toBe(1);

      buffered = 0;
      peers.emit({ nodeId: PEER_ID, status: 'online', reach: 'lan' });
      expect(frames).toHaveLength(1);

      sendResult = 0;
      peers.emit({ nodeId: PEER_ID, status: 'offline', reach: 'lan' });
      expect(closed.some((row) => row.code === 1011 && row.reason === 'mesh-ws-closed')).toBe(true);
    } finally {
      console.warn = originalWarn;
      mesh.close();
    }
  });

  test('/mesh/ws RTC_SIGNAL from browsers is forced from=browser and node frames are ignored', async () => {
    const sent: Array<{ from: string; owner?: { uid: string; sid: string } }> = [];
    const mesh = await bootMesh({
      rtc: {
        signals: {
          send(signal, owner) {
            sent.push({ from: signal.from, owner });
          },
          subscribe() {
            return () => {};
          },
        },
      },
    });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        send() {},
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const nodeFrame = encodeRtcSignal(wsBorsh.RTC_SIGNAL_FROM_NODE);
      mesh.runtime.handleWebSocket.message(ws, nodeFrame);
      expect(sent).toEqual([]);
      const browserFrame = encodeRtcSignal(wsBorsh.RTC_SIGNAL_FROM_BROWSER);
      mesh.runtime.handleWebSocket.message(ws, browserFrame);
      expect(sent).toEqual([{ from: 'browser', owner: { uid: mesh.boot.userId, sid } }]);
    } finally {
      mesh.close();
    }
  });
});

const originalFetch = globalThis.fetch;
const originalReleaseCacheDir = process.env.VIBETERM_RELEASE_CACHE_DIR;
const UPGRADE_PEER = 'ee'.repeat(16);
const dummyLink = {} as LinkSession;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRemoteUpgradeJobsForTests();
  resetReleaseDownloadForTests();
  resetLatestReleaseCache();
  resetNodeOperationsForTests();
  if (originalReleaseCacheDir === undefined) delete process.env.VIBETERM_RELEASE_CACHE_DIR;
  else process.env.VIBETERM_RELEASE_CACHE_DIR = originalReleaseCacheDir;
});

class RecordingStreams extends FakeStreams {
  readonly opens: Array<{
    method: string;
    path: string;
    auth: string | null;
    body: string | null;
    query: string;
  }> = [];
  responses: Response[] = [];
  openErrors: Array<Error | null> = [];

  async openHttpStream(
    _link: LinkSession,
    open: {
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      origin: string;
      auth: string | null;
    },
    body: ReadableStream<Uint8Array> | null,
    _signal: AbortSignal
  ): Promise<Response> {
    let text: string | null = null;
    if (body) {
      text = await new Response(body).text();
    }
    this.opens.push({
      method: open.method,
      path: open.path,
      auth: open.auth,
      body: text,
      query: open.query,
    });
    const err = this.openErrors.shift();
    if (err) throw err;
    const queued = this.responses.shift();
    if (queued) return queued;
    return this.nextResponse;
  }
}

function mockGithubLatest(
  version: string,
  opts?: {
    tarball?: boolean;
    changelog?: string | null;
    publishedAt?: string | null;
    status?: number;
  }
): void {
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    if (opts?.status && opts.status !== 200) {
      return new Response('unavailable', { status: opts.status });
    }
    return new Response(
      JSON.stringify({
        tag_name: `v${version}`,
        published_at: opts?.publishedAt ?? '2026-08-30T00:00:00.000Z',
        body: opts?.changelog === undefined ? 'notes' : opts.changelog,
        assets:
          opts?.tarball === false
            ? []
            : [{ name: releaseTarballName(version) }, { name: legacyReleaseTarballName(version) }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
}

function enrollPeer(
  mesh: Awaited<ReturnType<typeof bootMesh>>,
  nodeId: string,
  revokedLogSeq?: number
): void {
  mesh.userStore.upsertCert({
    nodeId,
    userId: mesh.boot.userId,
    admitRecordSeq: 2,
    certificateBytes: encodeCertificate({
      domain: DOMAIN_CERTIFICATE,
      uid: mesh.boot.userId,
      node_id: hexToBytes(nodeId),
      ed_pk: new Uint8Array(32).fill(4),
      x25519_pk: new Uint8Array(32).fill(5),
      enroll_pk: new Uint8Array(32).fill(6),
      issued_at: 1n,
    }),
    certSig: new Uint8Array(64),
    authorizationBytes: new Uint8Array(8),
    authorizationSig: new Uint8Array(64),
    ...(revokedLogSeq != null ? { revokedLogSeq } : {}),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mesh upgrade routes', () => {
  test('GET /api/mesh/upgrade/latest requires a local session', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/api/mesh/upgrade/latest');
      expect(res.status).toBe(401);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/upgrade/latest returns latestVersion without hasUpdate', async () => {
    mockGithubLatest('9.9.9', { changelog: '## 9.9.9', publishedAt: '2026-08-30T00:00:00.000Z' });
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, 'http://localhost/api/mesh/upgrade/latest', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        latestVersion: '9.9.9',
        changelog: '## 9.9.9',
        publishedAt: '2026-08-30T00:00:00.000Z',
      });
      expect(body.hasUpdate).toBeUndefined();
      expect(body.currentVersion).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/upgrade/latest maps GitHub failure to RELEASE_UNAVAILABLE', async () => {
    mockGithubLatest('9.9.9', { status: 502 });
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, 'http://localhost/api/mesh/upgrade/latest', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ code: 'RELEASE_UNAVAILABLE' });
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/upgrade/latest maps missing tarball to RELEASE_UNAVAILABLE', async () => {
    mockGithubLatest('9.9.9', { tarball: false });
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, 'http://localhost/api/mesh/upgrade/latest', {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ code: 'RELEASE_UNAVAILABLE' });
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade forwards POST /api/system/upgrade with the resolved version', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    peers.transport.set(UPGRADE_PEER, 'dc');
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({
        baseVersion: '1.0.0',
        version: '1.0.0',
        canSelfUpdate: true,
      }),
      jsonResponse({
        state: 'downloading',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-08-30T00:00:00.000Z',
      })
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: 'downloading',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-08-30T00:00:00.000Z',
      });
      expect(streams.opens).toHaveLength(2);
      expect(streams.opens[0]).toMatchObject({
        method: 'GET',
        path: '/api/system/info',
        auth: 'remote-sid',
      });
      expect(streams.opens[1]).toMatchObject({
        method: 'POST',
        path: '/api/system/upgrade',
        auth: 'remote-sid',
        body: JSON.stringify({ version: '9.9.9' }),
      });
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade without a target session → NODE_LOGIN_REQUIRED and does not open a stream', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}` },
        }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'NODE_LOGIN_REQUIRED', nodeId: UPGRADE_PEER });
      expect(streams.opens).toEqual([]);
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade when the peer is unreachable → NODE_UNREACHABLE', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    const streams = new RecordingStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'NODE_UNREACHABLE', nodeId: UPGRADE_PEER });
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade maps target 409 to UPGRADE_IN_PROGRESS', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({ baseVersion: '1.0.0', canSelfUpdate: true }),
      jsonResponse(
        {
          state: 'executing',
          targetVersion: '9.9.9',
          error: 'busy',
          startedAt: '2026-08-30T00:00:00.000Z',
        },
        409
      )
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; nodeId: string; state: string };
      expect(body.code).toBe('UPGRADE_IN_PROGRESS');
      expect(body.nodeId).toBe(UPGRADE_PEER);
      expect(body.state).toBe('executing');
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade maps target 404 to UPGRADE_UNSUPPORTED', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(new Response('not found', { status: 404 }));
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'UPGRADE_UNSUPPORTED', nodeId: UPGRADE_PEER });
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade maps target 403 to UPGRADE_NOT_ALLOWED', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({ baseVersion: '1.0.0', canSelfUpdate: true }),
      jsonResponse({ error: 'forbidden' }, 403)
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'UPGRADE_NOT_ALLOWED', nodeId: UPGRADE_PEER });
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade when target is already at latest → UPGRADE_ALREADY_LATEST and no POST', async () => {
    mockGithubLatest('1.2.3');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(jsonResponse({ baseVersion: '1.2.3', canSelfUpdate: true }));
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: 'UPGRADE_ALREADY_LATEST',
        nodeId: UPGRADE_PEER,
        version: '1.2.3',
      });
      expect(streams.opens.map((o) => o.method)).toEqual(['GET']);
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade does not retry the POST after a stream error', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(jsonResponse({ baseVersion: '1.0.0', canSelfUpdate: true }));
    streams.openErrors.push(null, new Error('link died after POST open'));
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'NODE_UNREACHABLE', nodeId: UPGRADE_PEER });
      expect(streams.opens.map((o) => o.method)).toEqual(['GET', 'POST']);
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade works over relay transport', async () => {
    mockGithubLatest('9.9.9');
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    peers.transport.set(UPGRADE_PEER, 'relay');
    peers.reach.set(UPGRADE_PEER, 'relay');
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({ baseVersion: '1.0.0', canSelfUpdate: true }),
      jsonResponse({
        state: 'downloading',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-08-30T00:00:00.000Z',
      })
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(200);
      expect(streams.opens[1]?.path).toBe('/api/system/upgrade');
    } finally {
      mesh.close();
    }
  });

  test('POST upgrade of a revoked node is not found', async () => {
    mockGithubLatest('9.9.9');
    const mesh = await bootMesh();
    try {
      enrollPeer(mesh, REVOKED_ID, 9);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${REVOKED_ID}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${REVOKED_ID}=remote-sid` },
        }
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'NOT_FOUND', nodeId: REVOKED_ID });
    } finally {
      mesh.close();
    }
  });

  test('GET remote upgrade status forwards GET /api/system/upgrade', async () => {
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({
        state: 'idle',
        targetVersion: null,
        error: null,
        startedAt: null,
      })
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: 'idle',
        targetVersion: null,
        error: null,
        startedAt: null,
      });
      expect(streams.opens).toEqual([
        { method: 'GET', path: '/api/system/upgrade', auth: 'remote-sid', body: null, query: '' },
      ]);
    } finally {
      mesh.close();
    }
  });

  test('GET local upgrade status returns the local controller status', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${NODE_ID}/upgrade`, {
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: 'idle',
        targetVersion: null,
        error: null,
        startedAt: null,
      });
    } finally {
      mesh.close();
    }
  });

  test('GET remote upgrade status without a target session → NODE_LOGIN_REQUIRED', async () => {
    const mesh = await bootMesh();
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          headers: { cookie: `vibeterm_s_self=${sid}` },
        }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'NODE_LOGIN_REQUIRED', nodeId: UPGRADE_PEER });
    } finally {
      mesh.close();
    }
  });

  test('POST local upgrade when canSelfUpdate is false → UPGRADE_NOT_ALLOWED', async () => {
    mockGithubLatest('99.0.0');
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${NODE_ID}/upgrade`, {
        method: 'POST',
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'UPGRADE_NOT_ALLOWED', nodeId: NODE_ID });
    } finally {
      mesh.close();
    }
  });

  test('POST local upgrade when canSelfUpdate is false and GitHub is down → UPGRADE_NOT_ALLOWED', async () => {
    mockGithubLatest('9.9.9', { status: 502 });
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${NODE_ID}/upgrade`, {
        method: 'POST',
        headers: { cookie: `vibeterm_s_self=${sid}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'UPGRADE_NOT_ALLOWED', nodeId: NODE_ID });
    } finally {
      mesh.close();
    }
  });

  test('POST remote upgrade with staged-package capability returns immediately then PUTs and POSTs staged', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.VIBETERM_RELEASE_CACHE_DIR = mkdtempSync(
      join(tmpdir(), 'vibeterm-mesh-rel-cache-')
    );
    const tarball = new Uint8Array([1, 2, 3, 4, 5]);
    const hex = createHash('sha256').update(tarball).digest('hex');
    mockGithubLatest('9.9.9');
    const latestFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com')) return latestFetch(input, init);
      if (url.includes('SHA256SUMS')) {
        const body =
          `${hex}  ${releaseTarballName('9.9.9')}\n` +
          `${hex}  ${legacyReleaseTarballName('9.9.9')}\n`;
        return new Response(url.endsWith('.sig') ? `${signSums(body)}\n` : body, { status: 200 });
      }
      return new Response(Buffer.from(tarball), { status: 200 });
    }) as typeof fetch;

    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({
        baseVersion: '1.0.0',
        canSelfUpdate: true,
        upgradeCapabilities: ['staged-package'],
      }),
      jsonResponse({ version: '9.9.9', sha256: hex, bytes: tarball.byteLength }),
      jsonResponse({
        state: 'downloading',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-09-01T00:00:00.000Z',
      })
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { state: string; targetVersion: string };
      expect(body.state).toBe('downloading');
      expect(body.targetVersion).toBe('9.9.9');
      expect(streams.opens.map((o) => `${o.method} ${o.path}`)).toEqual(['GET /api/system/info']);

      await waitForRemoteUpgradeJob(UPGRADE_PEER);
      expect(streams.opens.map((o) => `${o.method} ${o.path}`)).toEqual([
        'GET /api/system/info',
        'POST /api/system/upgrade/package/manifest',
        'PUT /api/system/upgrade/package',
        'POST /api/system/upgrade',
      ]);
      // 清单必须先于字节到达，且带的就是入口验过签的那份 SHA256SUMS。
      const manifest = JSON.parse(streams.opens[1]?.body ?? '{}') as {
        version: string;
        sums: string;
        sig: string;
      };
      expect(manifest.version).toBe('9.9.9');
      expect(manifest.sums).toContain(hex);
      expect(manifest.sig.startsWith('tmex-release-sig v1 ')).toBe(true);
      expect(streams.opens[2]?.query).toContain('version=9.9.9');
      expect(streams.opens[2]?.query).toContain(`sha256=${hex}`);
      expect(streams.opens[3]?.body).toBe(
        JSON.stringify({ version: '9.9.9', source: 'staged', sha256: hex })
      );
    } finally {
      mesh.close();
    }
  });

  test('DELETE remote upgrade without a target session → NODE_LOGIN_REQUIRED', async () => {
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'DELETE',
          headers: { cookie: `vibeterm_s_self=${sid}` },
        }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'NODE_LOGIN_REQUIRED', nodeId: UPGRADE_PEER });
      expect(streams.opens).toEqual([]);
    } finally {
      mesh.close();
    }
  });

  test('DELETE remote upgrade on an unknown node → NOT_FOUND', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'DELETE',
          headers: { cookie: `vibeterm_s_self=${sid}` },
        }
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'NOT_FOUND', nodeId: UPGRADE_PEER });
    } finally {
      mesh.close();
    }
  });

  test('DELETE remote upgrade job in download is 200 overlay and GET keeps UPGRADE_CANCELLED', async () => {
    mockGithubLatest('9.9.9');
    const latestFetch = globalThis.fetch;
    let releaseTarball!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTarball = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com')) return latestFetch(input, init);
      await gate;
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    const info = jsonResponse({
      baseVersion: '1.0.0',
      canSelfUpdate: true,
      upgradeCapabilities: ['staged-package'],
    });
    streams.responses.push(info, info.clone());
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid`;
      const started = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        { method: 'POST', headers: { cookie } }
      );
      expect(started.status).toBe(200);
      const cancelled = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        { method: 'DELETE', headers: { cookie } }
      );
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({
        state: 'idle',
        targetVersion: null,
        error: 'UPGRADE_CANCELLED',
      });
      const status = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        { headers: { cookie } }
      );
      expect(await status.json()).toMatchObject({
        state: 'idle',
        error: 'UPGRADE_CANCELLED',
      });
      expect(streams.opens.map((o) => `${o.method} ${o.path}`)).toEqual(['GET /api/system/info']);
      const again = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        { method: 'POST', headers: { cookie } }
      );
      expect(again.status).toBe(200);
    } finally {
      releaseTarball();
      mesh.close();
    }
  });

  test('DELETE remote upgrade when the target is old maps 404 to 501 UPGRADE_CANCEL_UNSUPPORTED', async () => {
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(new Response('gone', { status: 404 }));
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        {
          method: 'DELETE',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({
        code: 'UPGRADE_CANCEL_UNSUPPORTED',
        nodeId: UPGRADE_PEER,
      });
      expect(streams.opens[0]).toMatchObject({
        method: 'DELETE',
        path: '/api/system/upgrade',
      });
    } finally {
      mesh.close();
    }
  });

  test('DELETE after a handed-off job is forwarded to the target', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.VIBETERM_RELEASE_CACHE_DIR = mkdtempSync(
      join(tmpdir(), 'vibeterm-mesh-cancel-cache-')
    );
    const tarball = new Uint8Array([1, 2, 3, 4, 5]);
    const hex = createHash('sha256').update(tarball).digest('hex');
    mockGithubLatest('9.9.9');
    const latestFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com')) return latestFetch(input, init);
      if (url.includes('SHA256SUMS')) {
        const body =
          `${hex}  ${releaseTarballName('9.9.9')}\n` +
          `${hex}  ${legacyReleaseTarballName('9.9.9')}\n`;
        return new Response(url.endsWith('.sig') ? `${signSums(body)}\n` : body, { status: 200 });
      }
      return new Response(Buffer.from(tarball), { status: 200 });
    }) as typeof fetch;
    const peers = new FakePeers();
    peers.links.set(UPGRADE_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({
        baseVersion: '1.0.0',
        canSelfUpdate: true,
        upgradeCapabilities: ['staged-package'],
      }),
      jsonResponse({ version: '9.9.9', sha256: hex, keyId: 'tk' }),
      jsonResponse({ version: '9.9.9', sha256: hex, bytes: tarball.byteLength }),
      jsonResponse({
        state: 'downloading',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-09-01T00:00:00.000Z',
      }),
      jsonResponse(
        {
          code: 'UPGRADE_NOT_CANCELLABLE',
          state: 'executing',
          targetVersion: '9.9.9',
          error: null,
          startedAt: '2026-09-01T00:00:00.000Z',
        },
        409
      )
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UPGRADE_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = `vibeterm_s_self=${sid}; vibeterm_s_${UPGRADE_PEER}=remote-sid`;
      const started = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        { method: 'POST', headers: { cookie } }
      );
      expect(started.status).toBe(200);
      await waitForRemoteUpgradeJob(UPGRADE_PEER);
      const cancelled = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UPGRADE_PEER}/upgrade`,
        { method: 'DELETE', headers: { cookie } }
      );
      expect(cancelled.status).toBe(409);
      expect(await cancelled.json()).toMatchObject({
        code: 'UPGRADE_NOT_CANCELLABLE',
        nodeId: UPGRADE_PEER,
      });
      expect(streams.opens.map((o) => `${o.method} ${o.path}`)).toEqual([
        'GET /api/system/info',
        'POST /api/system/upgrade/package/manifest',
        'PUT /api/system/upgrade/package',
        'POST /api/system/upgrade',
        'DELETE /api/system/upgrade',
      ]);
    } finally {
      mesh.close();
    }
  });
});

describe('mesh uninstall routes', () => {
  const UNINSTALL_PEER = 'ff'.repeat(16);

  beforeAll(() => {
    runMigrations();
  });

  test('POST uninstall without a user session is UNAUTHORIZED', async () => {
    const mesh = await bootMesh({ roles: { node: false, relay: false } });
    try {
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`,
        { method: 'POST', body: JSON.stringify({ mode: 'full' }) }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    } finally {
      mesh.close();
    }
  });

  test('POST uninstall of self is UNINSTALL_SELF_BLOCKED', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      for (const id of [NODE_ID, 'self']) {
        const res = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${id}/uninstall`, {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}` },
          body: JSON.stringify({ mode: 'full' }),
        });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ code: 'UNINSTALL_SELF_BLOCKED', nodeId: NODE_ID });
      }
    } finally {
      mesh.close();
    }
  });

  test('POST remote uninstall without a target session → NODE_LOGIN_REQUIRED', async () => {
    const peers = new FakePeers();
    peers.links.set(UNINSTALL_PEER, dummyLink);
    const streams = new RecordingStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UNINSTALL_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}` },
        }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'NODE_LOGIN_REQUIRED', nodeId: UNINSTALL_PEER });
      expect(streams.opens).toEqual([]);
    } finally {
      mesh.close();
    }
  });

  test('POST remote uninstall when the peer is unreachable → NODE_UNREACHABLE', async () => {
    const peers = new FakePeers();
    const streams = new RecordingStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UNINSTALL_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UNINSTALL_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        code: 'NODE_UNREACHABLE',
        nodeId: UNINSTALL_PEER,
      });
    } finally {
      mesh.close();
    }
  });

  test('POST remote uninstall maps target 404/405 to 501 UNINSTALL_UNSUPPORTED', async () => {
    const peers = new FakePeers();
    peers.links.set(UNINSTALL_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(new Response('not found', { status: 404 }));
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UNINSTALL_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UNINSTALL_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({
        code: 'UNINSTALL_UNSUPPORTED',
        nodeId: UNINSTALL_PEER,
      });
    } finally {
      mesh.close();
    }
  });

  test('POST remote uninstall propagates 409 UNINSTALL_NOT_ALLOWED', async () => {
    const peers = new FakePeers();
    peers.links.set(UNINSTALL_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({ code: 'UNINSTALL_NOT_ALLOWED', reason: 'not_cli_install' }, 409)
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UNINSTALL_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`,
        {
          method: 'POST',
          headers: { cookie: `vibeterm_s_self=${sid}; vibeterm_s_${UNINSTALL_PEER}=remote-sid` },
        }
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: 'UNINSTALL_NOT_ALLOWED',
        reason: 'not_cli_install',
        nodeId: UNINSTALL_PEER,
      });
    } finally {
      mesh.close();
    }
  });

  test('POST remote uninstall 202 records uninstalling and GET nodes shows operation', async () => {
    const peers = new FakePeers();
    peers.links.set(UNINSTALL_PEER, dummyLink);
    peers.reach.set(UNINSTALL_PEER, 'lan');
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({ state: 'scheduled', startedAt: '2026-09-02T00:00:00.000Z', error: null }, 202)
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UNINSTALL_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = `vibeterm_s_self=${sid}; vibeterm_s_${UNINSTALL_PEER}=remote-sid`;
      const res = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`,
        {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({ mode: 'full' }),
        }
      );
      expect(res.status).toBe(202);
      expect(streams.opens).toHaveLength(1);
      expect(streams.opens[0]).toMatchObject({
        method: 'POST',
        path: '/api/system/uninstall',
        auth: 'remote-sid',
      });
      const op = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/operation`,
        { headers: { cookie } }
      );
      expect(op.status).toBe(200);
      const record = (await op.json()) as { kind: string; phase: string; error: string | null };
      expect(record.kind).toBe('uninstall');
      expect(record.phase).toBe('uninstalling');
      expect(record.error).toBeNull();
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie },
      });
      const body = (await list.json()) as {
        nodes: Array<{ id: string; operation: { phase: string } | null }>;
      };
      const peer = body.nodes.find((n) => n.id === UNINSTALL_PEER);
      expect(peer?.operation?.phase).toBe('uninstalling');
      const self = body.nodes.find((n) => n.id === NODE_ID);
      expect(self?.operation).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('DELETE /api/mesh/nodes/:id/operation clears the record', async () => {
    const peers = new FakePeers();
    peers.links.set(UNINSTALL_PEER, dummyLink);
    const streams = new RecordingStreams();
    streams.responses.push(
      jsonResponse({ state: 'scheduled', startedAt: '2026-09-02T00:00:00.000Z', error: null }, 202)
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      enrollPeer(mesh, UNINSTALL_PEER);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = `vibeterm_s_self=${sid}; vibeterm_s_${UNINSTALL_PEER}=remote-sid`;
      await call(mesh.runtime, `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/uninstall`, {
        method: 'POST',
        headers: { cookie },
      });
      const del = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/operation`,
        { method: 'DELETE', headers: { cookie } }
      );
      expect(del.status).toBe(200);
      const missing = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${UNINSTALL_PEER}/operation`,
        { headers: { cookie } }
      );
      expect(missing.status).toBe(404);
    } finally {
      mesh.close();
    }
  });
});

function encodeRtcSignal(from: number): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
    rtcSession: 'sess-1',
    from,
    to: 'node-a',
    sdp: 'offer',
    candidate: null,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, payload, 1);
}
