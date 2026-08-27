import { afterEach, describe, expect, test } from 'bun:test';
import { encodeAdmitNodePayload } from '@tmex/shared/auth';
import {
  KeyLogStore,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
  selfSignedNodeCertificate,
} from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';
import { createMeshRuntime } from './mesh-runtime';
import { fakeSocketPair, waitUntil } from './test-support';

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

describe('createMeshRuntime', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('node role starts PeerServer on an ephemeral port and UplinkClient against a fake WS factory', async () => {
    const { db, close } = createMigratedAuthDb();
    const [clientWs] = fakeSocketPair();
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
      peerHostname: '127.0.0.1',
    });
    fixtures.push({ close, stop: () => mesh.stop() });

    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    expect(mesh.peers.listenPort).toBeGreaterThan(0);
    expect(mesh.hub).toBeNull();
    expect(mesh.uplink.state === 'connecting' || mesh.uplink.state === 'online').toBe(true);
  });

  test('hub,node role uses in-memory uplink, attachLocalNode, auth handshake, and node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    const keyLogStore = new KeyLogStore(db);
    const nodeSessionStore = new NodeSessionStore(db);
    const keys = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
    const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
    const boot = await keys.bootstrapUser({ username: 'hub', password: 'pw' });
    const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
      uid: boot.userId,
      rootEpoch: boot.rootEpoch,
      now: Date.now(),
    });
    const applied = await keys.signAndApply(boot.userId, boot.rootKey, {
      type: 'admit-node',
      payload: encodeAdmitNodePayload(admit),
    });
    expect(applied.ok).toBe(true);
    expect(userStore.getCert(identity.nodeIdHex)).not.toBeNull();

    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: true, node: true },
        hubUrl: null,
        hubPublicUrl: 'http://127.0.0.1',
        peerPort: 0,
        stunServers: ['stun:example:3478'],
      },
      peerHostname: '127.0.0.1',
    });
    fixtures.push({ close, stop: () => mesh.stop() });

    const hub = mesh.hub;
    expect(hub).not.toBeNull();
    if (!hub) throw new Error('expected hub runtime');
    let attached = 0;
    const origAttach = hub.attachLocalNode.bind(hub);
    hub.attachLocalNode = (link) => {
      attached += 1;
      origAttach(link);
    };

    await mesh.start();
    expect(attached).toBeGreaterThanOrEqual(1);
    await waitUntil(() => mesh.uplink.state === 'online', 3_000);
    await waitUntil(() => mesh.lastNodeList !== null, 3_000);
    expect(mesh.lastNodeList?.nodes.some((n) => n.id === mesh.nodeId)).toBe(true);
  });

  test('stop closes peer links before uplink', async () => {
    const { db, close } = createMigratedAuthDb();
    const [clientWs] = fakeSocketPair();
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
      peerHostname: '127.0.0.1',
    });
    fixtures.push({ close });
    await mesh.start();

    const order: string[] = [];
    const origPeer = mesh.peers.stop.bind(mesh.peers);
    mesh.peers.stop = async () => {
      order.push('peer');
      await origPeer();
    };
    const origUplink = mesh.uplink.stop.bind(mesh.uplink);
    mesh.uplink.stop = async () => {
      order.push('uplink');
      await origUplink();
    };

    await mesh.stop();
    expect(order).toEqual(['peer', 'uplink']);
  });

  test('exposes gateway WS guard and inbound mesh handleRequest for peer via', async () => {
    const { db, close } = createMigratedAuthDb();
    const [clientWs] = fakeSocketPair();
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
      peerHostname: '127.0.0.1',
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    expect(typeof mesh.guardGatewayWebSocket).toBe('function');
    const { setMeshRequestContext } = await import('./mesh-deps');
    const req = new Request('http://localhost/api/auth/mode');
    setMeshRequestContext(req, { via: 'peer-node', clientIp: 'peer:peer-node' });
    const res = await mesh.handleRequest(req, { upgrade: () => false });
    if (!(res instanceof Response)) throw new Error('expected Response');
    expect(await res.json()).toMatchObject({ mode: 'mesh' });
  });
});
