import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  buildLogin,
  createDelegation,
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeLogin,
  encodeRevokeNodePayload,
  generateEd25519KeyPair,
  hexToBytes,
  rootKeyFromSeed,
  signEd25519,
  signLogin,
} from '@tmex/shared/auth';
import {
  FrameDecoder,
  GCM_TAG_LENGTH,
  SC_DIRECTION_INITIATOR,
  buildAesGcmNonce,
  encodeFrameHeader,
} from '@tmex/shared/link';
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
import { signUserRecord } from '../../hub/hub-test-helpers';
import type { GatewayRuntime } from '../../runtime';
import type { DeviceSessionRuntime } from '../../tmux-client/device-session-runtime';
import { WebSocketServer } from '../../ws';
import { MESH_FORWARD_WS_KIND, MESH_VIA_SELF, setMeshRequestContext } from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { RtcPeerManager } from '../rtc';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { openHttpStream, openWsStream } from '../stream-targets';
import { waitUntil } from '../test-support';

const PASSWORD = 'tmex-test';
const dummyServer = { upgrade: () => false };

function fakeRuntime(): DeviceSessionRuntime {
  return {
    connect: async () => {},
    subscribe: () => () => {},
    requestSnapshot: () => {},
    disconnect: () => {},
    getCurrentSnapshot: () => null,
    setWindowStyle: async () => {},
  } as unknown as DeviceSessionRuntime;
}

function fakeGateway(
  db: AuthDb,
  opts?: {
    devicesBody?: unknown;
    wsServer?: WebSocketServer;
    dispatchHttp?: GatewayRuntime['dispatchHttp'];
    onAbort?: (req: Request) => void;
  }
): GatewayRuntime {
  const wsServer = opts?.wsServer ?? new WebSocketServer();
  return {
    port: 0,
    db,
    wsServer,
    handleRequest: () => undefined,
    dispatchHttp: async (request) => {
      opts?.onAbort?.(request);
      if (opts?.dispatchHttp) return opts.dispatchHttp(request, { uid: null, viaNodeId: 'x' });
      const path = new URL(request.url).pathname;
      if (path === '/api/devices') {
        return new Response(JSON.stringify(opts?.devicesBody ?? { devices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
    },
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

function sidFromResponse(res: Response, nodeId = MESH_VIA_SELF): string {
  const cookies = res.headers.getSetCookie?.() ?? [];
  const prefix = `${nodeSessionCookieName(nodeId)}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      return cookie.slice(prefix.length).split(';')[0] ?? '';
    }
  }
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${nodeSessionCookieName(nodeId)}=([^;]*)`));
  if (match?.[1]) return match[1];
  throw new Error(`no session cookie for ${nodeId}: ${header}`);
}

async function callMesh(
  mesh: MeshRuntime,
  url: string,
  init?: RequestInit & { cookie?: string }
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set('cookie', init.cookie);
  const req = new Request(url, { ...init, headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await mesh.handleRequest(req, dummyServer);
  if (!(res instanceof Response)) {
    throw new Error(`unhandled ${url}`);
  }
  return res;
}

async function loginSelf(
  mesh: MeshRuntime,
  boot: { userId: string; rootKey: Parameters<typeof createDelegation>[0] }
): Promise<string> {
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now,
  });
  const ch = await callMesh(mesh, 'http://entry/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: boot.userId }),
  });
  expect(ch.status).toBe(200);
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
  return sidFromResponse(res, MESH_VIA_SELF);
}

async function loginRemote(
  entry: MeshRuntime,
  target: MeshRuntime,
  boot: { userId: string; rootKey: Parameters<typeof createDelegation>[0] },
  cookie: string,
  targetPk = target.identity.edPublicKey
): Promise<Response> {
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now,
  });
  const ch = await callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({ uid: boot.userId }),
  });
  if (ch.status !== 200) return ch;
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: target.nodeId,
    targetPk,
    uid: boot.userId,
    entry: entry.nodeId,
  });
  return callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
}

