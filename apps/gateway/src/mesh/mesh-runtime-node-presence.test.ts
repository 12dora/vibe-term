import { afterEach, describe, expect, test } from 'bun:test';
import {
  DOMAIN_CERTIFICATE,
  encodeBase64url,
  encodeCertificate,
  hexToBytes,
  randomBytes,
} from '@tmex/shared/auth';
import { WebSocketLink } from '@tmex/shared/link';
import { registerNodeOfflineListener } from '../agent/node-offline-bus';
import { UserStore } from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';
import { getMeshAgentBridge } from './mesh-agent-bridge';
import type { PeerReachKind } from './mesh-deps';
import { createMeshRuntime } from './mesh-runtime';
import { fakeSocketPair, seedUser, waitUntil } from './test-support';
import { encodeUplinkCtl } from './uplink-protocol';

function fakeGateway(db: AuthDb): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as WebSocketServer,
    handleRequest: () => undefined,
    dispatchHttp: async () => new Response('not-found', { status: 404 }),
    websocket: {
      backpressureLimit: 1024,
      closeOnBackpressureLimit: true,
      open() {},
      message() {},
      drain() {},
      close() {},
      closeSession() {},
    },
    onRestartRequested() {},
    stop: async () => {},
  };
}

describe('mesh node presence for agent sessions', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    registerNodeOfflineListener(null);
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  async function bootListedPeer(): Promise<{
    mesh: Awaited<ReturnType<typeof createMeshRuntime>>;
    hub: WebSocketLink;
    peerId: string;
  }> {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const peerId = 'cd'.repeat(16);
    userStore.upsertCert({
      nodeId: peerId,
      userId: 'user-1',
      admitRecordSeq: 1,
      certificateBytes: encodeCertificate({
        domain: DOMAIN_CERTIFICATE,
        uid: 'user-1',
        node_id: hexToBytes(peerId),
        ed_pk: new Uint8Array(32).fill(4),
        x25519_pk: new Uint8Array(32).fill(5),
        enroll_pk: new Uint8Array(32).fill(6),
        issued_at: 1n,
      }),
      certSig: randomBytes(64),
      authorizationBytes: randomBytes(8),
      authorizationSig: randomBytes(64),
      revokedLogSeq: null,
    });
    userStore.upsertPeer({
      nodeId: peerId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://127.0.0.1:9',
        peerPort: 0,
        stunServers: [],
      },
      wsFactory: () => clientWs,
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => mesh.uplink.state === 'online');
    return { mesh, hub, peerId };
  }

  test('hub online + idle link → lookupNode online (create allowed)', async () => {
    const { mesh, hub, peerId } = await bootListedPeer();
    expect(mesh.peers.listReach().get(peerId)).toBeNull();
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [
          {
            id: peerId,
            name: 'peer',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
        ],
      })
    );
    await waitUntil(() => mesh.lastNodeList !== null);
    expect(getMeshAgentBridge()?.lookupNode(peerId)).toBe('online');
  });

  test('hub offline + live direct link → no offline event', async () => {
    const { mesh, hub, peerId } = await bootListedPeer();
    const original = mesh.peers.listReach.bind(mesh.peers);
    mesh.peers.listReach = () => {
      const next = original();
      next.set(peerId, 'lan' as PeerReachKind);
      return next;
    };
    const events: Array<{ nodeId: string; status: string }> = [];
    const offline: string[] = [];
    mesh.onNodeEvent((event) => {
      events.push({ nodeId: event.nodeId, status: event.status });
    });
    registerNodeOfflineListener((nodeId) => {
      offline.push(nodeId);
    });
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        nodes: [
          {
            id: peerId,
            name: 'peer',
            online: false,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
        ],
      })
    );
    await waitUntil(() => events.some((e) => e.nodeId === peerId));
    expect(events.filter((e) => e.nodeId === peerId).map((e) => e.status)).toEqual(['online']);
    expect(offline).toEqual([]);
  });
});
