import { afterEach, describe, expect, test } from 'bun:test';
import {
  DOMAIN_CERTIFICATE,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeCertificate,
  hexToBytes,
  randomBytes,
} from '@tmex/shared/auth';
import { WebSocketLink } from '@tmex/shared/link';
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
import {
  ImmediateScheduler,
  fakeSocketPair,
  seedNodeIdentity,
  seedUser,
  waitUntil,
} from './test-support';
import { decodeUplinkCtl, encodeUplinkCtl } from './uplink-protocol';

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
    seedUser(new UserStore(db));
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
    seedUser(new UserStore(db));
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

  test('resolves userId from hub cert when this node has not been admitted yet', async () => {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    userStore.upsertCert({
      nodeId: 'ff'.repeat(16),
      userId: 'user-1',
      admitRecordSeq: 2,
      certificateBytes: randomBytes(8),
      certSig: randomBytes(64),
      authorizationBytes: randomBytes(8),
      authorizationSig: randomBytes(64),
      revokedLogSeq: null,
    });
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
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    expect(mesh.uplink.userId).toBe('user-1');
    expect(userStore.getCert(mesh.nodeId)).toBeNull();
  });

  test('resolves userId from the sole users row when no certs exist yet', async () => {
    const { db, close } = createMigratedAuthDb();
    seedUser(new UserStore(db));
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
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    expect(mesh.uplink.userId).toBe('user-1');
  });

  test('does not start uplink when users/certs are empty or ambiguous', async () => {
    const emptyDb = createMigratedAuthDb();
    const [emptyWs] = fakeSocketPair();
    const emptyMesh = await createMeshRuntime({
      db: emptyDb.db,
      gateway: fakeGateway(emptyDb.db),
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://127.0.0.1:9',
        peerPort: 0,
        stunServers: [],
      },
      wsFactory: () => emptyWs,
      startPeerServer: false,
    });
    fixtures.push({ close: emptyDb.close, stop: () => emptyMesh.stop() });
    expect(emptyMesh.uplink.userId).toBe('');
    await emptyMesh.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(emptyMesh.uplink.link).toBeNull();
    expect(emptyMesh.uplink.state).toBe('offline');

    const { db, close } = createMigratedAuthDb();
    const store = new UserStore(db);
    seedUser(store, 'user-1');
    seedUser(store, 'user-2');
    store.upsertCert({
      nodeId: 'aa'.repeat(16),
      userId: 'user-1',
      admitRecordSeq: 1,
      certificateBytes: randomBytes(8),
      certSig: randomBytes(64),
      authorizationBytes: randomBytes(8),
      authorizationSig: randomBytes(64),
      revokedLogSeq: null,
    });
    store.upsertCert({
      nodeId: 'bb'.repeat(16),
      userId: 'user-2',
      admitRecordSeq: 1,
      certificateBytes: randomBytes(8),
      certSig: randomBytes(64),
      authorizationBytes: randomBytes(8),
      authorizationSig: randomBytes(64),
      revokedLogSeq: null,
    });
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
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    expect(mesh.uplink.userId).toBe('');
    await mesh.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mesh.uplink.link).toBeNull();
    expect(mesh.uplink.state).toBe('offline');
  });

  test('hub role still starts local uplink when no user has been created yet', async () => {
    const { db, close } = createMigratedAuthDb();
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: true, node: true },
        hubUrl: null,
        hubPublicUrl: 'http://127.0.0.1',
        peerPort: 0,
        stunServers: [],
      },
      peerHostname: '127.0.0.1',
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    expect(mesh.uplink.userId).toBe('');
    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    expect(mesh.uplink.state === 'connecting' || mesh.uplink.state === 'online').toBe(true);
  });

  test('hub presence is ignored after uplink disconnects so stale online is not returned', async () => {
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
    const listed = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(listed instanceof Response)) throw new Error('expected Response');
    const onlineBody = (await listed.json()) as {
      nodes: Array<{ id: string; online: boolean }>;
    };
    expect(onlineBody.nodes.find((n) => n.id === peerId)?.online).toBe(true);
    expect(mesh.lastNodeList?.nodes.find((n) => n.id === peerId)?.online).toBe(true);

    clientWs.close(1000, 'hub-gone');
    await waitUntil(() => mesh.uplink.state !== 'online');
    const offline = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(offline instanceof Response)) throw new Error('expected Response');
    const offlineBody = (await offline.json()) as {
      nodes: Array<{ id: string; online: boolean }>;
    };
    expect(offlineBody.nodes.find((n) => n.id === peerId)?.online).toBe(false);
    expect(mesh.lastNodeList?.nodes.find((n) => n.id === peerId)?.online).toBe(true);
  });

  test('node role with empty userId does not bind the peer listener', async () => {
    const { db, close } = createMigratedAuthDb();
    const [emptyWs] = fakeSocketPair();
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://127.0.0.1:9',
        peerPort: 0,
        stunServers: [],
      },
      wsFactory: () => emptyWs,
      peerHostname: '127.0.0.1',
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    expect(mesh.uplink.userId).toBe('');
    expect(mesh.peers.listenPort).toBeNull();
    expect(mesh.uplink.state).toBe('offline');
  });

  test('hub empty db binds deny-all then works after hub user add without restart', async () => {
    const { db, close } = createMigratedAuthDb();
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: true, node: true },
        hubUrl: null,
        hubPublicUrl: 'http://127.0.0.1',
        peerPort: 0,
        stunServers: [],
      },
      peerHostname: '127.0.0.1',
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    expect(mesh.uplink.userId).toBe('');
    expect(mesh.peers.listenPort).toBeGreaterThan(0);
    const boot = await mesh.userKeyService.bootstrapUserWithSelfAdmit({
      username: 'hub',
      password: 'pw',
      identity: mesh.identity,
    });
    expect(mesh.uplink.userId).toBe(boot.userId);
    const peer = seedNodeIdentity(mesh.userStore, boot.userId);
    mesh.userStore.upsertPeer({
      nodeId: peer.nodeId,
      name: 'peer',
      endpointsJson: '[]',
      inventoryJson: '{}',
      directCapable: false,
      lastSeenAt: Date.now(),
      listVersion: 1,
    });
    expect(mesh.peers.listReach().has(peer.nodeId)).toBe(true);
  });

  test('hub presence is fresh only after the current generation finishes catch-up and offlines de-dupe', async () => {
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
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const events: Array<{ nodeId: string; status: string }> = [];
    const sockets: { current: ReturnType<typeof fakeSocketPair>[0] } = { current: clientWs };
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://127.0.0.1:9',
        peerPort: 0,
        stunServers: [],
      },
      wsFactory: () => sockets.current,
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    mesh.onNodeEvent((event) => {
      events.push({ nodeId: event.nodeId, status: event.status });
    });
    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => mesh.uplink.state === 'online');
    const listedPre = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(listedPre instanceof Response)) throw new Error('expected Response');
    const preBody = (await listedPre.json()) as { nodes: Array<{ id: string; online: boolean }> };
    expect(preBody.nodes.find((n) => n.id === peerId)?.online ?? false).toBe(false);

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
    const listed = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(listed instanceof Response)) throw new Error('expected Response');
    const onlineBody = (await listed.json()) as { nodes: Array<{ id: string; online: boolean }> };
    expect(onlineBody.nodes.find((n) => n.id === peerId)?.online).toBe(true);

    clientWs.close(1000, 'hub-gone');
    await waitUntil(() => mesh.uplink.state !== 'online');
    const offlineCount = events.filter((e) => e.nodeId === peerId && e.status === 'offline').length;
    expect(offlineCount).toBe(1);

    const [clientWs2, hubWs2] = fakeSocketPair();
    const hub2 = new WebSocketLink(hubWs2, { role: 'acceptor' });
    hub2.ctl.onMessage(() => {});
    sockets.current = clientWs2;
    await waitUntil(() => mesh.uplink.link !== null && mesh.uplink.state !== 'offline', 5_000);
    hub2.ctl.send(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) })
    );
    hub2.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => mesh.uplink.state === 'online', 5_000);
    const listedStale = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(listedStale instanceof Response)) throw new Error('expected Response');
    const staleBody = (await listedStale.json()) as {
      nodes: Array<{ id: string; online: boolean }>;
    };
    expect(staleBody.nodes.find((n) => n.id === peerId)?.online ?? false).toBe(false);

    clientWs2.close(1000, 'hub-gone-again');
    await waitUntil(() => mesh.uplink.state !== 'online');
    const offlineAfter = events.filter((e) => e.nodeId === peerId && e.status === 'offline').length;
    expect(offlineAfter).toBe(1);
  });

  test('node.list inventory changes emit NODE_EVENT while identical projections are de-duped', async () => {
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
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const events: Array<{ nodeId: string; status: string; inventory?: string | null }> = [];
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
    mesh.onNodeEvent((event) => {
      events.push({ nodeId: event.nodeId, status: event.status, inventory: event.inventory });
    });
    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => mesh.uplink.state === 'online');

    const sendList = (version: string, inventory: unknown) => {
      hub.ctl.send(
        encodeUplinkCtl({
          t: 'node.list',
          version: Number(version[0]),
          key_log_head: { seq: 0n, hash: new Uint8Array(32) },
          rtc: { stun: [], turn: null },
          nodes: [
            {
              id: peerId,
              name: 'peer',
              online: true,
              endpoints: [],
              inventory,
              direct_capable: false,
              version,
            },
          ],
        })
      );
    };

    sendList('1.0.0', { version: '1.0.0' });
    await waitUntil(
      () => events.filter((e) => e.nodeId === peerId && e.status === 'online').length >= 1
    );
    sendList('1.0.0', { version: '1.0.0' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterSame = events.filter((e) => e.nodeId === peerId && e.status === 'online');
    expect(afterSame).toHaveLength(1);

    sendList('2.0.0', { version: '2.0.0' });
    await waitUntil(
      () => events.filter((e) => e.nodeId === peerId && e.status === 'online').length >= 2
    );
    const online = events.filter((e) => e.nodeId === peerId && e.status === 'online');
    expect(online).toHaveLength(2);
    expect(online[1]?.inventory).toContain('2.0.0');
  });

  test('GET /api/auth/nodes shows listed names for peers, hub, and self after node.list', async () => {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const peerId = 'cd'.repeat(16);
    const hubId = 'ef'.repeat(16);
    const certOf = (id: string, fill: number) =>
      encodeCertificate({
        domain: DOMAIN_CERTIFICATE,
        uid: 'user-1',
        node_id: hexToBytes(id),
        ed_pk: new Uint8Array(32).fill(fill),
        x25519_pk: new Uint8Array(32).fill(fill),
        enroll_pk: new Uint8Array(32).fill(fill),
        issued_at: 1n,
      });
    for (const [id, fill] of [
      [peerId, 4],
      [hubId, 7],
    ] as const) {
      userStore.upsertCert({
        nodeId: id,
        userId: 'user-1',
        admitRecordSeq: 1,
        certificateBytes: certOf(id, fill),
        certSig: randomBytes(64),
        authorizationBytes: randomBytes(8),
        authorizationSig: randomBytes(64),
        revokedLogSeq: null,
      });
    }
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    hub.ctl.onMessage(() => {});
    const events: Array<{ nodeId: string; name?: string }> = [];
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
    mesh.onNodeEvent((event) => {
      events.push({ nodeId: event.nodeId, name: event.name });
    });
    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => mesh.uplink.state === 'online');
    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 1,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        hub: { nodeId: hubId, publicUrl: 'https://hub.example', name: 'hub-site' },
        nodes: [
          {
            id: mesh.nodeId,
            name: 'home',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
          {
            id: peerId,
            name: 'node-a',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
          {
            id: hubId,
            name: 'hub-site',
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
    const listed = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(listed instanceof Response)) throw new Error('expected Response');
    const body = (await listed.json()) as { nodes: Array<{ id: string; name: string }> };
    expect(body.nodes.find((n) => n.id === peerId)?.name).toBe('node-a');
    expect(body.nodes.find((n) => n.id === hubId)?.name).toBe('hub-site');
    expect(body.nodes.find((n) => n.id === mesh.nodeId)?.name).toBe('home');
    expect(mesh.userStore.listPeers().find((row) => row.nodeId === peerId)?.name).toBe('node-a');
    expect(mesh.userStore.listPeers().find((row) => row.nodeId === hubId)?.name).toBe('hub-site');
    expect(mesh.userStore.listPeers().find((row) => row.nodeId === mesh.nodeId)).toBeUndefined();
    await waitUntil(() => events.some((e) => e.nodeId === peerId && e.name === 'node-a'));

    hub.ctl.send(
      encodeUplinkCtl({
        t: 'node.list',
        version: 2,
        key_log_head: { seq: 0n, hash: new Uint8Array(32) },
        rtc: { stun: [], turn: null },
        hub: { nodeId: hubId, publicUrl: 'https://hub.example', name: 'hub-site' },
        nodes: [
          {
            id: mesh.nodeId,
            name: 'home',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
          {
            id: peerId,
            name: 'renamed-a',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
          {
            id: hubId,
            name: 'hub-site',
            online: true,
            endpoints: [],
            inventory: {},
            direct_capable: false,
            version: '1.0.0',
          },
        ],
      })
    );
    await waitUntil(
      () => mesh.userStore.listPeers().find((row) => row.nodeId === peerId)?.name === 'renamed-a'
    );
    await waitUntil(() => events.some((e) => e.nodeId === peerId && e.name === 'renamed-a'));
    const renamed = await mesh.handleRequest(new Request('http://localhost/api/auth/nodes'), {
      upgrade: () => false,
    });
    if (!(renamed instanceof Response)) throw new Error('expected Response');
    const renamedBody = (await renamed.json()) as { nodes: Array<{ id: string; name: string }> };
    expect(renamedBody.nodes.find((n) => n.id === peerId)?.name).toBe('renamed-a');
  });

  test('re-advertises node.status endpoints when network interfaces change', async () => {
    const { db, close } = createMigratedAuthDb();
    seedUser(new UserStore(db));
    const [clientWs, hubWs] = fakeSocketPair();
    const hub = new WebSocketLink(hubWs, { role: 'acceptor' });
    const received: ReturnType<typeof decodeUplinkCtl>[] = [];
    hub.ctl.onMessage((bytes) => {
      received.push(decodeUplinkCtl(bytes));
    });
    const ifaces: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]> = {
      eth0: [
        {
          address: '10.0.0.8',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '10.0.0.8/24',
        },
      ],
    };
    const scheduler = new ImmediateScheduler();
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://127.0.0.1:9',
        peerPort: 39001,
        stunServers: [],
      },
      wsFactory: () => clientWs,
      startPeerServer: false,
      scheduler,
      pingIntervalMs: 15_000,
      networkInterfaces: () => ifaces,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    await waitUntil(() => mesh.uplink.link !== null);
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) }));
    hub.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await waitUntil(() => mesh.uplink.state === 'online');
    await waitUntil(() => received.some((msg) => msg.t === 'node.status'));
    const first = received.find((msg) => msg.t === 'node.status');
    expect(first?.t).toBe('node.status');
    if (first?.t !== 'node.status') throw new Error('expected node.status');
    expect(first.endpoints).toEqual(['ws://10.0.0.8:39001/peer']);

    ifaces.lan0 = [
      {
        address: '172.28.0.4',
        netmask: '255.255.0.0',
        family: 'IPv4',
        mac: '11:22:33:44:55:66',
        internal: false,
        cidr: '172.28.0.4/16',
      },
    ];
    const before = received.filter((msg) => msg.t === 'node.status').length;
    scheduler.tickIntervals();
    await waitUntil(() => received.filter((msg) => msg.t === 'node.status').length > before, 2_000);
    const latest = [...received].reverse().find((msg) => msg.t === 'node.status');
    expect(latest?.t).toBe('node.status');
    if (latest?.t !== 'node.status') throw new Error('expected node.status');
    expect(latest.endpoints).toEqual(
      expect.arrayContaining(['ws://10.0.0.8:39001/peer', 'ws://172.28.0.4:39001/peer'])
    );
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
