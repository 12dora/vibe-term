import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { generateEd25519KeyPair, normalizeFingerprint } from '@vibeterm/shared/auth';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { eq } from 'drizzle-orm';
import { filesBulkHooks } from '../../api/files';
import { NodeSessionStore } from '../../auth';
import { fromBase64Url } from '../../auth/binary';
import type { AuthDb } from '../../auth/types';
import { nodeSessions } from '../../db/schema';
import { createUploadSession, removeUploadSession } from '../../files/transfer-session';
import { bootRelayMeshHarness, waitUntil } from '../../relay/integration/relay-mesh-harness';
import type { GatewayRuntime } from '../../runtime';
import { WebSocketServer } from '../../ws';
import type { GatewaySession } from '../../ws/gateway-session';
import { MESH_VIA_SELF, MESH_WS_KIND } from '../mesh-deps';
import { SESS_CHANNEL_LABEL } from '../rtc';
import { fragmentFrame } from '../rtc/fragmenter';
import { type FakePeerConnection, createFakeNativeModule } from '../rtc/test-fakes';
import { acceptWsStream, openHttpStream, openWsStream } from '../stream-targets';
import { requestDispatchContext } from '../types';
import { type BootUser, callMesh, loginSelf, selfCookie } from './mesh-http-helpers';

const origGetTransferOwner = filesBulkHooks.status;
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

function requireGateway(g: GatewayRuntime | null): GatewayRuntime {
  if (!g) throw new Error('missing gateway');
  return g;
}

function bootUserOf(tenant: {
  userId: string;
  rootKey: BootUser['rootKey'];
  rootPublicKey: Uint8Array;
  rootEpoch: number;
}): BootUser {
  return {
    userId: tenant.userId,
    rootKey: tenant.rootKey,
    rootPublicKey: tenant.rootPublicKey,
    rootEpoch: tenant.rootEpoch,
  };
}

