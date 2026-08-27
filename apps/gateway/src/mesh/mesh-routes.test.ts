import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  DOMAIN_CERTIFICATE,
  encodeBase64url,
  encodeCertificate,
  hexToBytes,
} from '@tmex/shared/auth';
import {
  FakePeers,
  NODE_ID,
  NODE_PK,
  bootMesh,
  call,
  challengeAndLogin,
  dummyServer,
} from './auth-routes.test';
import { MESH_WS_KIND, type MeshServerWebSocket } from './mesh-deps';

const PEER_ID = 'cc'.repeat(16);
const REVOKED_ID = 'dd'.repeat(16);

describe('mesh-routes', () => {
  test('GET /api/mesh/nodes merges certs, peer_cache, reach, loggedIn; includes self; drops revoked', async () => {
    const peers = new FakePeers();
    peers.reach.set(PEER_ID, 'lan');
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
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { sid } = (await res.json()) as { sid: string };
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `tmex_s_self=${sid}; tmex_s_${PEER_ID}=xyz` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          name: string;
          publicKey: string;
          online: boolean;
          reach: string | null;
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
      expect(peer?.loggedIn).toBe(true);
      expect(peer?.direct_capable).toBe(true);
      expect(peer?.version).toBe('1.2.3');
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/rtc-config and POST /api/rtc/authorize', async () => {
    const mesh = await bootMesh({
      rtc: {
        config: { getRtcConfig: () => ({ stun: ['stun:ex'], turn: null }) },
      },
    });
    try {
      const cfg = await call(mesh.runtime, 'http://localhost/api/mesh/rtc-config');
      expect(await cfg.json()).toEqual({ stun: ['stun:ex'], turn: null });
    } finally {
      mesh.close();
    }

    const noRtc = await bootMesh();
    try {
      const { res } = await challengeAndLogin(noRtc.runtime, noRtc.boot);
      const { sid } = (await res.json()) as { sid: string };
      const authz = await call(noRtc.runtime, 'http://localhost/api/rtc/authorize', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
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
        roles: { hub: false, node: true },
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
            getFingerprint: () => ({ algorithm: 'sha-256', value: 'BB' }),
          },
        },
        primaryUserId: withFp.boot.userId,
      });
      const { res } = await challengeAndLogin(runtime, withFp.boot);
      const { sid } = (await res.json()) as { sid: string };
      const ok = await runtime.handleRequest(
        new Request('http://localhost/api/rtc/authorize', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `tmex_s_self=${sid}`,
          },
          body: JSON.stringify({
            rtcSession: 's1',
            fp_browser: { algorithm: 'sha-256', value: 'AA' },
          }),
        }),
        dummyServer
      );
      expect(ok?.status).toBe(200);
      const body = (await ok?.json()) as { nonce: string; fp_node: { value: string } };
      expect(body.fp_node.value).toBe('BB');
      expect(body.nonce.length).toBeGreaterThan(10);
      runtime.stop();
    } finally {
      withFp.close();
    }
  });

  test('/mesh/ws requires session and broadcasts NODE_EVENT', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      const denied = await mesh.runtime.handleRequest(
        new Request('http://localhost/mesh/ws'),
        dummyServer
      );
      expect(denied?.status).toBe(401);

      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { sid } = (await res.json()) as { sid: string };
      let data: unknown;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data;
          return true;
        },
      };
      const up = await mesh.runtime.handleRequest(
        new Request('http://localhost/mesh/ws', { headers: { cookie: `tmex_s_self=${sid}` } }),
        server
      );
      expect(up).toBeUndefined();
      expect(data).toEqual({ kind: MESH_WS_KIND });

      const frames: Uint8Array[] = [];
      const ws = {
        data: { kind: MESH_WS_KIND },
        send(d: Uint8Array) {
          frames.push(d);
          return d.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      peers.emit({ nodeId: PEER_ID, status: 'online' });
      expect(frames.length).toBe(1);
      const frame = frames[0];
      if (!frame) throw new Error('missing NODE_EVENT frame');
      const env = wsBorsh.decodeEnvelope(frame);
      expect(env.kind).toBe(wsBorsh.KIND_NODE_EVENT);
    } finally {
      mesh.close();
    }
  });
});
