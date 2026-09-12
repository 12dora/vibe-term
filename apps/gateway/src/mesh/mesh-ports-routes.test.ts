import { afterEach, describe, expect, test } from 'bun:test';
import { DOMAIN_CERTIFICATE, encodeCertificate, hexToBytes } from '@vibeterm/shared/auth';
import { FakePeers, NODE_ID, bootMesh, call, challengeAndLogin } from './auth-routes.test';
import { resetPortReachForTest } from './port-reach';

const PEER_ID = 'cc'.repeat(16);

function enrollPeer(
  mesh: Awaited<ReturnType<typeof bootMesh>>,
  nodeId: string,
  name: string
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
  });
  mesh.userStore.upsertPeer({
    nodeId,
    name,
    endpointsJson: '[]',
    inventoryJson: '{"version":"1.2.3"}',
    directCapable: true,
    lastSeenAt: 1,
    listVersion: 7,
  });
}

describe('mesh ports probe route', () => {
  afterEach(() => {
    resetPortReachForTest();
  });

  test('probe requires session, 404 for unknown, returns ports for self and peer', async () => {
    const mesh = await bootMesh({ peers: new FakePeers() });
    try {
      enrollPeer(mesh, PEER_ID, 'studio');
      const unauth = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${PEER_ID}/ports/probe`,
        {
          method: 'POST',
        }
      );
      expect(unauth.status).toBe(401);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = { headers: { cookie: `vibeterm_s_self=${sid}` } };
      const missing = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${'ff'.repeat(16)}/ports/probe`,
        { method: 'POST', ...cookie }
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 'NODE_NOT_FOUND' });

      const self = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${NODE_ID}/ports/probe`,
        {
          method: 'POST',
          ...cookie,
        }
      );
      expect(self.status).toBe(200);
      const selfBody = (await self.json()) as { ports: Array<{ purpose: string; status: string }> };
      expect(selfBody.ports.some((row) => row.purpose === 'peer-signaling')).toBe(true);
      expect(selfBody.ports.some((row) => row.purpose === 'rtc-ice')).toBe(true);

      const peer = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${PEER_ID}/ports/probe`,
        {
          method: 'POST',
          ...cookie,
        }
      );
      expect(peer.status).toBe(200);

      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', cookie);
      const body = (await list.json()) as {
        nodes: Array<{ id: string; ports?: Array<{ purpose: string }> }>;
      };
      expect(body.nodes.find((n) => n.id === NODE_ID)?.ports?.length).toBeGreaterThan(0);
      expect(body.nodes.find((n) => n.id === PEER_ID)?.ports?.length).toBeGreaterThan(0);
    } finally {
      mesh.close();
    }
  });
});
