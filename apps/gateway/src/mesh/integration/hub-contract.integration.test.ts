import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  buildKeyLogRecord,
  buildLogin,
  createDelegation,
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodeLogin,
  generateEd25519KeyPair,
  signKeyLogRecordWithRoot,
  signLogin,
} from '@tmex/shared/auth';
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
import type { GatewayRuntime } from '../../runtime';
import type { WebSocketServer } from '../../ws';
import {
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshServerWebSocket,
  setMeshRequestContext,
} from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { waitUntil } from '../test-support';

const PASSWORD = 'tmex-test';
const dummyServer = { upgrade: () => false };

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

function sidFromResponse(res: Response): string {
  const cookies = res.headers.getSetCookie?.() ?? [];
  const prefix = `${nodeSessionCookieName(MESH_VIA_SELF)}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      return cookie.slice(prefix.length).split(';')[0] ?? '';
    }
  }
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${nodeSessionCookieName(MESH_VIA_SELF)}=([^;]*)`));
  if (match?.[1]) return match[1];
  throw new Error(`no session cookie: ${header}`);
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
  return sidFromResponse(res);
}

function openMeshWs(
  mesh: MeshRuntime,
  sid: string,
  uid: string,
  frames: Uint8Array[]
): MeshServerWebSocket {
  const ws = {
    data: { kind: MESH_WS_KIND, sid, uid },
    send(d: Uint8Array) {
      frames.push(d);
      return d.byteLength;
    },
    close() {},
  } as MeshServerWebSocket;
  mesh.websocket.open(ws);
  return ws;
}

describe('hub contract production wiring', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('createMeshRuntime wires hub meta, hub=sync, and targeted ENROLL_REDEEMED', async () => {
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
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      userId: boot.userId,
      config: {
        roles: { hub: true, node: true },
        hubUrl: null,
        hubPublicUrl: 'http://hub.example',
        peerPort: 0,
        stunServers: [],
      },
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative: async () => null,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    await waitUntil(() => mesh.uplink.state === 'online', 5_000);
    await waitUntil(() => mesh.lastNodeList !== null, 5_000);
    expect(mesh.lastNodeList?.hub).toEqual({
      nodeId: mesh.nodeId,
      publicUrl: 'http://hub.example',
    });

    const mode = await callMesh(mesh, 'http://hub/api/auth/mode');
    const modeBody = (await mode.json()) as {
      hubNodeId: string | null;
      hubPublicUrl: string | null;
    };
    expect(modeBody.hubNodeId).toBe(mesh.nodeId);
    expect(modeBody.hubPublicUrl).toBe('http://hub.example');

    const sidCreator = await loginSelf(mesh, boot);
    const sidOther = await loginSelf(mesh, boot);
    const creatorFrames: Uint8Array[] = [];
    const otherFrames: Uint8Array[] = [];
    openMeshWs(mesh, sidCreator, boot.userId, creatorFrames);
    openMeshWs(mesh, sidOther, boot.userId, otherFrames);

    const now = Date.now();
    const enrollment = await createEnrollment(boot.rootKey, {
      uid: boot.userId,
      rootEpoch: boot.rootEpoch,
      now,
      ttlMs: 60_000,
    });
    const created = await mesh.hub?.handleRequest(
      (() => {
        const req = new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${nodeSessionCookieName(MESH_VIA_SELF)}=${sidCreator}`,
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

    const joining = generateEd25519KeyPair();
    const cert = createNodeCertificate(enrollment.enrollSk, {
      uid: boot.userId,
      edPk: joining.publicKey,
      x25519Pk: joining.publicKey,
      enrollPk: enrollment.enrollPk,
      now,
    });
    const redeemed = await mesh.hub?.handleRequest(
      new Request('http://hub/api/hub/enrollments/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          certificate: encodeBase64url(cert.certificateBytes),
          cert_sig: encodeBase64url(cert.certSig),
          name: 'joining',
        }),
      }),
      dummyServer
    );
    expect(redeemed?.status).toBe(200);
    await waitUntil(() => creatorFrames.length > 0, 3_000);
    expect(otherFrames).toHaveLength(0);
    const env = wsBorsh.decodeEnvelope(creatorFrames[0] ?? new Uint8Array());
    expect(env.kind).toBe(wsBorsh.KIND_ENROLL_REDEEMED);

    const state = keys.currentState(boot.userId);
    const rec = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: boot.userId,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(rec);
    const sig = signKeyLogRecordWithRoot(boot.rootKey, bytes);
    const synced = await callMesh(mesh, 'http://hub/api/auth/keylog?hub=sync', {
      method: 'POST',
      cookie: `${nodeSessionCookieName(MESH_VIA_SELF)}=${sidCreator}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bytes: encodeBase64url(bytes),
        sig: encodeBase64url(sig),
      }),
    });
    expect(synced.status).toBe(200);
    const syncedBody = (await synced.json()) as { ok: boolean; hubAck: boolean };
    expect(syncedBody.ok).toBe(true);
    expect(syncedBody.hubAck).toBe(true);
  });
});
