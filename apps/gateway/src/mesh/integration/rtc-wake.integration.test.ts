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
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { encodeRtcWakeSdp, peerRtcSession } from '../rtc/ice';
import type { LoadNative } from '../rtc/native';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { waitUntil } from '../test-support';

const PASSWORD = 'tmex-test';
const dummyServer = { upgrade: () => false };

type HubBoot = {
  userId: string;
  rootKey: Parameters<typeof createDelegation>[0];
  rootEpoch: number;
  rootPublicKey: Uint8Array;
};

async function joinEnrolledNode(opts: {
  hub: MeshRuntime;
  boot: HubBoot;
  keys: UserKeyService;
  keyLogStore: KeyLogStore;
  loadNative: LoadNative;
  name: string;
  peerPort: number;
}): Promise<{ mesh: MeshRuntime; close: () => void }> {
  const { db, close } = createMigratedAuthDb();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const now = Date.now();
  const enrollment = await createEnrollment(opts.boot.rootKey, {
    uid: opts.boot.userId,
    rootEpoch: opts.boot.rootEpoch,
    now,
    ttlMs: 60_000,
  });
  const sid = await loginSelf(opts.hub, opts.boot);
  const cookie = `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;
  const created = await opts.hub.hub?.handleRequest(
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
  if (created?.status !== 201) throw new Error(`enroll ${opts.name} failed`);
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid: opts.boot.userId,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk: enrollment.enrollPk,
    now,
    nodeId: identity.nodeId,
  });
  const redeemed = await opts.hub.hub?.handleRequest(
    new Request('http://hub/api/hub/enrollments/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        certificate: encodeBase64url(cert.certificateBytes),
        cert_sig: encodeBase64url(cert.certSig),
        name: opts.name,
        version: 'test',
      }),
    }),
    dummyServer
  );
  if (redeemed?.status !== 200) throw new Error(`redeem ${opts.name} failed`);
  const admitted = await opts.keys.signAndApply(opts.boot.userId, opts.boot.rootKey, {
    type: 'admit-node',
    payload: encodeAdmitNodePayload({
      authorization_bytes: enrollment.authorizationBytes,
      authorization_sig: enrollment.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    }),
  });
  if (!admitted.ok) throw new Error(`admit ${opts.name} failed`);
  const rows = opts.keyLogStore.list(opts.boot.userId);
  const head = opts.keyLogStore.head(opts.boot.userId);
  const userStore = new UserStore(db);
  const keyLog = new KeyLogStore(db);
  const sessions = new NodeSessionStore(db);
  const nodeKeys = new UserKeyService({
    db,
    userStore,
    keyLogStore: keyLog,
    nodeSessionStore: sessions,
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const joined = await nodeKeys.verifyChainForJoin(
    rows.map((row) => ({ bytes: row.bytes, sig: row.sig })),
    opts.boot.rootPublicKey,
    head?.hash ?? new Uint8Array(32)
  );
  if (!joined.ok) throw new Error(`join ${opts.name} failed`);
  const mesh = await createMeshRuntime({
    db,
    gateway: fakeGateway(db),
    userId: opts.boot.userId,
    config: {
      roles: { hub: false, node: true, relay: false },
      hubUrl: 'http://hub.example',
      peerPort: opts.peerPort,
      stunServers: ['stun:stun.example:3478'],
    },
    uplinkHub: opts.hub.hub ?? undefined,
    startPeerServer: false,
    pingIntervalMs: 60_000,
    networkInterfaces: () => ({}),
    loadNative: opts.loadNative,
  });
  return { mesh, close };
}

function fakeGateway(db: AuthDb): GatewayRuntime {
  const wsServer = new WebSocketServer();
  return {
    port: 0,
    db,
    wsServer,
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
  const req = new Request('http://entry/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: boot.userId }),
  });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const ch = await mesh.handleRequest(req, dummyServer);
  if (!(ch instanceof Response)) throw new Error('challenge unhandled');
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: mesh.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: MESH_VIA_SELF,
  });
  const loginReq = new Request('http://entry/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
  setMeshRequestContext(loginReq, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await mesh.handleRequest(loginReq, dummyServer);
  if (!(res instanceof Response)) throw new Error('login unhandled');
  const cookies = res.headers.getSetCookie?.() ?? [];
  const prefix = `${nodeSessionCookieName(MESH_VIA_SELF)}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length).split(';')[0] ?? '';
  }
  throw new Error('no session cookie');
}

