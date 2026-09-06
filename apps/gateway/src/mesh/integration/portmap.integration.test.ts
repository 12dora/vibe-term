import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildLogin,
  createDelegation,
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeLogin,
  generateEd25519KeyPair,
  signLogin,
} from '@tmex/shared/auth';
import { type LinkSession, createInMemoryLinkPair } from '@tmex/shared/link';
import {
  KeyLogStore,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
  makeVerifyPasskeyAssertion,
  nodeSessionCookieName,
} from '../../auth';
import { createMigratedAuthDb } from '../../auth/test-db';
import type { AuthDb } from '../../auth/types';
import { resetPeerStreamSlots } from '../../portmap/budget';
import { shutdownWriteHalf } from '../../portmap/half-close';
import { PortMapManager } from '../../portmap/manager';
import { isPortFree } from '../../portmap/port-probe';
import { PortMapExportStore, PortMapStore } from '../../portmap/store';
import {
  type EchoServer,
  startAfterFinServer,
  startEchoServer,
  startSlowEchoServer,
} from '../../portmap/test-echo-server';
import type { GatewayRuntime } from '../../runtime';
import { WebSocketServer } from '../../ws';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { waitUntil } from '../test-support';

const PASSWORD = 'tmex-test';
const dummyServer = { upgrade: () => false };

function fakeGateway(db: AuthDb): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: new WebSocketServer(),
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
  } as unknown as GatewayRuntime;
}

/** 让测试能制造「链路还在拨」的窗口。 */
const linkDial = { delayMs: 0, count: 0 };

function peerLinkFactory(
  selfId: string,
  remote: { mesh: MeshRuntime | null }
): (peerNodeId: string, signal: AbortSignal) => Promise<LinkSession | null> {
  return async (peerNodeId) => {
    if (!remote.mesh || remote.mesh.nodeId !== peerNodeId) return null;
    linkDial.count += 1;
    if (linkDial.delayMs > 0) await Bun.sleep(linkDial.delayMs);
    const [local, other] = createInMemoryLinkPair();
    remote.mesh.peers.adoptLink(selfId, other, 'ws-secure', selfId);
    return local;
  };
}

type Fixture = { close: () => void; stop?: () => Promise<void> };
const fixtures: Fixture[] = [];

