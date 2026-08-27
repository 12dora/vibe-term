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
import { WebSocketServer } from '../../ws';
import { GatewaySession } from '../../ws/gateway-session';
import { createFakeCarrier } from '../../ws/test-helpers';
import { MESH_VIA_SELF, MESH_WS_KIND, setMeshRequestContext } from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { SESS_CHANNEL_LABEL } from '../rtc';
import { type FakePeerConnection, createFakeNativeModule } from '../rtc/test-fakes';
import { waitUntil } from '../test-support';

const PASSWORD = 'tmex-test';
const dummyServer = { upgrade: () => false };

function fakeGateway(db: AuthDb, wsServer?: WebSocketServer): GatewayRuntime {
  const server = wsServer ?? new WebSocketServer();
  return {
    port: 0,
    db,
    wsServer: server,
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
    const sid = await loginSelf(mesh, boot);
    const cookie = `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;

    const primary = createFakeCarrier();
    const session = new GatewaySession({ primary });
    mesh.registerGatewaySession({ sid, uid: boot.userId, via: MESH_VIA_SELF, session });

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
    expect(primary.sent.length).toBeGreaterThan(0);
    const switchEnv = wsBorsh.decodeEnvelope(primary.sent[0] as Uint8Array);
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

    const bulk = browserPc.createDataChannel('bulk:xfer-1');
    await new Promise<void>((resolve) => {
      bulk.onOpen(() => resolve());
      if (bulk.isOpen()) resolve();
    });
    const bulkReplies: string[] = [];
    bulk.onMessage((msg) => {
      bulkReplies.push(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
    });
    bulk.sendMessage(JSON.stringify({ op: 'put', transferId: 'xfer-1', size: 1 }));
    await waitUntil(() => bulkReplies.length > 0, 2_000);
    expect(bulkReplies.some((row) => row.includes('not_found') || row.includes('ok'))).toBe(true);
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