describe('rtc wake via authenticated uplink', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('single-sided getLink from the larger id yields dc; forged wakes are rejected', async () => {
    const fake = createFakeNativeModule();
    const loadNative = async () => fake.module;

    const { db, close } = createMigratedAuthDb();
    const identityA = await ensureNodeIdentity(new NodeIdentityStore(db));
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
      identity: identityA,
    });
    const meshA = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      userId: boot.userId,
      config: {
        roles: { hub: true, node: true, relay: false },
        hubUrl: null,
        hubPublicUrl: 'http://hub.example',
        peerPort: 39001,
        stunServers: ['stun:stun.example:3478'],
      },
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative,
    });
    fixtures.push({ close, stop: () => meshA.stop() });
    await meshA.start();
    await waitUntil(() => meshA.uplink.state === 'online', 5_000);

    const joinedB = await joinEnrolledNode({
      hub: meshA,
      boot,
      keys,
      keyLogStore,
      loadNative,
      name: 'node-b',
      peerPort: 39002,
    });
    fixtures.push({ close: joinedB.close, stop: () => joinedB.mesh.stop() });
    const meshB = joinedB.mesh;
    await meshB.start();
    await waitUntil(() => meshB.uplink.state === 'online', 5_000);
    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      5_000
    );

    const joinedC = await joinEnrolledNode({
      hub: meshA,
      boot,
      keys,
      keyLogStore,
      loadNative,
      name: 'node-c',
      peerPort: 39003,
    });
    fixtures.push({ close: joinedC.close, stop: () => joinedC.mesh.stop() });
    const meshC = joinedC.mesh;
    await meshC.start();
    await waitUntil(() => meshC.uplink.state === 'online', 5_000);
    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshC.nodeId && n.online) === true,
      5_000
    );

    const [offerer, answerer] =
      meshA.nodeId.toLowerCase() < meshB.nodeId.toLowerCase() ? [meshA, meshB] : [meshB, meshA];
    const rtcSession = peerRtcSession(offerer.nodeId, answerer.nodeId);
    const before = fake.connections.length;

    const sendWake = (sdp: string) => {
      answerer.uplink.sendCtl({
        t: 'rtc.signal',
        rtcSession,
        from: 'node',
        to: offerer.nodeId,
        sdp,
      });
    };

    sendWake(JSON.stringify({ type: 'rtc.wake' }));
    sendWake(
      encodeRtcWakeSdp({
        from: answerer.nodeId,
        to: offerer.nodeId,
        rtcSession,
        issuedAt: Date.now(),
        secretKey: generateEd25519KeyPair().secretKey,
      })
    );
    sendWake(
      encodeRtcWakeSdp({
        from: offerer.nodeId,
        to: answerer.nodeId,
        rtcSession,
        issuedAt: Date.now(),
        secretKey: answerer.identity.edPrivateKey,
      })
    );
    expect(meshC.uplink.state).toBe('online');
    meshA.userStore.markCertRevoked(meshC.nodeId, 99);
    expect(meshC.uplink.state).toBe('online');
    answerer.uplink.sendCtl({
      t: 'rtc.signal',
      rtcSession: peerRtcSession(answerer.nodeId, meshC.nodeId),
      from: 'node',
      to: meshC.nodeId,
      sdp: encodeRtcWakeSdp({
        from: answerer.nodeId,
        to: meshC.nodeId,
        rtcSession: peerRtcSession(answerer.nodeId, meshC.nodeId),
        issuedAt: Date.now(),
        secretKey: answerer.identity.edPrivateKey,
      }),
    });
    await Bun.sleep(80);
    expect(fake.connections.length).toBe(before);
    expect(offerer.peers.transportOf(answerer.nodeId)).toBeNull();
    expect(answerer.peers.transportOf(offerer.nodeId)).toBeNull();

    await answerer.peers.getLink(offerer.nodeId);
    await waitUntil(() => answerer.peers.transportOf(offerer.nodeId) === 'dc', 8_000);
    await waitUntil(() => offerer.peers.transportOf(answerer.nodeId) === 'dc', 8_000);
    expect(answerer.peers.transportOf(offerer.nodeId)).toBe('dc');
    expect(offerer.peers.transportOf(answerer.nodeId)).toBe('dc');
    expect(fake.connections.length).toBeGreaterThan(before);
  }, 20_000);
});
