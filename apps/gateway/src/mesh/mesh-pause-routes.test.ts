import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { DOMAIN_CERTIFICATE, encodeCertificate, hexToBytes } from '@vibeterm/shared/auth';
import { FakePeers, NODE_ID, bootMesh, call, challengeAndLogin } from './auth-routes.test';
import { MESH_WS_KIND, type MeshServerWebSocket } from './mesh-deps';
import { resetNodePauseForTests, setNodePaused } from './node-pause';

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

describe('mesh pause/resume routes', () => {
  afterEach(() => {
    resetNodePauseForTests();
  });

  test('pause is 400 for self, 404 for unknown, idempotent, and projects paused', async () => {
    const mesh = await bootMesh({ peers: new FakePeers() });
    try {
      enrollPeer(mesh, PEER_ID, 'studio');
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = { headers: { cookie: `vibeterm_s_self=${sid}` } };
      const selfPause = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${NODE_ID}/pause`,
        { method: 'POST', ...cookie }
      );
      expect(selfPause.status).toBe(400);
      expect(await selfPause.json()).toMatchObject({ code: 'CANNOT_PAUSE_SELF' });

      const missing = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${'ff'.repeat(16)}/pause`,
        { method: 'POST', ...cookie }
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 'NODE_NOT_FOUND' });

      const first = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${PEER_ID}/pause`, {
        method: 'POST',
        ...cookie,
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        ok: boolean;
        node: { id: string; paused?: boolean };
      };
      expect(firstBody.ok).toBe(true);
      expect(firstBody.node.id).toBe(PEER_ID);
      expect(firstBody.node.paused).toBe(true);

      const again = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${PEER_ID}/pause`, {
        method: 'POST',
        ...cookie,
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { node: { paused?: boolean } }).node.paused).toBe(true);

      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', cookie);
      const body = (await list.json()) as { nodes: Array<{ id: string; paused?: boolean }> };
      expect(body.nodes.find((n) => n.id === PEER_ID)?.paused).toBe(true);
      expect(body.nodes.find((n) => n.id === NODE_ID)?.paused).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('pause is 400 for hub-role nodes; resume of an already-paused hub is 200', async () => {
    const mesh = await bootMesh({ peers: new FakePeers() });
    try {
      enrollPeer(mesh, PEER_ID, 'studio');
      mesh.hubStore.replaceAll(
        [
          {
            hubNodeId: PEER_ID,
            publicUrl: 'https://hub.example',
            name: null,
            mode: 'active',
            priority: 10,
            writerEpoch: 1,
            caFingerprint: null,
            online: true,
            lastSeenAt: null,
          },
        ],
        1
      );
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = { headers: { cookie: `vibeterm_s_self=${sid}` } };
      const res = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${PEER_ID}/pause`, {
        method: 'POST',
        ...cookie,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'CANNOT_PAUSE_HUB' });

      setNodePaused(PEER_ID, true);
      const resumed = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${PEER_ID}/resume`,
        { method: 'POST', ...cookie }
      );
      expect(resumed.status).toBe(200);
      expect(
        ((await resumed.json()) as { node: { paused?: boolean } }).node.paused
      ).toBeUndefined();

      const pauseAgain = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${PEER_ID}/pause`,
        { method: 'POST', ...cookie }
      );
      expect(pauseAgain.status).toBe(400);
      expect(await pauseAgain.json()).toMatchObject({ code: 'CANNOT_PAUSE_HUB' });
    } finally {
      mesh.close();
    }
  });

  test('resume clears paused and is idempotent; pause broadcasts NODE_EVENT', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      enrollPeer(mesh, PEER_ID, 'studio');
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = { headers: { cookie: `vibeterm_s_self=${sid}` } };
      const frames: Uint8Array[] = [];
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId, via: 'self' },
        send(data: Uint8Array) {
          frames.push(data);
          return data.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);

      await call(mesh.runtime, `http://localhost/api/mesh/nodes/${PEER_ID}/pause`, {
        method: 'POST',
        ...cookie,
      });
      const pauseFrame = frames
        .map((bytes) => wsBorsh.decodeEnvelope(bytes))
        .find((env) => env.kind === wsBorsh.KIND_NODE_EVENT);
      expect(pauseFrame).toBeTruthy();
      expect(wsBorsh.decodeNodeEvent(pauseFrame!.payload).paused).toBe(true);

      const resumed = await call(
        mesh.runtime,
        `http://localhost/api/mesh/nodes/${PEER_ID}/resume`,
        {
          method: 'POST',
          ...cookie,
        }
      );
      expect(resumed.status).toBe(200);
      expect(
        ((await resumed.json()) as { node: { paused?: boolean } }).node.paused
      ).toBeUndefined();

      const again = await call(mesh.runtime, `http://localhost/api/mesh/nodes/${PEER_ID}/resume`, {
        method: 'POST',
        ...cookie,
      });
      expect(again.status).toBe(200);

      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', cookie);
      const body = (await list.json()) as { nodes: Array<{ id: string; paused?: boolean }> };
      expect(body.nodes.find((n) => n.id === PEER_ID)?.paused).toBeUndefined();
    } finally {
      mesh.close();
    }
  });
});