async function callMesh(
  mesh: MeshRuntime,
  url: string,
  init: RequestInit & { cookie?: string }
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  const req = new Request(url, { ...init, headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await mesh.handleRequest(req, dummyServer);
  if (!(res instanceof Response)) throw new Error(`unhandled ${url}`);
  return res;
}

/** A 的本机登录：注册 enrollment 需要一个会话 cookie。 */
async function loginSelf(
  mesh: MeshRuntime,
  boot: { userId: string; rootKey: Parameters<typeof createDelegation>[0] }
): Promise<string> {
  const sess = generateEd25519KeyPair();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const ch = await callMesh(mesh, 'http://entry/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: boot.userId }),
  });
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: mesh.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: MESH_VIA_SELF,
  });
  const res = await callMesh(mesh, 'http://entry/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie?.() ?? [];
  const prefix = `${nodeSessionCookieName(MESH_VIA_SELF)}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length).split(';')[0] ?? '';
  }
  throw new Error('no session cookie');
}

async function bootA() {
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const keys = new UserKeyService({
    db,
    userStore,
    keyLogStore,
    nodeSessionStore: new NodeSessionStore(db),
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const boot = await keys.bootstrapUserWithSelfAdmit({
    username: 'alice',
    password: PASSWORD,
    identity,
  });
  const holderB: { mesh: MeshRuntime | null } = { mesh: null };
  const mesh = await createMeshRuntime({
    db,
    gateway: fakeGateway(db),
    userId: boot.userId,
    config: {
      roles: { hub: true, node: true, relay: false },
      hubUrl: null,
      hubPublicUrl: 'http://hub.example',
      peerPort: 0,
      stunServers: [],
    },
    startPeerServer: false,
    pingIntervalMs: 60_000,
    networkInterfaces: () => ({}),
    linkFactory: peerLinkFactory(identity.nodeIdHex, holderB),
    loadNative: async () => null,
  });
  fixtures.push({ close, stop: () => mesh.stop() });
  await mesh.start();
  await waitUntil(() => mesh.uplink.state === 'online', 5_000);
  return { db, mesh, boot, keys, keyLogStore, holderB };
}

async function enrollB(a: Awaited<ReturnType<typeof bootA>>) {
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const now = Date.now();
  const enrollment = await createEnrollment(a.boot.rootKey, {
    uid: a.boot.userId,
    rootEpoch: a.boot.rootEpoch,
    now,
    ttlMs: 60_000,
  });
  const sid = await loginSelf(a.mesh, a.boot);
  const created = await a.mesh.hub?.handleRequest(
    (() => {
      const req = new Request('http://hub/api/hub/enrollments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`,
        },
        body: JSON.stringify({
          enroll_pk: encodeBase64url(enrollment.enrollPk),
          authorization: encodeBase64url(enrollment.authorizationBytes),
          authorization_sig: encodeBase64url(enrollment.authorizationSig),
          exp: now + 60_000,
        }),
      });
      setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
      return req;
    })(),
    dummyServer
  );
  expect(created?.status).toBe(201);
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid: a.boot.userId,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk: enrollment.enrollPk,
    now,
    nodeId: identity.nodeId,
  });
  const redeemed = await a.mesh.hub?.handleRequest(
    new Request('http://hub/api/hub/enrollments/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        certificate: encodeBase64url(cert.certificateBytes),
        cert_sig: encodeBase64url(cert.certSig),
        name: 'node-b',
        version: 'test',
      }),
    }),
    dummyServer
  );
  expect(redeemed?.status).toBe(200);
  const admitted = await a.keys.signAndApply(a.boot.userId, a.boot.rootKey, {
    type: 'admit-node',
    payload: encodeAdmitNodePayload({
      authorization_bytes: enrollment.authorizationBytes,
      authorization_sig: enrollment.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    }),
  });
  expect(admitted.ok).toBe(true);
  const userStore = new UserStore(db);
  const keys = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore: new NodeSessionStore(db),
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const rows = a.keyLogStore.list(a.boot.userId);
  const head = a.keyLogStore.head(a.boot.userId);
  const joined = await keys.verifyChainForJoin(
    rows.map((row) => ({ bytes: row.bytes, sig: row.sig })),
    a.boot.rootPublicKey,
    head?.hash ?? new Uint8Array(32)
  );
  expect(joined.ok).toBe(true);
  const holderA: { mesh: MeshRuntime | null } = { mesh: a.mesh };
  const mesh = await createMeshRuntime({
    db,
    gateway: fakeGateway(db),
    userId: a.boot.userId,
    config: {
      roles: { hub: false, node: true, relay: false },
      hubUrl: 'http://hub.example',
      peerPort: 0,
      stunServers: [],
    },
    uplinkHub: a.mesh.hub ?? undefined,
    startPeerServer: false,
    pingIntervalMs: 60_000,
    networkInterfaces: () => ({}),
    linkFactory: peerLinkFactory(identity.nodeIdHex, holderA),
    loadNative: async () => null,
  });
  fixtures.push({ close, stop: () => mesh.stop() });
  a.holderB.mesh = mesh;
  await mesh.start();
  await waitUntil(() => mesh.uplink.state === 'online', 5_000);
  return { db, mesh };
}

type TcpClient = {
  socket: Bun.Socket<unknown>;
  waitFor: (total: number) => Promise<Uint8Array>;
  waitClosed: () => Promise<void>;
};