describe('direct path integration', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    filesBulkHooks.status = origGetTransferOwner;
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
    const fake = createFakeNativeModule();
    const wsServer = new WebSocketServer();
    let gateway: GatewayRuntime | null = null;
    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative: async () => fake.module,
      peerPort: 39001,
      stunServers: [],
      gatewayFactory: (db) => {
        gateway = fakeGateway(db, wsServer);
        return gateway;
      },
    });
    await tenant.enroll();
    const entryGateway = requireGateway(gateway);
    const mesh = tenant.owner.mesh;
    const db = tenant.owner.db;
    const boot = bootUserOf(tenant);
    filesBulkHooks.status = (id) => {
      const owner = origGetTransferOwner(id);
      if (!owner) return null;
      const uid = transferUids.get(id);
      return uid != null ? { ...owner, uid } : owner;
    };

    const sid = await loginSelf(mesh, boot);
    const cookie = selfCookie(sid);
    const sessionStore = new NodeSessionStore(db);
    const [linkA, linkB] = createInMemoryLinkPair();
    const [linkA2, linkB2] = createInMemoryLinkPair();
    const openedSessions: GatewaySession[] = [];
    const accept = (stream: import('@vibeterm/shared/link').LinkStream) => {
      void acceptWsStream(stream, {
        peerNodeId: MESH_VIA_SELF,
        sessionStore,
        wsServer,
        onGatewaySession: (session, auth) => {
          const ok = mesh.registerGatewaySession({ ...auth, session });
          openedSessions.push(session);
          return ok.ok;
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
      clientVersion: '1.1.23',
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
    const listedA = await callMesh(mesh, 'http://entry/api/mesh/connection?cid=tab-a', {
      cookie,
    });
    expect(listedA.status).toBe(200);
    const connA = (await listedA.json()) as { connectionId: string };
    expect(connA.connectionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connA.connectionId).not.toBe('tab-a');

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
        connectionId: connA.connectionId,
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

    const bound = mesh.sessions.getByConnectionId(connA.connectionId);
    expect(session.closed).toBe(false);
    expect(bound?.via).toBe(MESH_VIA_SELF);
    expect(bound?.sid).toBe(sid);
    expect(bound?.cid).toBe('tab-a');
    expect(sessionStore.verify(sid, { viaNodeId: MESH_VIA_SELF, now: Date.now() }).ok).toBe(true);

    const init = await entryGateway.dispatchHttp(
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
    expect(nodePc?.inbound.map((row) => row.getLabel()) ?? []).toContain(`bulk:${uploadId}`);
    expect(bulk.peer?.getLabel()).toBe(`bulk:${uploadId}`);
    const bulkReplies: string[] = [];
    bulk.onMessage((msg) => {
      bulkReplies.push(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
    });
    const put = JSON.stringify({ op: 'put', transferId: uploadId, size: 1 });
    bulk.sendMessage(put);
    bulk.sendMessageBinary(Buffer.from([0x42]));
    bulk.sendMessage(JSON.stringify({ op: 'done' }));
    await waitUntil(
      () =>
        bulkReplies.some((row) => {
          try {
            return (JSON.parse(row) as { ok?: unknown }).ok === true;
          } catch {
            return false;
          }
        }),
      2_000
    );

    const wrongOwner = await entryGateway.dispatchHttp(
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

    // 直连的逐帧校验按 WS_SESSION_VERIFY_MS 节流，撤销的即时性由撤销通知（登出 / key log
    // 效果）走 onSessionsRevoked 复核保证：复核发现真失效才断，这里正是那条路。
    sessionStore.revoke(sid);
    const ping = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_PING,
      wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, { nonce: 1, timeMs: 0n }),
      9
    );
    for (const part of fragmentFrame(1, ping, 16_384)) {
      dc.sendMessageBinary(Buffer.from(part));
    }
    expect(session.closed).toBe(false);
    mesh.closeSocketsForSid(sid);
    await waitUntil(() => session.closed, 3_000);
    expect(session.closed).toBe(true);
    expect(dc.closed).toBe(true);
    openedA.close();
    openedB.close();
  }, 15_000);

  test('same cid on a new stream takes over the previous session', async () => {
    const fake = createFakeNativeModule();
    const wsServer = new WebSocketServer();
    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative: async () => fake.module,
      peerPort: 39011,
      stunServers: [],
      gatewayFactory: (db) => fakeGateway(db, wsServer),
    });
    await tenant.enroll();
    const mesh = tenant.owner.mesh;
    const db = tenant.owner.db;
    const boot = bootUserOf(tenant);
    const sid = await loginSelf(mesh, boot);
    const sessionStore = new NodeSessionStore(db);
    const [linkA, linkB] = createInMemoryLinkPair();
    const [linkA2, linkB2] = createInMemoryLinkPair();
    const openedSessions: GatewaySession[] = [];
    const accept = (stream: import('@vibeterm/shared/link').LinkStream) => {
      void acceptWsStream(stream, {
        peerNodeId: MESH_VIA_SELF,
        sessionStore,
        wsServer,
        onGatewaySession: (session, auth) => {
          const result = mesh.registerGatewaySession({ ...auth, session });
          if (result.ok) openedSessions.push(session);
          return result.ok;
        },
      });
    };
    linkB.onStream(accept);
    linkB2.onStream(accept);
    const first = await openWsStream(linkA, sid, 'same-nonce');
    await waitUntil(() => openedSessions.length === 1, 3_000);
    const original = openedSessions[0] as GatewaySession;
    const second = await openWsStream(linkA2, sid, 'same-nonce');
    await waitUntil(() => openedSessions.length === 2, 3_000);
    await expect(first.stream.closed).resolves.toMatchObject({ reason: 'rst' });
    const sessions = mesh.sessions.listBySid(sid);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session).not.toBe(original);
    second.close();
  }, 10_000);

  test('expired session and wrong via cannot attach a direct carrier', async () => {
    const fake = createFakeNativeModule();
    const wsServer = new WebSocketServer();
    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative: async () => fake.module,
      peerPort: 39012,
      stunServers: [],
      gatewayFactory: (db) => fakeGateway(db, wsServer),
    });
    await tenant.enroll();
    const mesh = tenant.owner.mesh;
    const db = tenant.owner.db;
    const boot = bootUserOf(tenant);
    const sid = await loginSelf(mesh, boot);
    const cookie = selfCookie(sid);
    const sessionStore = new NodeSessionStore(db);
    const [linkA, linkB] = createInMemoryLinkPair();
    const openedSessions: GatewaySession[] = [];
    linkB.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: MESH_VIA_SELF,
        sessionStore,
        wsServer,
        onGatewaySession: (session, auth) => {
          const result = mesh.registerGatewaySession({ ...auth, session });
          if (result.ok) openedSessions.push(session);
          return result.ok;
        },
      });
    });
    const opened = await openWsStream(linkA, sid, 'tab-exp');
    await waitUntil(() => openedSessions.length === 1, 3_000);
    const session = openedSessions[0] as GatewaySession;
    const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'direct-path-test',
      clientVersion: '1.1.23',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    await opened.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1));

    async function completeHandshake(
      rtcSession: string,
      cid: string,
      afterAuthorize: () => void
    ): Promise<void> {
      const listed = await callMesh(mesh, `http://entry/api/mesh/connection?cid=${cid}`, {
        cookie,
      });
      expect(listed.status).toBe(200);
      const conn = (await listed.json()) as { connectionId: string };
      const browserPc = new fake.module.PeerConnection(rtcSession, {
        iceServers: [],
      }) as FakePeerConnection;
      fixtures.push({ close: () => browserPc.close() });
      const meshWs = {
        data: { kind: MESH_WS_KIND, sid, uid: boot.userId },
        send(d: Uint8Array) {
          try {
            const env = wsBorsh.decodeEnvelope(d);
            if (env.kind === wsBorsh.KIND_RTC_SIGNAL) {
              const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
              if (payload.sdp) {
                const parsed = JSON.parse(payload.sdp) as { type: string; sdp: string };
                browserPc.setRemoteDescription(parsed.sdp, parsed.type);
              }
              if (payload.candidate) {
                const parsed = JSON.parse(payload.candidate) as {
                  candidate: string;
                  mid: string;
                };
                if (parsed.candidate) {
                  browserPc.addRemoteCandidate(parsed.candidate, parsed.mid);
                }
              }
            }
          } catch {
            // ignore
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
          connectionId: conn.connectionId,
          fp_browser: fpBrowser,
        }),
      });
      expect(authz.status).toBe(200);
      const granted = (await authz.json()) as { nonce: string };
      afterAuthorize();
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
      await Bun.sleep(250);
    }

    await completeHandshake('browser-expired', 'tab-exp', () => {
      db.update(nodeSessions)
        .set({ expiresAt: 0, hardExpiresAt: 0 })
        .where(eq(nodeSessions.sid, fromBase64Url(sid)))
        .run();
    });
    expect(session.activeCarrier).toBe(session.primary);

    db.update(nodeSessions)
      .set({
        expiresAt: Date.now() + 86_400_000,
        hardExpiresAt: Date.now() + 86_400_000,
        viaNodeId: MESH_VIA_SELF,
      })
      .where(eq(nodeSessions.sid, fromBase64Url(sid)))
      .run();
    const [linkVia, linkViaPeer] = createInMemoryLinkPair();
    linkViaPeer.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: MESH_VIA_SELF,
        sessionStore,
        wsServer,
        onGatewaySession: (nextSession, auth) => {
          const result = mesh.registerGatewaySession({ ...auth, session: nextSession });
          if (result.ok) openedSessions.push(nextSession);
          return result.ok;
        },
      });
    });
    const openedVia = await openWsStream(linkVia, sid, 'tab-via');
    await waitUntil(() => openedSessions.length >= 2, 3_000);
    const viaSession = openedSessions[openedSessions.length - 1] as GatewaySession;
    await openedVia.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1));
    await completeHandshake('browser-wrong-via', 'tab-via', () => {
      db.update(nodeSessions)
        .set({ viaNodeId: 'other-node' })
        .where(eq(nodeSessions.sid, fromBase64Url(sid)))
        .run();
    });
    expect(viaSession.activeCarrier).toBe(viaSession.primary);
    opened.close();
    openedVia.close();
  }, 15_000);

  test('node↔node DC signaling goes through the relay uplink', async () => {
    const fake = createFakeNativeModule();
    const loadNative = async () => fake.module;

    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative,
      peerPort: 39001,
      stunServers: ['stun:stun.example:3478'],
      gatewayFactory: (db) => fakeGateway(db),
    });
    await tenant.enroll();
    const meshA = tenant.owner.mesh;
    const meshB = (
      await tenant.joinNode('node-b', {
        loadNative,
        peerPort: 39002,
        stunServers: ['stun:stun.example:3478'],
        gatewayFactory: (db) => fakeGateway(db),
      })
    ).mesh;

    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      8_000
    );

    // getLink 可能先经中继 uplink settle 成 relay；信令仍走 MeshRtcSignalRouter，等 DC 升上去再开流
    await Promise.all([meshA.peers.getLink(meshB.nodeId), meshB.peers.getLink(meshA.nodeId)]);
    await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) === 'dc', 8_000);
    await waitUntil(() => meshB.peers.transportOf(meshA.nodeId) === 'dc', 8_000);
    const linkA = meshA.peers.getLive(meshB.nodeId);
    const linkB = meshB.peers.getLive(meshA.nodeId);
    if (!linkA || !linkB) throw new Error('missing dc link');
    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');
    expect(meshB.peers.transportOf(meshA.nodeId)).toBe('dc');
    const incoming = new Promise<import('@vibeterm/shared/link').LinkStream>((resolve) =>
      linkB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"http","method":"GET","path":"/healthz"}');
    const out = await linkA.openStream(open);
    const inn = await incoming;
    expect(inn.openPayload).toEqual(open);
    out.end();
    inn.end();
  }, 15_000);

  test('8 MiB HTTP stream over relay completes while a DC upgrade retry is failing', async () => {
    const EIGHT_MIB = 8 * 1024 * 1024;
    const body = new Uint8Array(EIGHT_MIB);
    for (let i = 0; i < body.byteLength; i++) body[i] = i & 0xff;
    const fake = createFakeNativeModule();
    const loadNative = async () => fake.module;

    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative,
      peerPort: 39021,
      stunServers: [],
      gatewayFactory: (db) => fakeGateway(db),
    });
    await tenant.enroll();
    const meshA = tenant.owner.mesh;
    const nodeB = await tenant.joinNode('node-b', {
      loadNative,
      peerPort: 39022,
      stunServers: [],
      gatewayFactory: (db) => ({
        ...fakeGateway(db),
        dispatchHttp: async () =>
          new Response(body, {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(EIGHT_MIB),
            },
          }),
      }),
    });
    const meshB = nodeB.mesh;

    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      8_000
    );

    meshA.rtc.connectToPeer = async () => {
      await Bun.sleep(5_000);
      throw new Error('dc-redial-blocked');
    };
    meshB.rtc.connectToPeer = async () => {
      await Bun.sleep(5_000);
      throw new Error('dc-redial-blocked');
    };

    meshA.peers.getLive(meshB.nodeId)?.close('drop-dc');
    meshB.peers.getLive(meshA.nodeId)?.close('drop-dc');
    await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) !== 'dc', 5_000);
    await waitUntil(() => meshB.peers.transportOf(meshA.nodeId) !== 'dc', 5_000);

    const link = await meshA.peers.getLink(meshB.nodeId);
    await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) === 'relay', 8_000);
    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('relay');
    await waitUntil(() => meshA.peers.quiesceCapableOf(meshB.nodeId), 2_000);
    await waitUntil(() => meshB.peers.quiesceCapableOf(meshA.nodeId), 2_000);

    const sess = generateEd25519KeyPair();
    const issued = new NodeSessionStore(nodeB.db).issue({
      userId: tenant.userId,
      viaNodeId: meshA.nodeId,
      sessPublicKey: sess.publicKey,
      now: Date.now(),
      delegationMethod: 'root',
    });

    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('relay');
    const seenDuring: Array<string | null> = [];
    const poll = setInterval(() => {
      seenDuring.push(meshA.peers.transportOf(meshB.nodeId));
    }, 50);
    try {
      const res = await openHttpStream(link, {
        type: 'http',
        method: 'GET',
        path: '/api/files/raw',
        origin: 'http://entry',
        auth: issued.sid,
      });
      expect(res.status).toBe(200);
      const received = new Uint8Array(await res.arrayBuffer());
      expect(received.byteLength).toBe(EIGHT_MIB);
      expect(received).toEqual(body);
    } finally {
      clearInterval(poll);
    }
    expect(seenDuring.every((kind) => kind === 'relay')).toBe(true);
    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('relay');
  }, 20_000);
});