function peerLinkFactory(
  selfId: string,
  remote: { mesh: MeshRuntime | null }
): (peerNodeId: string, signal: AbortSignal) => Promise<LinkSession | null> {
  return async (peerNodeId) => {
    if (!remote.mesh || remote.mesh.nodeId !== peerNodeId) return null;
    const [local, other] = createInMemoryLinkPair();
    remote.mesh.peers.adoptLink(selfId, other, 'ws-secure', selfId);
    return local;
  };
}

describe('mesh phase-2 integration', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  async function bootHubA(opts?: { linkFactory?: boolean; loadNative?: () => Promise<unknown> }) {
    const { db, close } = createMigratedAuthDb();
    const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
    const userStore = new UserStore(db);
    const keyLogStore = new KeyLogStore(db);
    const nodeSessionStore = new NodeSessionStore(db);
    const keys = new UserKeyService({
      db,
      userStore,
      keyLogStore,
      nodeSessionStore,
      verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
    });
    const boot = await keys.bootstrapUserWithSelfAdmit({
      username: 'alice',
      password: PASSWORD,
      identity,
    });
    const gateway = fakeGateway(db, { devicesBody: { devices: [{ id: 'dev-a' }] } });
    const holderB: { mesh: MeshRuntime | null } = { mesh: null };
    const mesh = await createMeshRuntime({
      db,
      gateway,
      userId: boot.userId,
      config: {
        roles: { hub: true, node: true },
        hubUrl: null,
        hubPublicUrl: 'http://hub.example',
        peerPort: 39001,
        stunServers: [],
      },
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      linkFactory:
        opts?.linkFactory === false ? undefined : peerLinkFactory(identity.nodeIdHex, holderB),
      loadNative: (opts?.loadNative as never) ?? (async () => null),
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    await waitUntil(() => mesh.uplink.state === 'online', 5_000);
    return { db, close, mesh, boot, gateway, holderB, userStore, keyLogStore, keys };
  }

  async function enrollNodeB(
    a: Awaited<ReturnType<typeof bootHubA>>,
    opts?: { linkFactory?: boolean; loadNative?: () => Promise<unknown> }
  ) {
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
    const cookie = `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;
    const created = await a.mesh.hub?.handleRequest(
      (() => {
        const req = new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
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

    const rows = a.keyLogStore.list(a.boot.userId);
    const head = a.keyLogStore.head(a.boot.userId);
    expect(head).not.toBeNull();
    const bUserStore = new UserStore(db);
    const bKeyLog = new KeyLogStore(db);
    const bSessions = new NodeSessionStore(db);
    const bKeys = new UserKeyService({
      db,
      userStore: bUserStore,
      keyLogStore: bKeyLog,
      nodeSessionStore: bSessions,
      verifyPasskeyAssertion: makeVerifyPasskeyAssertion(bUserStore),
    });
    const joined = await bKeys.verifyChainForJoin(
      rows.map((row) => ({ bytes: row.bytes, sig: row.sig })),
      a.boot.rootPublicKey,
      head?.hash ?? new Uint8Array(32)
    );
    expect(joined.ok).toBe(true);

    const abortHook = { aborted: false, cleanup: 0 };
    let resolveUploadReady: () => void = () => {};
    const uploadReady = new Promise<void>((resolve) => {
      resolveUploadReady = resolve;
    });
    const connectedDevices: string[] = [];
    const wsServer = new WebSocketServer({
      deps: {
        acquireRuntime: async (deviceId) => {
          connectedDevices.push(deviceId);
          return fakeRuntime();
        },
        releaseRuntime: async () => {},
        loadDeviceTreeOrder: () => ({ deviceId: '', windows: [], panes: {} }),
        saveWindowOrder: () => {},
        savePaneOrder: () => {},
      },
    });
    const gateway = fakeGateway(db, {
      devicesBody: { devices: [{ id: 'dev-b', name: 'B box' }] },
      wsServer,
      dispatchHttp: async (request) => {
        if (request.signal.aborted) {
          abortHook.aborted = true;
          abortHook.cleanup += 1;
        } else {
          request.signal.addEventListener(
            'abort',
            () => {
              abortHook.aborted = true;
              abortHook.cleanup += 1;
            },
            { once: true }
          );
        }
        const path = new URL(request.url).pathname;
        if (path === '/api/devices') {
          return new Response(JSON.stringify({ devices: [{ id: 'dev-b', name: 'B box' }] }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path === '/api/upload') {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) {
              resolveUploadReady();
              resolve();
              return;
            }
            request.signal.addEventListener('abort', () => resolve(), { once: true });
            resolveUploadReady();
          });
          return new Response('aborted', { status: 499 });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const holderA: { mesh: MeshRuntime | null } = { mesh: a.mesh };
    const mesh = await createMeshRuntime({
      db,
      gateway,
      userId: a.boot.userId,
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://hub.example',
        peerPort: 39002,
        stunServers: [],
      },
      uplinkHub: a.mesh.hub ?? undefined,
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      linkFactory:
        opts?.linkFactory === false ? undefined : peerLinkFactory(identity.nodeIdHex, holderA),
      loadNative: (opts?.loadNative as never) ?? (async () => null),
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    a.holderB.mesh = mesh;
    await mesh.start();
    await waitUntil(() => mesh.uplink.state === 'online', 5_000);
    await waitUntil(
      () => a.mesh.lastNodeList?.nodes.some((n) => n.id === mesh.nodeId && n.online) === true,
      5_000
    );
    return {
      mesh,
      identity,
      cookie,
      sid,
      abortHook,
      uploadReady,
      connectedDevices,
      wsServer,
      close,
    };
  }

  test('browser-style login fan-out sets cookies on A origin and GET /n/B/api/devices returns B data', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const remote = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    expect(remote.status).toBe(200);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    expect(bSid.length).toBeGreaterThan(8);
    const jar = `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSid}`;
    const devices = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect(devices.status).toBe(200);
    expect(await devices.json()).toEqual({ devices: [{ id: 'dev-b', name: 'B box' }] });
  });

  test('/n/B/ws HELLO then DEVICE_CONNECT reaches B WebSocketServer', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const remote = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSid}`;

    const upgraded: { data?: Record<string, unknown> } = {};
    const sent: Uint8Array[] = [];
    const server = {
      upgrade(_req: Request, opts?: { data?: unknown }) {
        upgraded.data = (opts?.data ?? {}) as Record<string, unknown>;
        return true;
      },
    };
    const req = new Request(`http://entry/n/${b.mesh.nodeId}/ws`, {
      headers: { cookie: jar, upgrade: 'websocket', connection: 'Upgrade' },
    });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
    const res = await a.mesh.handleRequest(req, server);
    expect(res).toBeUndefined();
    expect(upgraded.data?.kind).toBe(MESH_FORWARD_WS_KIND);

    const ws = {
      data: upgraded.data,
      send(bytes: Uint8Array | string) {
        if (typeof bytes !== 'string') sent.push(bytes);
        return typeof bytes === 'string' ? bytes.length : bytes.byteLength;
      },
      close() {},
    };
    a.mesh.websocket.open(ws as never);
    const hello = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_HELLO_C2S,
      wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
        clientImpl: 'test',
        clientVersion: '1',
        maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
        supportsCompression: false,
        supportsDiffSnapshot: false,
      }),
      1
    );
    a.mesh.websocket.message(ws as never, Buffer.from(hello));
    await waitUntil(() => sent.length > 0, 3_000);
    const connect = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_DEVICE_CONNECT,
      wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId: 'dev-b' }),
      2
    );
    a.mesh.websocket.message(ws as never, Buffer.from(connect));
    await waitUntil(() => b.connectedDevices.includes('dev-b'), 3_000);
    expect(b.connectedDevices).toContain('dev-b');
  });

  test('relay path carries SecureChannel ciphertext (no Borsh magic, no JSON body)', async () => {
    const a = await bootHubA({ linkFactory: false });
    const b = await enrollNodeB(a, { linkFactory: false });
    const captured: Uint8Array[] = [];
    const orig = a.mesh.uplink.openRelay.bind(a.mesh.uplink);
    a.mesh.uplink.openRelay = async (to) => {
      const stream = await orig(to);
      const write = stream.write.bind(stream);
      stream.write = async (bytes, opts) => {
        captured.push(bytes.slice());
        return write(bytes, opts);
      };
      return stream;
    };
    const remote = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    expect(remote.status).toBe(200);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSid}`;
    const devices = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect(devices.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    const total = captured.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBeGreaterThan(16);
    const joined = concatCaptured(captured);
    const magic = new Uint8Array([0x54, 0x58]);
    expect(containsBytes(joined, magic)).toBe(false);
    expect(containsAcrossChunks(captured, magic)).toBe(false);
    const openPlain = new TextEncoder().encode('{"type":"http"');
    const pathPlain = new TextEncoder().encode('/api/devices');
    const devicesPlain = new TextEncoder().encode('dev-b');
    expect(containsBytes(joined, openPlain)).toBe(false);
    expect(containsBytes(joined, pathPlain)).toBe(false);
    expect(containsBytes(joined, devicesPlain)).toBe(false);
    expect(containsAcrossChunks(captured, pathPlain)).toBe(false);
    const keys = a.mesh.peers.sessionKeysOf(b.mesh.nodeId);
    expect(keys).not.toBeNull();
    const decrypted = await decryptInitiatorFrames(keys?.sendKey as Uint8Array, captured);
    const decText = new TextDecoder().decode(decrypted);
    expect(decText.includes('/api/devices') || decText.includes('http')).toBe(true);
  });

  test('upload abort aborts the target Request.signal and runs cleanup', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const remote = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSid}`;
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    });
    const req = new Request(`http://entry/n/${b.mesh.nodeId}/api/upload`, {
      method: 'POST',
      headers: { cookie: jar, 'content-type': 'application/octet-stream' },
      body,
      signal: ac.signal,
    });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
    const pending = a.mesh.handleRequest(req, dummyServer);
    await b.uploadReady;
    ac.abort();
    await pending.catch(() => undefined);
    await waitUntil(() => b.abortHook.aborted, 3_000);
    expect(b.abortHook.aborted).toBe(true);
    expect(b.abortHook.cleanup).toBeGreaterThan(0);
  });

  test('signed revoke-node disconnects B, closes A peer, and /n/B returns 503/401', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const remote = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSid}`;
    const signed = signUserRecord(
      a.keys,
      a.boot.userId,
      a.boot.rootKey,
      'revoke-node',
      encodeRevokeNodePayload({
        node_id: hexToBytes(b.mesh.nodeId),
        reason: 'lost',
      })
    );
    const revoked = await a.mesh.hub?.handleRequest(
      (() => {
        const req = new Request(`http://hub/api/hub/nodes/${b.mesh.nodeId}/revoke`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: b.cookie,
          },
          body: JSON.stringify({
            bytes: encodeBase64url(signed.bytes),
            sig: encodeBase64url(signed.sig),
          }),
        });
        setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
        return req;
      })(),
      dummyServer
    );
    expect(revoked?.status).toBe(200);
    await waitUntil(() => b.mesh.uplink.state !== 'online', 5_000);
    await waitUntil(() => a.mesh.peers.getLive(b.mesh.nodeId) === null, 5_000);
    const again = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect([401, 503]).toContain(again.status);
  });

  test('compromise: A node key cannot obtain B http/ws/relay and cannot forge a session', async () => {
    const a = await bootHubA({ linkFactory: false });
    const b = await enrollNodeB(a, { linkFactory: false });
    const link = await a.mesh.peers.getLink(b.mesh.nodeId);
    expect(a.mesh.peers.transportOf(b.mesh.nodeId)).toBe('relay');
    const http = await openHttpStream(link, {
      type: 'http',
      method: 'GET',
      path: '/api/devices',
      origin: 'http://entry',
      auth: 'forged-sid-not-issued',
    });
    expect(http.status).toBe(401);
    expect(http.status).not.toBe(503);
    const httpBody = (await http.json()) as { error?: string; code?: string };
    expect(httpBody.error ?? httpBody.code).toBe('unknown');

    let wsReset = '';
    try {
      const opened = await openWsStream(link, 'forged-sid-not-issued');
      await Promise.race([
        opened.stream.closed.then(() => {
          wsReset = 'closed';
        }),
        Bun.sleep(1_000).then(() => {
          wsReset = 'timeout';
        }),
      ]);
      opened.close();
    } catch (err) {
      wsReset = err instanceof Error ? err.message : 'error';
    }
    expect(wsReset === 'timeout').toBe(false);

    const sess = generateEd25519KeyPair();
    const ch = await callMesh(b.mesh, 'http://b/api/auth/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: a.boot.userId }),
    });
    expect(ch.status).toBe(200);
    const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
    const login = buildLogin({
      challengeId: body.challenge_id,
      nonce: decodeBase64url(body.nonce),
      target: b.mesh.nodeId,
      targetPk: decodeBase64url(body.nodePk),
      uid: a.boot.userId,
      entry: MESH_VIA_SELF,
    });
    const validDel = createDelegation(a.boot.rootKey, {
      uid: a.boot.userId,
      sessPk: sess.publicKey,
      now: Date.now(),
    });
    const forged = await callMesh(b.mesh, 'http://b/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        login: encodeBase64url(encodeLogin(login)),
        sig: encodeBase64url(signLogin(sess.secretKey, login)),
        delegation: encodeBase64url(validDel.bytes),
        delegation_sig: encodeBase64url(signEd25519(a.mesh.identity.edPrivateKey, validDel.bytes)),
      }),
    });
    expect(forged.status).toBe(401);
    expect(forged.status).not.toBe(503);
    expect(((await forged.json()) as { code?: string }).code).toBe('DELEGATION_BAD_SIGNATURE');
  });

  test('compromise: hub DB cannot mint a credential B accepts; forged node.list is ignored', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const attacker = rootKeyFromSeed(randomBytesSafe(32));
    const forgedAdmit = await a.keys.signAndApply(a.boot.userId, attacker, {
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: randomBytesSafe(40),
        authorization_sig: randomBytesSafe(64),
        certificate_bytes: randomBytesSafe(80),
        cert_sig: randomBytesSafe(64),
      }),
    });
    expect(forgedAdmit.ok).toBe(false);

    const ghostId = 'ff'.repeat(16);
    let dials = 0;
    const probe = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('no', { status: 404 });
      },
      websocket: {
        open() {
          dials += 1;
        },
        message() {},
        close() {},
      },
    });
    fixtures.push({ close: () => probe.stop(true) });
    const list = a.mesh.lastNodeList;
    expect(list).not.toBeNull();
    a.mesh.hub?.uplink.sendTo(a.mesh.nodeId, {
      t: 'node.list',
      version: (list?.version ?? 1) + 100,
      key_log_head: {
        seq: Number(list?.key_log_head.seq ?? 0),
        hash: encodeBase64url(list?.key_log_head.hash ?? new Uint8Array(32)),
      },
      rtc: { stun: list?.rtc.stun ?? [], turn: (list?.rtc.turn as never) ?? null },
      nodes: [
        ...(list?.nodes ?? []).map((n) => ({
          id: n.id,
          name: n.name,
          online: n.online,
          endpoints: n.endpoints,
          inventory: n.inventory,
          direct_capable: n.direct_capable,
          version: n.version,
        })),
        {
          id: ghostId,
          name: 'ghost',
          online: true,
          endpoints: [`ws://127.0.0.1:${probe.port}/peer`],
          inventory: {},
          direct_capable: false,
          version: 'ghost',
        },
      ],
    });
    await waitUntil(() => a.mesh.lastNodeList?.version !== list?.version, 3_000).catch(
      () => undefined
    );
    await Bun.sleep(50);
    expect(a.mesh.userStore.listPeers().some((p) => p.nodeId === ghostId)).toBe(false);
    await expect(a.mesh.peers.getLink(ghostId)).rejects.toMatchObject({ message: 'not admitted' });
    expect(dials).toBe(0);
    const toB = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    expect(toB.status).toBe(200);
  });

  test('compromise: swapped target_pk fails login; DC fingerprint mismatch fails handshake', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const swapped = await loginRemote(
      a.mesh,
      b.mesh,
      a.boot,
      b.cookie,
      a.mesh.identity.edPublicKey
    );
    expect(swapped.ok).toBe(false);

    const fake = createFakeNativeModule({
      remoteFingerprintOverride: { algorithm: 'sha-256', value: 'DE:AD:BE:EF' },
    });
    const left = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity: { nodeId: a.mesh.nodeId, edSecretKey: a.mesh.identity.edPrivateKey },
      userStore: a.mesh.userStore,
      handshakeTimeoutMs: 1_000,
    });
    const right = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: () => ({ stun: [], turn: null }),
      identity: { nodeId: b.mesh.nodeId, edSecretKey: b.mesh.identity.edPrivateKey },
      userStore: b.mesh.userStore,
      handshakeTimeoutMs: 1_000,
    });
    const aCbs: Array<(msg: never) => void> = [];
    const bCbs: Array<(msg: never) => void> = [];
    const results = await Promise.allSettled([
      left.connectToPeer(b.mesh.nodeId, {
        send: (msg) => {
          for (const cb of bCbs) cb(msg as never);
        },
        onMessage: (cb) => {
          aCbs.push(cb as never);
        },
      }),
      right.connectToPeer(a.mesh.nodeId, {
        send: (msg) => {
          for (const cb of aCbs) cb(msg as never);
        },
        onMessage: (cb) => {
          bCbs.push(cb as never);
        },
      }),
    ]);
    expect(results.some((row) => row.status === 'rejected')).toBe(true);
    left.close();
    right.close();
  });
});