async function tcpClient(port: number): Promise<TcpClient> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let closed = false;
  const wake: Array<() => void> = [];
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    allowHalfOpen: true,
    socket: {
      binaryType: 'uint8array',
      data(_s, chunk) {
        chunks.push(new Uint8Array(chunk as unknown as Uint8Array));
        received += chunk.length;
        for (const fn of wake.splice(0)) fn();
      },
      close() {
        closed = true;
        for (const fn of wake.splice(0)) fn();
      },
      error() {
        closed = true;
        for (const fn of wake.splice(0)) fn();
      },
    },
  });
  const tick = () =>
    new Promise<void>((resolve) => {
      wake.push(resolve);
      setTimeout(resolve, 25);
    });
  return {
    socket,
    async waitFor(total) {
      const deadline = Date.now() + 10_000;
      while (received < total) {
        if (closed) throw new Error(`socket closed after ${received} of ${total} bytes`);
        if (Date.now() > deadline) throw new Error(`timed out at ${received} of ${total} bytes`);
        await tick();
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out.subarray(0, total);
    },
    async waitClosed() {
      const deadline = Date.now() + 5_000;
      while (!closed) {
        if (Date.now() > deadline) throw new Error('socket stayed open');
        await tick();
      }
    },
  };
}

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

describe('portmap mesh integration', () => {
  const managers: PortMapManager[] = [];
  const servers: Array<{ stop: () => void }> = [];

  afterEach(async () => {
    linkDial.delayMs = 0;
    linkDial.count = 0;
    resetPeerStreamSlots();
    while (managers.length > 0) managers.pop()?.stop();
    while (servers.length > 0) servers.pop()?.stop();
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  async function setup(opts: { mapId?: string; withExport?: boolean; target?: EchoServer } = {}) {
    const mapId = opts.mapId ?? 'integration-map-1';
    const a = await bootA();
    const b = await enrollB(a);
    const echo = opts.target ?? startEchoServer();
    servers.push(echo);
    if (opts.withExport !== false) {
      new PortMapExportStore(b.db).insert({
        mapId,
        fromNodeId: a.mesh.nodeId,
        host: '127.0.0.1',
        port: echo.port,
        enabled: true,
        createdAt: Date.now(),
      });
    }
    const manager = new PortMapManager({
      store: new PortMapStore(a.db),
      peers: () => a.mesh.peers,
      reservedPorts: () => [],
    });
    managers.push(manager);
    manager.start();
    const map = manager.create({
      name: 'echo',
      listenPort: freePort(),
      targetNodeId: b.mesh.nodeId,
      targetPort: echo.port,
      mapId,
    });
    return { a, b, echo, manager, map };
  }

  test('round-trips bytes from A to an echo server on B', async () => {
    const { manager, map, echo } = await setup();
    const client = await tcpClient(map.listenPort);
    client.socket.write(new TextEncoder().encode('hello mesh'));
    const back = await client.waitFor(10);
    expect(new TextDecoder().decode(back)).toBe('hello mesh');
    expect(echo.connections).toBe(1);
    await Bun.sleep(30);
    const dto = manager.get(map.id);
    expect(dto.activeConnections).toBe(1);
    expect(dto.totalConnections).toBe(1);
    expect(dto.bytesIn).toBe(10);
    expect(dto.bytesOut).toBe(10);
    client.socket.terminate();
  });

  test('carries more than one MiB through the mesh', async () => {
    const { manager, map } = await setup();
    const client = await tcpClient(map.listenPort);
    const size = 1024 * 1024 + 8192;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) payload[i] = (i * 7) & 0xff;
    let offset = 0;
    while (offset < size) {
      const written = client.socket.write(payload.subarray(offset));
      if (written < 0) throw new Error('client socket closed');
      offset += written;
      if (offset < size) await Bun.sleep(1);
    }
    const back = await client.waitFor(size);
    expect(back.byteLength).toBe(size);
    expect(back[size - 1]).toBe(((size - 1) * 7) & 0xff);
    await Bun.sleep(50);
    expect(manager.get(map.id).bytesOut).toBe(size);
    client.socket.terminate();
  });

  test('propagates half-close from the local client', async () => {
    const { map } = await setup();
    const client = await tcpClient(map.listenPort);
    client.socket.write(new TextEncoder().encode('bye'));
    const back = await client.waitFor(3);
    expect(new TextDecoder().decode(back)).toBe('bye');
    client.socket.end();
    await client.waitClosed();
  });

  test('a paused map refuses new connections and resumes on demand', async () => {
    const { manager, map } = await setup();
    manager.update(map.id, { paused: true });
    expect(isPortFree('127.0.0.1', map.listenPort)).toBe(true);
    await expect(tcpClient(map.listenPort)).rejects.toThrow();
    expect(manager.update(map.id, { paused: false }).state).toBe('listening');
    const client = await tcpClient(map.listenPort);
    client.socket.write(new TextEncoder().encode('up'));
    expect(new TextDecoder().decode(await client.waitFor(2))).toBe('up');
    client.socket.terminate();
  });

  test('closes the connection when B has no matching export row', async () => {
    const { echo, map } = await setup({ withExport: false });
    const client = await tcpClient(map.listenPort);
    client.socket.write(new TextEncoder().encode('nope'));
    await client.waitClosed();
    expect(echo.connections).toBe(0);
  });

  test('delete stops the listener and frees the port', async () => {
    const { manager, map } = await setup();
    const client = await tcpClient(map.listenPort);
    client.socket.write(new TextEncoder().encode('x'));
    await client.waitFor(1);
    manager.remove(map.id);
    await client.waitClosed();
    expect(isPortFree('127.0.0.1', map.listenPort)).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  async function writeAll(socket: Bun.Socket<unknown>, payload: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < payload.byteLength) {
      const written = socket.write(payload.subarray(offset));
      if (written < 0) throw new Error('client socket closed');
      offset += written;
      if (offset < payload.byteLength) await Bun.sleep(1);
    }
  }

  function ramp(size: number): Uint8Array {
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) payload[i] = (i * 31) & 0xff;
    return payload;
  }

  test('delivers a reply the target only produces after the client half-closes', async () => {
    const target = startAfterFinServer(new TextEncoder().encode('reply-after-fin'));
    const { map } = await setup({ target });
    const client = await tcpClient(map.listenPort);
    client.socket.write(new TextEncoder().encode('request'));
    await Bun.sleep(50);
    // 客户端只关写半边（Bun 的 end() 会连读半边一起关，这里直接走 POSIX shutdown）
    expect(shutdownWriteHalf(client.socket)).toBe(true);
    const back = await client.waitFor(15);
    expect(new TextDecoder().decode(back)).toBe('reply-after-fin');
    expect(target.received()).toBe(7);
    client.socket.terminate();
  });

  test('backs off on a slow target instead of buffering, and the link keeps working', async () => {
    const slow = startSlowEchoServer();
    const { manager, map } = await setup({ target: slow });
    const client = await tcpClient(map.listenPort);
    const size = 4 * 1024 * 1024;
    const payload = ramp(size);
    const pushed = writeAll(client.socket, payload).catch(() => {});
    await Bun.sleep(400);
    const stalled = manager.get(map.id).bytesOut;
    // 目标一个字节都没读：窗口撑满之后就该停在那儿，而不是把 4 MiB 吞进内存
    expect(stalled).toBeGreaterThan(0);
    expect(stalled).toBeLessThan(3 * 1024 * 1024);
    slow.release();
    await pushed;
    const back = await client.waitFor(size);
    expect(back.byteLength).toBe(size);
    expect(back[size - 1]).toBe(((size - 1) * 31) & 0xff);
    const second = await tcpClient(map.listenPort);
    second.socket.write(new TextEncoder().encode('ping'));
    expect(new TextDecoder().decode(await second.waitFor(4))).toBe('ping');
    client.socket.terminate();
    second.socket.terminate();
  });

  test('keeps the bytes sent while the peer link is still being dialled', async () => {
    linkDial.delayMs = 300;
    const { map } = await setup();
    const before = linkDial.count;
    const client = await tcpClient(map.listenPort);
    const size = 2 * 1024 * 1024;
    const payload = ramp(size);
    await writeAll(client.socket, payload);
    const back = await client.waitFor(size);
    expect(back.byteLength).toBe(size);
    expect(back[0]).toBe(0);
    expect(back[size - 1]).toBe(((size - 1) * 31) & 0xff);
    expect(linkDial.count).toBeGreaterThan(before);
    client.socket.terminate();
  });
});
