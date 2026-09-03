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
    clientVersion: '1.1.23',
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

const SYNTHETIC_EPOCH = new Uint8Array(16).fill(0x5a);

function encodeSubscribe(deviceId: string, paneId: string, seq = 2): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_COMMAND,
    wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          {
            pane: { deviceId, serverEpoch: SYNTHETIC_EPOCH, paneId },
            cursor: null,
          },
        ],
        hotPanes: [],
      },
    }),
    seq
  );
}

/** 用 canonical PaneData 承载 SEQ_n 探针：legacy TERM_OUTPUT 已下线。 */
function encodeSyntheticPaneData(
  deviceId: string,
  paneId: string,
  text: string,
  seqStart: bigint
): Uint8Array {
  const data = new TextEncoder().encode(text);
  return wsBorsh.encodeCanonicalEventPayload({
    PaneData: {
      pane: { deviceId, serverEpoch: SYNTHETIC_EPOCH, paneId },
      paneEpoch: SYNTHETIC_EPOCH,
      seqStart,
      seqEnd: seqStart + BigInt(data.byteLength),
      data,
    },
  });
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
    if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return [];
    const event = wsBorsh.decodeCanonicalEventPayload(env.payload).event;
    if (!('PaneData' in event)) return [];
    const text = new TextDecoder().decode(event.PaneData.data);
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
    let paneDataSeq = 0n;
    const timer = setInterval(() => {
      const clients = [...wsServerB.connectedClients].filter(
        (c) => c.borshState.negotiated && !c.closed
      );
      if (clients.length === 0) return;
      seq += 1;
      const text = `SEQ_${seq}\n`;
      const payload = encodeSyntheticPaneData('local', '%1', text, paneDataSeq);
      paneDataSeq += BigInt(new TextEncoder().encode(text).byteLength);
      for (const client of clients) {
        wsServerB.sendChunked(client, wsBorsh.KIND_CANONICAL_EVENT, payload);
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
});