function randomBytesSafe(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function concatCaptured(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || hay.byteLength < needle.byteLength) return false;
  outer: for (let i = 0; i <= hay.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function containsAcrossChunks(chunks: Uint8Array[], needle: Uint8Array): boolean {
  if (containsBytes(concatCaptured(chunks), needle)) return true;
  for (let i = 0; i < chunks.length - 1; i++) {
    const window = concatCaptured(chunks.slice(i, i + 2));
    if (containsBytes(window, needle)) return true;
  }
  return false;
}

async function decryptInitiatorFrames(
  sendKey: Uint8Array,
  chunks: Uint8Array[]
): Promise<Uint8Array> {
  const encrypted: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (chunk.byteLength > 0 && chunk[0] === 0x7b) continue;
    encrypted.push(chunk);
  }
  const decoder = new FrameDecoder({ maxPayload: 1_048_576 + GCM_TAG_LENGTH });
  const key = await crypto.subtle.importKey(
    'raw',
    sendKey as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const parts: Uint8Array[] = [];
  let counter = 0n;
  for (const chunk of encrypted) {
    const frames = decoder.push(chunk);
    for (const frame of frames) {
      const header = encodeFrameHeader(
        frame.streamId,
        frame.op,
        frame.flags,
        frame.payload.byteLength
      );
      const nonce = buildAesGcmNonce(SC_DIRECTION_INITIATOR, counter);
      counter += 1n;
      try {
        const plain = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: nonce as unknown as BufferSource,
              additionalData: header as unknown as BufferSource,
              tagLength: 128,
            },
            key,
            frame.payload as unknown as BufferSource
          )
        );
        parts.push(plain);
      } catch {
        // not a matching frame
      }
    }
  }
  return concatCaptured(parts);
}
