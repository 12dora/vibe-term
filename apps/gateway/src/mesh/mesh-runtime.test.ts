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
import { GatewaySession } from '../ws/gateway-session';
import { createFakeCarrier } from '../ws/test-helpers';
import { SessionRegistry, createMeshRuntime } from './mesh-runtime';
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

  test('MeshRuntimeConfig.peerBindHost is threaded to PeerServer when peerHostname is omitted', async () => {
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
        peerBindHost: ['127.0.0.1'],
      },
      wsFactory: () => clientWs,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    const port = mesh.peers.listenPort;
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/peer`);
    expect(res.status).toBe(426);
    await expect(fetch(`http://[::1]:${port}/peer`)).rejects.toThrow();
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

describe('SessionRegistry', () => {
  test('keys connections independently so two tabs with the same sid do not clobber', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const b = new GatewaySession({ primary: createFakeCarrier() });
    expect(
      registry.register({
        connectionId: 'conn-a',
        sid: 'sid-1',
        uid: 'u1',
        via: 'self',
        session: a,
      }).ok
    ).toBe(true);
    expect(
      registry.register({
        connectionId: 'conn-b',
        sid: 'sid-1',
        uid: 'u1',
        via: 'self',
        session: b,
      }).ok
    ).toBe(true);
    expect(registry.get('sid-1')).toBeNull();
    expect(registry.getByConnectionId('conn-a')?.session).toBe(a);
    expect(registry.getByConnectionId('conn-b')?.session).toBe(b);
    expect(registry.lookup('sid-1', 'self')).toEqual({
      ok: false,
      code: 'MULTIPLE_CONNECTIONS',
    });
    expect(registry.lookup('sid-1', 'self', 'conn-a')).toEqual({
      ok: true,
      connectionId: 'conn-a',
    });
    registry.unregisterSession(a);
    expect(registry.getByConnectionId('conn-a')).toBeNull();
    expect(registry.get('sid-1')?.session).toBe(b);
  });

  test('generates a server connectionId and maps cid scoped to sid+via', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const first = registry.register({
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      cid: 'nonce-a',
      session: a,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');
    expect(first.entry.connectionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.entry.connectionId).not.toBe('nonce-a');
    expect(first.entry.connectionId).not.toBe(a.id);
    expect(registry.lookup('sid-1', 'self', null, 'nonce-a')).toEqual({
      ok: true,
      connectionId: first.entry.connectionId,
    });
    expect(registry.lookup('sid-1', 'other', null, 'nonce-a')).toEqual({
      ok: false,
      code: 'NO_CONNECTION',
    });
  });

  test('rejects a duplicate connectionId and keeps the previous session', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const b = new GatewaySession({ primary: createFakeCarrier() });
    expect(
      registry.register({
        connectionId: 'fixed-id',
        sid: 'sid-1',
        uid: 'u1',
        via: 'self',
        session: a,
      }).ok
    ).toBe(true);
    const dup = registry.register({
      connectionId: 'fixed-id',
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      session: b,
    });
    expect(dup).toEqual({ ok: false, code: 'DUPLICATE_CONNECTION' });
    expect(registry.getByConnectionId('fixed-id')?.session).toBe(a);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
  });

  test('rejects a duplicate cid in the same sid+via scope', () => {
    const registry = new SessionRegistry();
    const a = new GatewaySession({ primary: createFakeCarrier() });
    const b = new GatewaySession({ primary: createFakeCarrier() });
    const first = registry.register({
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      cid: 'same-nonce',
      session: a,
    });
    expect(first.ok).toBe(true);
    const dup = registry.register({
      sid: 'sid-1',
      uid: 'u1',
      via: 'self',
      cid: 'same-nonce',
      session: b,
    });
    expect(dup).toEqual({ ok: false, code: 'DUPLICATE_CID' });
    if (!first.ok) throw new Error('expected ok');
    expect(registry.getByConnectionId(first.entry.connectionId)?.session).toBe(a);
  });
});
