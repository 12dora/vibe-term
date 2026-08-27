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
  generateEd25519KeyPair,
  normalizeFingerprint,
  signLogin,
} from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { filesBulkHooks } from '../../api/files';
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
import { createUploadSession, removeUploadSession } from '../../files/transfer-session';
import type { GatewayRuntime } from '../../runtime';
import { WebSocketServer } from '../../ws';
import type { GatewaySession } from '../../ws/gateway-session';
import {
  MESH_VIA_SELF,
  MESH_WS_KIND,
  X_TMEX_CONNECTION,
  setMeshRequestContext,
} from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { SESS_CHANNEL_LABEL } from '../rtc';
import { fragmentFrame } from '../rtc/fragmenter';
import { type FakePeerConnection, createFakeNativeModule } from '../rtc/test-fakes';
import { acceptWsStream, openWsStream } from '../stream-targets';
import { waitUntil } from '../test-support';
import { requestDispatchContext } from '../types';

const PASSWORD = 'tmex-test';
const dummyServer = { upgrade: () => false };

const origGetTransferOwner = filesBulkHooks.getTransferOwner;
const transferUids = new Map<string, string>();

function fakeGateway(db: AuthDb, wsServer?: WebSocketServer): GatewayRuntime {
  const server = wsServer ?? new WebSocketServer();
  return {
    port: 0,
    db,
    wsServer: server,
    handleRequest: () => undefined,
    dispatchHttp: async (req, ctx) => {
      requestDispatchContext.set(req, { uid: ctx.uid ?? '', viaNodeId: ctx.viaNodeId });
      const path = new URL(req.url).pathname;
      if (path === '/api/files/upload/init' && req.method === 'POST') {
        const body = (await req.json()) as {
          rootId?: string;
          path?: string;
          name?: string;
          size?: number;
        };
        const session = createUploadSession({
          rootId: body.rootId ?? 'r',
          destDir: body.path ?? '/d',
          name: body.name ?? 'a.bin',
          size: typeof body.size === 'number' ? body.size : 1,
        });
        transferUids.set(session.id, ctx.uid ?? '');
        return new Response(JSON.stringify({ uploadId: session.id, chunkSize: 8192 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not-found', { status: 404 });
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
  throw new Error('no session cookie');
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
  if (!(res instanceof Response)) throw new Error(`unhandled ${url}`);
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

describe('direct path integration', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    filesBulkHooks.getTransferOwner = origGetTransferOwner;
    for (const id of transferUids.keys()) {
      try {
        removeUploadSession(id);
      } catch {
        // already gone
      }
    }
    transferUids.clear();
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('browser authorize → signaling → sess nonce → CARRIER_SWITCH → frames and bulk', async () => {
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
    const fake = createFakeNativeModule();
    const wsServer = new WebSocketServer();
    const gateway = fakeGateway(db, wsServer);
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
      loadNative: async () => fake.module,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    await waitUntil(() => mesh.uplink.state === 'online', 5_000);
    filesBulkHooks.getTransferOwner = (id) => {
      const owner = origGetTransferOwner(id);
      if (!owner) return null;
      const uid = transferUids.get(id);
      return uid != null ? { ...owner, uid } : owner;
    };

    const sid = await loginSelf(mesh, boot);
    const cookie = `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;
    const sessionStore = new NodeSessionStore(db);
    const [linkA, linkB] = createInMemoryLinkPair();
    const [linkA2, linkB2] = createInMemoryLinkPair();
    const openedSessions: GatewaySession[] = [];
    const accept = (stream: import('@tmex/shared/link').LinkStream) => {
      void acceptWsStream(stream, {
        peerNodeId: MESH_VIA_SELF,
        sessionStore,
        wsServer,
        onGatewaySession: (session, auth) => {
          mesh.registerGatewaySession({ ...auth, session });
          openedSessions.push(session);
        },
      });
    };
    linkB.onStream(accept);
    linkB2.onStream(accept);
    const openedA = await openWsStream(linkA, sid, 'tab-a');
    const openedB = await openWsStream(linkA2, sid, 'tab-b');
    await waitUntil(() => openedSessions.length >= 2, 3_000);
    const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'direct-path-test',
      clientVersion: 'test',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    await openedA.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1));
    await openedB.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1));
    const session = openedSessions[0] as GatewaySession;
    const sessionB = openedSessions[1] as GatewaySession;
    expect(session.id).not.toBe(sessionB.id);

    const listed = await callMesh(mesh, 'http://entry/api/mesh/connection', { cookie });
    expect(listed.status).toBe(409);
    const listedA = await callMesh(mesh, 'http://entry/api/mesh/connection', {
      cookie,
      headers: { [X_TMEX_CONNECTION]: 'tab-a' },
    });
    expect(listedA.status).toBe(200);
    expect(await listedA.json()).toEqual({ connectionId: 'tab-a' });

    const wrongConn = await callMesh(mesh, 'http://entry/api/rtc/authorize', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rtcSession: 'wrong-conn',
        connectionId: 'no-such-tab',
        fp_browser: { algorithm: 'sha-256', value: 'AA' },
      }),
    });
    expect(wrongConn.status).toBe(404);

    const rtcSession = 'browser-direct-1';
    const browserPc = new fake.module.PeerConnection('browser', {
      iceServers: [],
    }) as FakePeerConnection;
    fixtures.push({ close: () => browserPc.close() });

    const meshFrames: Uint8Array[] = [];
    const meshWs = {
      data: { kind: MESH_WS_KIND, sid, uid: boot.userId },
      send(d: Uint8Array) {
        meshFrames.push(d);
        try {
          const env = wsBorsh.decodeEnvelope(d);
          if (env.kind === wsBorsh.KIND_RTC_SIGNAL) {
            const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
            if (payload.sdp) {
              const parsed = JSON.parse(payload.sdp) as { type: string; sdp: string };
              browserPc.setRemoteDescription(parsed.sdp, parsed.type);
            }
            if (payload.candidate) {
              const parsed = JSON.parse(payload.candidate) as { candidate: string; mid: string };
              if (parsed.candidate) browserPc.addRemoteCandidate(parsed.candidate, parsed.mid);
            }
          }
        } catch {
          // ignore non-signal frames
        }
        return d.byteLength;
      },
      close() {},
    };
    mesh.websocket.open(meshWs as never);

    const fpBrowser = normalizeFingerprint(browserPc.fingerprint);
    const authz = await callMesh(mesh, 'http://entry/api/rtc/authorize', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rtcSession,
        connectionId: 'tab-a',
        fp_browser: fpBrowser,
      }),
    });
    expect(authz.status).toBe(200);
    const granted = (await authz.json()) as { nonce: string; fp_node: { value: string } };

    browserPc.onLocalDescription((sdp, type) => {
      const payload = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
        rtcSession,
        from: wsBorsh.RTC_SIGNAL_FROM_BROWSER,
        to: mesh.nodeId,
        sdp: JSON.stringify({ type, sdp }),
        candidate: null,
      });
      const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, payload, 1);
      mesh.websocket.message(meshWs as never, Buffer.from(frame));
    });

    const dc = browserPc.createDataChannel(SESS_CHANNEL_LABEL);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sess open timeout')), 3_000);
      dc.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    dc.sendMessage(JSON.stringify({ nonce: granted.nonce }));

    await waitUntil(() => session.activeCarrier !== session.primary, 3_000);
    expect(sessionB.activeCarrier).toBe(sessionB.primary);
    const reader = openedA.readable.getReader();
    const switchHold: { env: ReturnType<typeof wsBorsh.decodeEnvelope> | null } = { env: null };
    void (async () => {
      while (!switchHold.env) {
        const chunk = await reader.read();
        if (chunk.done || !chunk.value) return;
        try {
          const env = wsBorsh.decodeEnvelope(chunk.value);
          if (env.kind === wsBorsh.KIND_CARRIER_SWITCH) switchHold.env = env;
        } catch {
          // ignore
        }
      }
    })();
    await waitUntil(() => switchHold.env != null, 3_000);
    const switchEnv = switchHold.env;
    if (!switchEnv) throw new Error('missing CARRIER_SWITCH');
    expect(switchEnv.kind).toBe(wsBorsh.KIND_CARRIER_SWITCH);
    const sent = wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchSchema, switchEnv.payload);

    const ackPayload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchAckSchema, {
      epoch: sent.epoch,
      rtcSession,
    });
    wsServer.handleMessage(
      session,
      Buffer.from(wsBorsh.encodeEnvelope(wsBorsh.KIND_CARRIER_SWITCH_ACK, ackPayload, 2))
    );

    const direct = session.activeCarrier;
    expect(direct).not.toBe(session.primary);
    expect(direct.send(new TextEncoder().encode('hello-direct'))).toBe('sent');

    const bound = mesh.sessions.getByConnectionId('tab-a');
    expect(session.closed).toBe(false);
    expect(bound?.via).toBe(MESH_VIA_SELF);
    expect(bound?.sid).toBe(sid);
    expect(sessionStore.verify(sid, { viaNodeId: MESH_VIA_SELF, now: Date.now() }).ok).toBe(true);

    const init = await gateway.dispatchHttp(
      new Request('http://node/api/files/upload/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootId: 'r', path: '/d', name: 'a.bin', size: 1 }),
      }),
      { uid: boot.userId, viaNodeId: MESH_VIA_SELF }
    );
    expect(init.status).toBe(200);
    const { uploadId } = (await init.json()) as { uploadId: string };

    const bulk = browserPc.createDataChannel(`bulk:${uploadId}`);
    await new Promise<void>((resolve) => {
      bulk.onOpen(() => resolve());
      if (bulk.isOpen()) resolve();
    });
    const nodePc = fake.connections.find((pc) => pc !== browserPc);
    expect(nodePc?.inbound.map((dc) => dc.getLabel()) ?? []).toContain(`bulk:${uploadId}`);
    expect(bulk.peer?.getLabel()).toBe(`bulk:${uploadId}`);
    const bulkReplies: string[] = [];
    bulk.onMessage((msg) => {
      bulkReplies.push(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
    });
    const put = JSON.stringify({ op: 'put', transferId: uploadId, size: 1 });
    bulk.sendMessage(put);
    if (bulkReplies.length === 0) bulk.peer?.emitMessage(put);
    await waitUntil(() => bulkReplies.length > 0, 2_000);
    expect(bulkReplies.some((row) => row.includes('permission_denied'))).toBe(false);

    const wrongOwner = await gateway.dispatchHttp(
      new Request('http://node/api/files/upload/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootId: 'r', path: '/d', name: 'b.bin', size: 1 }),
      }),
      { uid: 'other-user', viaNodeId: MESH_VIA_SELF }
    );
    const { uploadId: otherId } = (await wrongOwner.json()) as { uploadId: string };
    const bulkWrong = browserPc.createDataChannel(`bulk:${otherId}`);
    await new Promise<void>((resolve) => {
      bulkWrong.onOpen(() => resolve());
      if (bulkWrong.isOpen()) resolve();
    });
    const wrongReplies: string[] = [];
    bulkWrong.onMessage((msg) => {
      wrongReplies.push(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
    });
    bulkWrong.sendMessage(JSON.stringify({ op: 'put', transferId: otherId, size: 1 }));
    if (wrongReplies.length === 0) {
      bulkWrong.peer?.emitMessage(JSON.stringify({ op: 'put', transferId: otherId, size: 1 }));
    }
    await waitUntil(() => wrongReplies.length > 0, 2_000);
    expect(wrongReplies.some((row) => row.includes('permission_denied'))).toBe(true);

    sessionStore.revoke(sid);
    const ping = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_PING,
      wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, { nonce: 1, timeMs: 0n }),
      9
    );
    for (const part of fragmentFrame(1, ping, 16_384)) {
      dc.sendMessageBinary(Buffer.from(part));
    }
    await waitUntil(() => session.closed, 3_000);
    expect(session.closed).toBe(true);
    expect(dc.closed).toBe(true);
    openedA.close();
    openedB.close();
  }, 15_000);

  test('node↔node DC signaling goes through real HubRuntime/UplinkServer', async () => {
    const fake = createFakeNativeModule();
    const loadNative = async () => fake.module;

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
    const gatewayA = fakeGateway(db);
    const holderB: { mesh: MeshRuntime | null } = { mesh: null };
    const meshA = await createMeshRuntime({
      db,
      gateway: gatewayA,
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
      loadNative,
    });
    fixtures.push({ close, stop: () => meshA.stop() });
    await meshA.start();
    await waitUntil(() => meshA.uplink.state === 'online', 5_000);

    const { db: dbB, close: closeB } = createMigratedAuthDb();
    const identityB = await ensureNodeIdentity(new NodeIdentityStore(dbB));
    const now = Date.now();
    const enrollment = await createEnrollment(boot.rootKey, {
      uid: boot.userId,
      rootEpoch: boot.rootEpoch,
      now,
      ttlMs: 60_000,
    });
    const sid = await loginSelf(meshA, boot);
    const cookie = `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;
    const created = await meshA.hub?.handleRequest(
      (() => {
        const req = new Request('http://hub/api/hub/enrollments', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
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
      uid: boot.userId,
      edPk: identityB.edPublicKey,
      x25519Pk: identityB.x25519PublicKey,
      enrollPk: enrollment.enrollPk,
      now,
      nodeId: identityB.nodeId,
    });
    const redeemed = await meshA.hub?.handleRequest(
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
    const admitted = await keys.signAndApply(boot.userId, boot.rootKey, {
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: enrollment.authorizationBytes,
        authorization_sig: enrollment.authorizationSig,
        certificate_bytes: cert.certificateBytes,
        cert_sig: cert.certSig,
      }),
    });
    expect(admitted.ok).toBe(true);
    const rows = keyLogStore.list(boot.userId);
    const head = keyLogStore.head(boot.userId);
    const bUserStore = new UserStore(dbB);
    const bKeyLog = new KeyLogStore(dbB);
    const bSessions = new NodeSessionStore(dbB);
    const bKeys = new UserKeyService({
      db: dbB,
      userStore: bUserStore,
      keyLogStore: bKeyLog,
      nodeSessionStore: bSessions,
      verifyPasskeyAssertion: makeVerifyPasskeyAssertion(bUserStore),
    });
    const joined = await bKeys.verifyChainForJoin(
      rows.map((row) => ({ bytes: row.bytes, sig: row.sig })),
      boot.rootPublicKey,
      head?.hash ?? new Uint8Array(32)
    );
    expect(joined.ok).toBe(true);

    const meshB = await createMeshRuntime({
      db: dbB,
      gateway: fakeGateway(dbB),
      userId: boot.userId,
      config: {
        roles: { hub: false, node: true },
        hubUrl: 'http://hub.example',
        peerPort: 39002,
        stunServers: [],
      },
      uplinkHub: meshA.hub ?? undefined,
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative,
    });
    fixtures.push({ close: closeB, stop: () => meshB.stop() });
    holderB.mesh = meshB;
    await meshB.start();
    await waitUntil(() => meshB.uplink.state === 'online', 5_000);
    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      5_000
    );

    const [linkA, linkB] = await Promise.all([
      meshA.peers.getLink(meshB.nodeId),
      meshB.peers.getLink(meshA.nodeId),
    ]);
    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');
    expect(meshB.peers.transportOf(meshA.nodeId)).toBe('dc');
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      linkB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"ping"}');
    const out = await linkA.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    out.end();
    inn.end();
  }, 15_000);
});
