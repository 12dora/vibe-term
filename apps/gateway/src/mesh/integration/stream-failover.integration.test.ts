import { afterEach, describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';
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
import type { DeviceSessionRuntime } from '../../tmux-client/device-session-runtime';
import { WebSocketServer } from '../../ws';
import {
  MESH_FORWARD_WS_KIND,
  MESH_VIA_SELF,
  type MeshServerWebSocket,
  setMeshRequestContext,
} from '../mesh-deps';
import { type MeshRuntime, createMeshRuntime } from '../mesh-runtime';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { waitUntil } from '../test-support';
import { requestDispatchContext } from '../types';

const PASSWORD = 'tmex-test';

function fakeGateway(db: AuthDb, wsServer?: WebSocketServer): GatewayRuntime {
  const server = wsServer ?? new WebSocketServer();
  return {
    port: 0,
    db,
    wsServer: server,
    handleRequest: () => undefined,
    dispatchHttp: async (req, ctx) => {
      requestDispatchContext.set(req, { uid: ctx.uid ?? '', viaNodeId: ctx.viaNodeId });
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
): Promise<Response | undefined> {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set('cookie', init.cookie);
  const { cookie: _cookie, ...rest } = init ?? {};
  const req = new Request(url, { ...rest, headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await mesh.handleRequest(req, { upgrade: () => false });
  if (res === undefined) return undefined;
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
  if (!ch) throw new Error('challenge failed');
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
  if (!res) throw new Error('login failed');
  expect(res.status).toBe(200);
  return sidFromResponse(res);
}

async function loginRemote(
  entry: MeshRuntime,
  target: MeshRuntime,
  boot: { userId: string; rootKey: Parameters<typeof createDelegation>[0] },
  cookie: string
): Promise<string> {
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
  if (!ch) throw new Error('remote challenge failed');
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: target.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: entry.nodeId,
  });
  const res = await callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/login`, {
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
  if (!res) throw new Error('remote login failed');
  expect(res.status).toBe(200);
  return sidFromResponse(res, target.nodeId);
}

const DEVICE_ID = 'local';
const PANE_ID = '%1';

function paneSnapshot(deviceId: string): StateSnapshotPayload {
  return {
    deviceId,
    session: {
      id: '$1',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'one',
          index: 0,
          active: true,
          panes: [
            {
              id: PANE_ID,
              windowId: '@1',
              index: 0,
              title: 'one-pane',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
      ],
    },
  };
}

function fakePaneRuntime(
  deviceId: string,
  historyByPane?: Map<string, string>
): DeviceSessionRuntime {
  return {
    connect: async () => {},
    subscribe: () => () => {},
    requestSnapshot() {},
    disconnect() {},
    getCurrentSnapshot: () => paneSnapshot(deviceId),
    setWindowStyle: async () => {},
    selectPane() {},
    selectPaneWithSize() {},
    sendInput() {},
    fetchPaneHistory: async (paneId: string) => {
      const data = historyByPane?.get(paneId) ?? '';
      return { data, alternateScreen: false, modes: 0 };
    },
  } as unknown as DeviceSessionRuntime;
}

function encodeHello(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'stream-failover',
    clientVersion: 'test',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1);
}

function encodeDeviceConnect(deviceId: string, seq: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECT,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId }),
    seq
  );
}

function encodeSubscribe(deviceId: string, paneId: string, seq = 2): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, {
    deviceId,
    paneIds: [paneId],
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TMUX_SUBSCRIBE_PANES, payload, seq);
}

function encodeSelect(deviceId: string, paneId: string, seq: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_TMUX_SELECT,
    wsBorsh.encodePayload(wsBorsh.schema.TmuxSelectSchema, {
      deviceId,
      windowId: null,
      paneId,
      selectToken: new Uint8Array(16),
      wantHistory: true,
      cols: 120,
      rows: 32,
    }),
    seq
  );
}

function frameKind(bytes: Uint8Array): number | null {
  try {
    return wsBorsh.decodeEnvelope(bytes).kind;
  } catch {
    return null;
  }
}

function hasKind(frames: Uint8Array[], kind: number): boolean {
  return frames.some((frame) => frameKind(frame) === kind);
}

function parseSeq(bytes: Uint8Array): number[] {
  try {
    const env = wsBorsh.decodeEnvelope(bytes);
    let data: Uint8Array | null = null;
    if (env.kind === wsBorsh.KIND_TERM_OUTPUT) {
      data = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, env.payload).data;
    } else if (env.kind === wsBorsh.KIND_TERM_HISTORY) {
      data = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, env.payload).data;
    } else {
      return [];
    }
    const text = new TextDecoder().decode(data);
    return [...text.matchAll(/SEQ_(\d+)/g)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

describe('stream failover integration', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('pane stream over dc stays contiguous at entry WS after the dc link dies', async () => {
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
    const wsServerA = new WebSocketServer();
    const meshA = await createMeshRuntime({
      db,
      gateway: fakeGateway(db, wsServerA),
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
      { upgrade: () => false }
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
      { upgrade: () => false }
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

    const wsServerB = new WebSocketServer();
    const meshB = await createMeshRuntime({
      db: dbB,
      gateway: fakeGateway(dbB, wsServerB),
      userId: boot.userId,
      config: {
        roles: { hub: false, node: true, relay: false },
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
    await meshB.start();
    await waitUntil(() => meshB.uplink.state === 'online', 5_000);
    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      5_000
    );
    await meshA.peers.getLink(meshB.nodeId);
    await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) === 'dc', 8_000);
    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');

    const remoteSid = await loginRemote(meshA, meshB, boot, cookie);
    const jar = `${cookie}; ${nodeSessionCookieName(meshB.nodeId)}=${remoteSid}`;
    let upgradeData: { kind?: string; token?: string } | undefined;
    const upgrade = await meshA.handleRequest(
      new Request(`http://entry/n/${meshB.nodeId}/ws`, {
        headers: { cookie: jar },
      }),
      {
        upgrade(_req, opts) {
          upgradeData = opts?.data as typeof upgradeData;
          return true;
        },
      }
    );
    expect(upgrade).toBeUndefined();
    expect(upgradeData?.kind).toBe(MESH_FORWARD_WS_KIND);

    const entryFrames: Uint8Array[] = [];
    let browserClosed = false;
    const entryWs = {
      data: upgradeData ?? { kind: MESH_FORWARD_WS_KIND },
      send(frame: Uint8Array) {
        entryFrames.push(frame.slice());
        return frame.byteLength;
      },
      close() {
        browserClosed = true;
      },
    } as MeshServerWebSocket;
    meshA.websocket.open(entryWs);
    meshA.websocket.message(entryWs, Buffer.from(encodeHello()));
    meshA.websocket.message(entryWs, Buffer.from(encodeSubscribe('local', '%1')));

    await waitUntil(
      () => [...wsServerB.connectedClients].some((c) => c.borshState.negotiated),
      3_000
    );

    const logs: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => {
      logs.push(String(args[0]));
      origInfo.apply(console, args);
    };

    let seq = 0;
    const timer = setInterval(() => {
      const clients = [...wsServerB.connectedClients].filter(
        (c) => c.borshState.negotiated && !c.closed
      );
      if (clients.length === 0) return;
      seq += 1;
      const payload = wsBorsh.encodePayload(wsBorsh.schema.TermOutputSchema, {
        deviceId: 'local',
        paneId: '%1',
        encoding: 1,
        data: new TextEncoder().encode(`SEQ_${seq}\n`),
      });
      for (const client of clients) {
        wsServerB.sendChunked(client, wsBorsh.KIND_TERM_OUTPUT, payload);
      }
    }, 20);

    try {
      await waitUntil(() => {
        const nums = entryFrames.flatMap(parseSeq);
        return nums.length >= 8;
      }, 5_000);
      const beforeKill = entryFrames.flatMap(parseSeq);
      expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');
      meshA.peers.getLive(meshB.nodeId)?.close('drop-dc');
      meshB.peers.getLive(meshA.nodeId)?.close('drop-dc');

      await waitUntil(
        () => logs.some((line) => line.includes('[mesh][stream] failover stream=')),
        25_000
      );
      await waitUntil(() => {
        const nums = entryFrames.flatMap(parseSeq);
        return nums.length >= beforeKill.length + 8;
      }, 10_000);
      expect(browserClosed).toBe(false);
      const nums = entryFrames.flatMap(parseSeq);
      const unique: number[] = [];
      for (const n of nums) {
        if (unique.at(-1) === n) continue;
        unique.push(n);
      }
      expect(unique[0]).toBe(1);
      for (let i = 1; i < unique.length; i += 1) {
        expect(unique[i]).toBe((unique[i - 1] ?? 0) + 1);
      }
      expect(logs.some((line) => /from=dc to=(relay|ws-secure|dc) resumed=/.test(line))).toBe(true);
    } finally {
      clearInterval(timer);
      console.info = origInfo;
    }
  }, 45_000);

  test('legacy HELLO/DEVICE_CONNECT/SUBSCRIBE/SELECT keeps 0x305 SEQ after dc death', async () => {
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
    const wsServerA = new WebSocketServer();
    const meshA = await createMeshRuntime({
      db,
      gateway: fakeGateway(db, wsServerA),
      userId: boot.userId,
      config: {
        roles: { hub: true, node: true, relay: false },
        hubUrl: null,
        hubPublicUrl: 'http://hub.example',
        peerPort: 39011,
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
      { upgrade: () => false }
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
      { upgrade: () => false }
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

    let acquireCount = 0;
    const historyByPane = new Map<string, string>();
    const wsServerB = new WebSocketServer({
      deps: {
        acquireRuntime: async (deviceId) => {
          acquireCount += 1;
          if (acquireCount > 1) {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          return fakePaneRuntime(deviceId, historyByPane);
        },
        releaseRuntime: async () => {},
        loadDeviceTreeOrder: (deviceId) => ({ deviceId, windows: [], panes: {} }),
        saveWindowOrder: () => {},
        savePaneOrder: () => {},
      },
    });
    wsServerB.setOnSessionClosed(() => {
      queueMicrotask(() => {
        for (const [deviceId, entry] of [...wsServerB.connections]) {
          if (entry.clients.size === 0 && (entry.canonicalClients?.size ?? 0) === 0) {
            wsServerB.releaseConnectionEntry(deviceId, entry);
            wsServerB.connections.delete(deviceId);
          }
        }
      });
    });
    const meshB = await createMeshRuntime({
      db: dbB,
      gateway: fakeGateway(dbB, wsServerB),
      userId: boot.userId,
      config: {
        roles: { hub: false, node: true, relay: false },
        hubUrl: 'http://hub.example',
        peerPort: 39012,
        stunServers: [],
      },
      uplinkHub: meshA.hub ?? undefined,
      startPeerServer: false,
      pingIntervalMs: 60_000,
      networkInterfaces: () => ({}),
      loadNative,
    });
    fixtures.push({ close: closeB, stop: () => meshB.stop() });
    await meshB.start();
    await waitUntil(() => meshB.uplink.state === 'online', 5_000);
    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      5_000
    );
    await meshA.peers.getLink(meshB.nodeId);
    await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) === 'dc', 8_000);

    const remoteSid = await loginRemote(meshA, meshB, boot, cookie);
    const jar = `${cookie}; ${nodeSessionCookieName(meshB.nodeId)}=${remoteSid}`;
    let upgradeData: { kind?: string; token?: string } | undefined;
    const upgrade = await meshA.handleRequest(
      new Request(`http://entry/n/${meshB.nodeId}/ws`, {
        headers: { cookie: jar },
      }),
      {
        upgrade(_req, opts) {
          upgradeData = opts?.data as typeof upgradeData;
          return true;
        },
      }
    );
    expect(upgrade).toBeUndefined();
    expect(upgradeData?.kind).toBe(MESH_FORWARD_WS_KIND);

    const entryFrames: Uint8Array[] = [];
    let browserClosed = false;
    const entryWs = {
      data: upgradeData ?? { kind: MESH_FORWARD_WS_KIND },
      send(frame: Uint8Array) {
        entryFrames.push(frame.slice());
        return frame.byteLength;
      },
      close() {
        browserClosed = true;
      },
    } as MeshServerWebSocket;
    meshA.websocket.open(entryWs);
    meshA.websocket.message(entryWs, Buffer.from(encodeHello()));
    await waitUntil(() => hasKind(entryFrames, wsBorsh.KIND_HELLO_S2C), 3_000);
    meshA.websocket.message(entryWs, Buffer.from(encodeDeviceConnect(DEVICE_ID, 2)));
    await waitUntil(() => hasKind(entryFrames, wsBorsh.KIND_DEVICE_CONNECTED), 3_000);
    await waitUntil(() => hasKind(entryFrames, wsBorsh.KIND_STATE_SNAPSHOT), 3_000);
    meshA.websocket.message(entryWs, Buffer.from(encodeSubscribe(DEVICE_ID, PANE_ID, 3)));
    meshA.websocket.message(entryWs, Buffer.from(encodeSelect(DEVICE_ID, PANE_ID, 4)));

    const logs: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => {
      logs.push(String(args[0]));
      origInfo.apply(console, args);
    };

    let seq = 0;
    const timer = setInterval(() => {
      seq += 1;
      const chunk = `SEQ_${seq}\n`;
      historyByPane.set(PANE_ID, `${historyByPane.get(PANE_ID) ?? ''}${chunk}`);
      wsServerB.broadcastTerminalOutput(DEVICE_ID, PANE_ID, new TextEncoder().encode(chunk));
    }, 20);

    try {
      await waitUntil(() => {
        const nums = entryFrames.flatMap(parseSeq);
        return nums.length >= 8;
      }, 5_000);
      const beforeKill = entryFrames.flatMap(parseSeq);
      const framesAtKill = entryFrames.length;
      const seqAtKill = seq;
      expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');
      meshA.peers.getLive(meshB.nodeId)?.close('drop-dc');
      meshB.peers.getLive(meshA.nodeId)?.close('drop-dc');

      await waitUntil(
        () => logs.some((line) => line.includes('[mesh][stream] failover stream=')),
        25_000
      );
      expect(
        logs.some((line) =>
          /from=dc to=(relay|ws-secure|dc) resumed=1 mode=legacy panes=%1 cursor=-/.test(line)
        )
      ).toBe(true);
      const seqAtResume = seq;
      expect(seqAtResume).toBeGreaterThan(seqAtKill);

      await waitUntil(() => {
        const after = entryFrames.slice(framesAtKill);
        const history = after.some((frame) => frameKind(frame) === wsBorsh.KIND_TERM_HISTORY);
        const live = after.some((frame) => frameKind(frame) === wsBorsh.KIND_TERM_OUTPUT);
        return history && live;
      }, 10_000);
      expect(browserClosed).toBe(false);
      const all = new Set(entryFrames.flatMap(parseSeq));
      const max = Math.max(...all, 0);
      expect(max).toBeGreaterThanOrEqual(seqAtKill);
      for (let i = 1; i <= max; i += 1) {
        expect(all.has(i)).toBe(true);
      }
      const after = entryFrames.slice(framesAtKill);
      const historySeqs = after
        .filter((frame) => frameKind(frame) === wsBorsh.KIND_TERM_HISTORY)
        .flatMap(parseSeq);
      expect(historySeqs.some((n) => n > seqAtKill && n <= seqAtResume)).toBe(true);
      expect(beforeKill.length).toBeGreaterThanOrEqual(8);
    } finally {
      clearInterval(timer);
      console.info = origInfo;
    }
  }, 45_000);
});
