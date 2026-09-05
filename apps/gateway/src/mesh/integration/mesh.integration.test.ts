import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  DELEGATION_TTL_MS,
  DOMAIN_DELEGATION,
  buildLogin,
  createDelegation,
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeDelegation,
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
import { encodeRedeemPopMessage } from '../../hub/redeem-pop';
import type { GatewayRuntime } from '../../runtime';
import type { DeviceSessionRuntime } from '../../tmux-client/device-session-runtime';
import { WebSocketServer } from '../../ws';
import {
  MESH_FORWARD_WS_KIND,
  MESH_VIA_SELF,
  X_TMEX_SET_SESSION,
  setMeshRequestContext,
} from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { RtcPeerManager } from '../rtc';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { setShareAccessVerifier } from '../share-credential';
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

function setCookieNames(res: Response): string[] {
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) return cookies.map((c) => c.split('=')[0] ?? '');
  const header = res.headers.get('set-cookie');
  return header ? [header.split(';')[0]?.split('=')[0] ?? ''] : [];
}

async function loginWithKeys(
  entry: MeshRuntime,
  target: MeshRuntime,
  boot: { userId: string },
  sess: ReturnType<typeof generateEd25519KeyPair>,
  del: ReturnType<typeof createDelegation>,
  cookie?: string
): Promise<Response> {
  const remote = entry.nodeId !== target.nodeId;
  const chUrl = remote
    ? `http://entry/n/${target.nodeId}/api/auth/challenge`
    : 'http://entry/api/auth/challenge';
  const loginUrl = remote
    ? `http://entry/n/${target.nodeId}/api/auth/login`
    : 'http://entry/api/auth/login';
  const ch = await callMesh(entry, chUrl, {
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
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: remote ? entry.nodeId : MESH_VIA_SELF,
  });
  return callMesh(entry, loginUrl, {
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
        roles: { hub: true, node: true, relay: false },
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
    opts?: {
      linkFactory?: boolean;
      loadNative?: () => Promise<unknown>;
      admitBeforeCopy?: boolean;
      passUserId?: boolean;
    }
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

    const admitPayload = encodeAdmitNodePayload({
      authorization_bytes: enrollment.authorizationBytes,
      authorization_sig: enrollment.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    });
    const admitBeforeCopy = opts?.admitBeforeCopy !== false;
    if (admitBeforeCopy) {
      const admitted = await a.keys.signAndApply(a.boot.userId, a.boot.rootKey, {
        type: 'admit-node',
        payload: admitPayload,
      });
      expect(admitted.ok).toBe(true);
    }

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
    if (!admitBeforeCopy) {
      const admitted = await a.keys.signAndApply(a.boot.userId, a.boot.rootKey, {
        type: 'admit-node',
        payload: admitPayload,
      });
      expect(admitted.ok).toBe(true);
    }

    const holderA: { mesh: MeshRuntime | null } = { mesh: a.mesh };
    const mesh = await createMeshRuntime({
      db,
      gateway,
      ...(opts?.passUserId === false ? {} : { userId: a.boot.userId }),
      config: {
        roles: { hub: false, node: true, relay: false },
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
      db,
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

  test('node joins twice (second enrollment) and stays reachable', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const remote = await loginRemote(a.mesh, b.mesh, a.boot, b.cookie);
    expect(remote.status).toBe(200);
    const bSid = sidFromResponse(remote, b.mesh.nodeId);
    const jar = `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSid}`;
    const before = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect(before.status).toBe(200);

    const now = Date.now();
    const enrollment = await createEnrollment(a.boot.rootKey, {
      uid: a.boot.userId,
      rootEpoch: a.boot.rootEpoch,
      now,
      ttlMs: 60_000,
    });
    const created = await a.mesh.hub?.handleRequest(
      (() => {
        const req = new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: b.cookie,
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
    const createdBody = (await created?.json()) as { id: string };

    const originalCert = a.userStore.getCert(b.mesh.nodeId);
    expect(originalCert).not.toBeNull();
    if (!originalCert) throw new Error('expected admitted cert for node B');
    const cert = createNodeCertificate(enrollment.enrollSk, {
      uid: a.boot.userId,
      edPk: b.identity.edPublicKey,
      x25519Pk: b.identity.x25519PublicKey,
      enrollPk: enrollment.enrollPk,
      now,
      nodeId: b.identity.nodeId,
    });
    const redeemed = await a.mesh.hub?.handleRequest(
      new Request('http://hub/api/hub/enrollments/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          certificate: encodeBase64url(cert.certificateBytes),
          cert_sig: encodeBase64url(cert.certSig),
          name: 'node-b',
          version: 'test-rejoin',
          pop: encodeBase64url(
            signEd25519(
              b.identity.edPrivateKey,
              encodeRedeemPopMessage({
                enrollmentId: encodeBase64url(enrollment.enrollPk),
                nodeId: b.identity.nodeId,
                certBytes: cert.certificateBytes,
              })
            )
          ),
        }),
      }),
      dummyServer
    );
    expect(redeemed?.status).toBe(200);
    const redeemedBody = (await redeemed?.json()) as {
      already_admitted?: boolean;
      node_certs: Array<{ node_id: string; certificate: string }>;
    };
    expect(redeemedBody.already_admitted).toBe(true);
    expect(redeemedBody.node_certs.find((c) => c.node_id === b.mesh.nodeId)?.certificate).toBe(
      encodeBase64url(originalCert.certificateBytes)
    );
    const enrollGet = await a.mesh.hub?.handleRequest(
      (() => {
        const req = new Request(`http://hub/api/hub/enrollments/${createdBody.id}`, {
          headers: { cookie: b.cookie },
        });
        setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
        return req;
      })(),
      dummyServer
    );
    expect(enrollGet?.status).toBe(200);
    const enrollStatus = (await enrollGet?.json()) as {
      already_admitted?: boolean;
      certificate?: string;
    };
    expect(enrollStatus.already_admitted).toBe(true);
    expect(enrollStatus.certificate).toBe(encodeBase64url(originalCert.certificateBytes));
    expect(a.userStore.getCert(b.mesh.nodeId)?.certificateBytes).toEqual(
      originalCert.certificateBytes
    );
    expect(
      a.userStore.listCertsByUser(a.boot.userId).filter((c) => c.nodeId === b.mesh.nodeId)
    ).toHaveLength(1);

    expect(a.userStore.listNodes().filter((n) => n.id === b.mesh.nodeId)).toHaveLength(1);
    expect(a.mesh.hub?.registry.get(b.mesh.nodeId)?.authenticated).toBe(true);
    await waitUntil(() => b.mesh.uplink.state === 'online', 5_000);

    const after = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ devices: [{ id: 'dev-b', name: 'B box' }] });
  });

  test('revoked node identity cannot re-join; redeem returns node_revoked', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
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
    // 撤销的产品路径是 key-log：entry 节点 POST /api/auth/keylog?hub=sync，
    // 先等 hub ack 再本地 append，hub 侧的 append effects 负责踢连接与广播。
    const revoked = await callMesh(a.mesh, 'http://entry/api/auth/keylog?hub=sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: b.cookie,
      body: JSON.stringify({
        bytes: encodeBase64url(signed.bytes),
        sig: encodeBase64url(signed.sig),
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ ok: true, hubAck: true });
    expect(a.userStore.getCert(b.mesh.nodeId)?.revokedLogSeq).not.toBeNull();

    const now = Date.now();
    const enrollment = await createEnrollment(a.boot.rootKey, {
      uid: a.boot.userId,
      rootEpoch: a.boot.rootEpoch,
      now,
      ttlMs: 60_000,
    });
    const created = await a.mesh.hub?.handleRequest(
      (() => {
        const req = new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: b.cookie,
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
      edPk: b.identity.edPublicKey,
      x25519Pk: b.identity.x25519PublicKey,
      enrollPk: enrollment.enrollPk,
      now,
      nodeId: b.identity.nodeId,
    });
    const redeemed = await a.mesh.hub?.handleRequest(
      new Request('http://hub/api/hub/enrollments/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          certificate: encodeBase64url(cert.certificateBytes),
          cert_sig: encodeBase64url(cert.certSig),
          name: 'node-b',
          pop: encodeBase64url(
            signEd25519(
              b.identity.edPrivateKey,
              encodeRedeemPopMessage({
                enrollmentId: encodeBase64url(enrollment.enrollPk),
                nodeId: b.identity.nodeId,
                certBytes: cert.certificateBytes,
              })
            )
          ),
        }),
      }),
      dummyServer
    );
    expect(redeemed?.status).toBe(409);
    expect(await redeemed?.json()).toEqual({ error: 'node_revoked' });
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
        clientVersion: '1.1.23',
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
    const openPlain = new TextEncoder().encode('{"type":"http"');
    const pathPlain = new TextEncoder().encode('/api/devices');
    const devicesPlain = new TextEncoder().encode('dev-b');
    expect(containsBytes(joined, openPlain)).toBe(false);
    expect(containsBytes(joined, pathPlain)).toBe(false);
    expect(containsBytes(joined, devicesPlain)).toBe(false);
    expect(containsAcrossChunks(captured, pathPlain)).toBe(false);
    expect(containsAcrossChunks(captured, openPlain)).toBe(false);
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
    // 撤销的产品路径是 key-log：entry 节点 POST /api/auth/keylog?hub=sync，
    // 先等 hub ack 再本地 append，hub 侧的 append effects 负责踢连接与广播。
    const revoked = await callMesh(a.mesh, 'http://entry/api/auth/keylog?hub=sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cookie: b.cookie,
      body: JSON.stringify({
        bytes: encodeBase64url(signed.bytes),
        sig: encodeBase64url(signed.sig),
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ ok: true, hubAck: true });
    await waitUntil(() => b.mesh.uplink.state !== 'online', 5_000);
    await waitUntil(() => a.mesh.peers.getLive(b.mesh.nodeId) === null, 5_000);
    const again = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect([401, 503]).toContain(again.status);
  });

  test('SSO: same delegation+sess key logs into B with only tmex_s_<B>', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const sess = generateEd25519KeyPair();
    const del = createDelegation(a.boot.rootKey, {
      uid: a.boot.userId,
      sessPk: sess.publicKey,
      now: Date.now(),
    });
    const toA = await loginWithKeys(a.mesh, a.mesh, a.boot, sess, del);
    expect(toA.status).toBe(200);
    const toB = await loginWithKeys(a.mesh, b.mesh, a.boot, sess, del, b.cookie);
    expect(toB.status).toBe(200);
    const names = setCookieNames(toB);
    expect(names).toContain(nodeSessionCookieName(b.mesh.nodeId));
    expect(names).not.toContain(nodeSessionCookieName(MESH_VIA_SELF));
    expect(names).not.toContain(nodeSessionCookieName(a.mesh.nodeId));
    expect(toB.headers.get(X_TMEX_SET_SESSION)).toBeNull();
    expect(sidFromResponse(toB, b.mesh.nodeId).length).toBeGreaterThan(8);
  });

  test('SSO: Login bound to A is rejected by B', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const sess = generateEd25519KeyPair();
    const del = createDelegation(a.boot.rootKey, {
      uid: a.boot.userId,
      sessPk: sess.publicKey,
      now: Date.now(),
    });
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
      target: a.mesh.nodeId,
      targetPk: a.mesh.identity.edPublicKey,
      uid: a.boot.userId,
      entry: MESH_VIA_SELF,
    });
    const forged = await callMesh(b.mesh, 'http://b/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        login: encodeBase64url(encodeLogin(login)),
        sig: encodeBase64url(signLogin(sess.secretKey, login)),
        delegation: encodeBase64url(del.bytes),
        delegation_sig: encodeBase64url(del.sig),
      }),
    });
    expect(forged.status).toBe(401);
    expect(((await forged.json()) as { code?: string }).code).toBe('TARGET_MISMATCH');
  });

  test("SSO: A's session id as B's cookie is rejected by B", async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const bSelfSid = await loginSelf(b.mesh, a.boot);
    const res = await callMesh(a.mesh, `http://entry/n/${b.mesh.nodeId}/api/devices`, {
      cookie: `${b.cookie}; ${nodeSessionCookieName(b.mesh.nodeId)}=${bSelfSid}`,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe('via_mismatch');
  });

  test('SSO: delegation TTL other than DELEGATION_TTL_MS is rejected', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const sess = generateEd25519KeyPair();
    const issuedAt = BigInt(Date.now());
    const delegation = {
      domain: DOMAIN_DELEGATION,
      uid: a.boot.userId,
      sess_pk: sess.publicKey,
      issued_at: issuedAt,
      exp: issuedAt + BigInt(DELEGATION_TTL_MS) + 1n,
      method: 'root' as const,
      credential_id: null,
    };
    const bytes = encodeDelegation(delegation);
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
    const res = await callMesh(b.mesh, 'http://b/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        login: encodeBase64url(encodeLogin(login)),
        sig: encodeBase64url(signLogin(sess.secretKey, login)),
        delegation: encodeBase64url(bytes),
        delegation_sig: encodeBase64url(a.boot.rootKey.sign(bytes)),
      }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe('DELEGATION_INVALID_TTL');
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
    expect(((await forged.json()) as { code?: string }).code).toBe('INVALID_CREDENTIALS');
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
          return () => {
            const idx = aCbs.indexOf(cb as never);
            if (idx >= 0) aCbs.splice(idx, 1);
          };
        },
      }),
      right.connectToPeer(a.mesh.nodeId, {
        send: (msg) => {
          for (const cb of aCbs) cb(msg as never);
        },
        onMessage: (cb) => {
          bCbs.push(cb as never);
          return () => {
            const idx = bCbs.indexOf(cb as never);
            if (idx >= 0) bCbs.splice(idx, 1);
          };
        },
      }),
    ]);
    expect(results.some((row) => row.status === 'rejected')).toBe(true);
    left.close();
    right.close();
  });

  test('already-uplinked node A learns late-joining node B, hub_meta, and can login via /n/B', async () => {
    const hub = await bootHubA({ linkFactory: false });
    const nodeA = await enrollNodeB(hub, { linkFactory: false });
    const sidA = await loginSelf(nodeA.mesh, hub.boot);
    const cookieA = `${nodeSessionCookieName(MESH_VIA_SELF)}=${sidA}`;

    const nodeB = await enrollNodeB(hub, { linkFactory: false });

    await waitUntil(() => nodeA.mesh.userStore.getCert(nodeB.mesh.nodeId) != null, 8_000);
    await waitUntil(() => nodeA.mesh.userStore.getHubMeta()?.nodeId === hub.mesh.nodeId, 8_000);

    const mode = await callMesh(nodeA.mesh, 'http://a/api/auth/mode');
    expect(mode.status).toBe(200);
    const modeBody = (await mode.json()) as { hubNodeId: string | null };
    expect(modeBody.hubNodeId).toBe(hub.mesh.nodeId);

    const listed = await callMesh(nodeA.mesh, 'http://a/api/mesh/nodes', { cookie: cookieA });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      nodes: Array<{ id: string; online: boolean; isHub: boolean }>;
    };
    const hubRow = body.nodes.find((n) => n.id === hub.mesh.nodeId);
    const bRow = body.nodes.find((n) => n.id === nodeB.mesh.nodeId);
    expect(hubRow?.isHub).toBe(true);
    expect(bRow?.online).toBe(true);

    const remote = await loginRemote(nodeA.mesh, nodeB.mesh, hub.boot, cookieA);
    expect(remote.status).toBe(200);
    const bSid = sidFromResponse(remote, nodeB.mesh.nodeId);
    const jar = `${cookieA}; ${nodeSessionCookieName(nodeB.mesh.nodeId)}=${bSid}`;
    const devices = await callMesh(nodeA.mesh, `http://a/n/${nodeB.mesh.nodeId}/api/devices`, {
      cookie: jar,
    });
    expect(devices.status).toBe(200);
    expect(await devices.json()).toEqual({ devices: [{ id: 'dev-b', name: 'B box' }] });

    await nodeA.mesh.stop();
    const restarted = await createMeshRuntime({
      db: nodeA.db,
      gateway: fakeGateway(nodeA.db, { devicesBody: { devices: [{ id: 'dev-a' }] } }),
      userId: hub.boot.userId,
      config: {
        roles: { hub: false, node: true, relay: false },
        hubUrl: 'http://hub.example',
        peerPort: 39013,
        stunServers: [],
      },
      uplinkHub: hub.mesh.hub ?? undefined,
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative: async () => null,
    });
    fixtures.push({ close: nodeA.close, stop: () => restarted.stop() });
    expect(restarted.userStore.getHubMeta()?.nodeId).toBe(hub.mesh.nodeId);
    expect(restarted.userStore.getCert(nodeB.mesh.nodeId)).not.toBeNull();
    expect(restarted.userStore.listPeers().some((row) => row.nodeId === nodeB.mesh.nodeId)).toBe(
      true
    );
    await restarted.start();
    await waitUntil(() => restarted.uplink.state === 'online', 5_000);
    const mode2 = await callMesh(restarted, 'http://a/api/auth/mode');
    expect(((await mode2.json()) as { hubNodeId: string | null }).hubNodeId).toBe(hub.mesh.nodeId);
  }, 30_000);

  test('分享连接：/n/B/ws 用分享 cookie 建流，B 端终止后浏览器收到 4410', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const scope = { shareId: 'sh-1', deviceId: 'dev-b', windowId: 'win-1' };
    setShareAccessVerifier((token) =>
      token === 'sh-1.secret' ? { scope, accessId: 'acc-1', expiresAt: 9e12 } : null
    );
    try {
      const upgraded: { data?: Record<string, unknown> } = {};
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          upgraded.data = (opts?.data ?? {}) as Record<string, unknown>;
          return true;
        },
      };
      const req = new Request(`http://entry/n/${b.mesh.nodeId}/ws`, {
        headers: {
          cookie: `tmex_sh_${b.mesh.nodeId}=sh-1.secret`,
          upgrade: 'websocket',
          connection: 'Upgrade',
        },
      });
      setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
      expect(await a.mesh.handleRequest(req, server)).toBeUndefined();
      expect(upgraded.data?.kind).toBe(MESH_FORWARD_WS_KIND);
      expect(upgraded.data?.auth).toBe('share:sh-1.secret');

      const sent: Uint8Array[] = [];
      const closes: Array<{ code?: number; reason?: string }> = [];
      const ws = {
        data: upgraded.data,
        send(bytes: Uint8Array | string) {
          if (typeof bytes !== 'string') sent.push(bytes);
          return typeof bytes === 'string' ? bytes.length : bytes.byteLength;
        },
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
      };
      a.mesh.websocket.open(ws as never);
      const hello = wsBorsh.encodeEnvelope(
        wsBorsh.KIND_HELLO_C2S,
        wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
          clientImpl: 'test',
          clientVersion: '1.1.23',
          maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
          supportsCompression: false,
          supportsDiffSnapshot: false,
        }),
        1
      );
      a.mesh.websocket.message(ws as never, Buffer.from(hello));
      await waitUntil(() => sent.length > 0, 3_000);
      await waitUntil(() => b.wsServer.countShareSessions('sh-1') === 1, 3_000);

      expect(b.wsServer.closeShareSessions('sh-1')).toBe(1);
      await waitUntil(() => closes.length > 0, 3_000);
      expect(closes[0]).toEqual({ code: 4410, reason: 'SHARE_ENDED' });
    } finally {
      setShareAccessVerifier(null);
    }
  }, 30_000);

  test('分享连接：凭证绑定的分享与页面不符时，浏览器收到 4401 而不是 failover', async () => {
    const a = await bootHubA();
    const b = await enrollNodeB(a);
    const scope = { shareId: 'sh-1', deviceId: 'dev-b', windowId: 'win-1' };
    setShareAccessVerifier((token) =>
      token === 'sh-1.secret' ? { scope, accessId: 'acc-1', expiresAt: 9e12 } : null
    );
    try {
      const upgraded: { data?: Record<string, unknown> } = {};
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          upgraded.data = (opts?.data ?? {}) as Record<string, unknown>;
          return true;
        },
      };
      const req = new Request(`http://entry/n/${b.mesh.nodeId}/ws?share=sh-2`, {
        headers: {
          cookie: `tmex_sh_${b.mesh.nodeId}=sh-1.secret`,
          upgrade: 'websocket',
          connection: 'Upgrade',
        },
      });
      setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
      expect(await a.mesh.handleRequest(req, server)).toBeUndefined();
      expect(upgraded.data?.auth).toBe('share:sh-1.secret');

      const closes: Array<{ code?: number; reason?: string }> = [];
      const ws = {
        data: upgraded.data,
        send: (bytes: Uint8Array | string) =>
          typeof bytes === 'string' ? bytes.length : bytes.byteLength,
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
      };
      a.mesh.websocket.open(ws as never);
      await waitUntil(() => closes.length > 0, 5_000);
      expect(closes[0]).toEqual({ code: 4401, reason: 'SHARE_LOGIN_REQUIRED' });
      expect(b.wsServer.countShareSessions('sh-1')).toBe(0);
    } finally {
      setShareAccessVerifier(null);
    }
  }, 30_000);

  test('redeem-before-admit node catch-up applies own cert without explicit userId', async () => {
    const hub = await bootHubA({ linkFactory: false });
    const node = await enrollNodeB(hub, {
      linkFactory: false,
      admitBeforeCopy: false,
      passUserId: false,
    });
    expect(node.mesh.uplink.userId).toBe(hub.boot.userId);
    await waitUntil(() => node.mesh.userStore.getCert(node.mesh.nodeId) != null, 8_000);
    expect(node.mesh.userStore.getCert(hub.mesh.nodeId)).not.toBeNull();
  }, 30_000);
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
