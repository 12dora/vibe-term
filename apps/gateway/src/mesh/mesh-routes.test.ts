import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  DOMAIN_CERTIFICATE,
  encodeBase64url,
  encodeCertificate,
  hexToBytes,
} from '@tmex/shared/auth';
import {
  FakePeers,
  NODE_ID,
  NODE_PK,
  asResponse,
  bootMesh,
  call,
  challengeAndLogin,
  dummyServer,
} from './auth-routes.test';
import {
  MESH_REJECT_4401_KIND,
  MESH_WS_KIND,
  type MeshServerWebSocket,
  WS_CLOSE_LOGIN_REQUIRED,
} from './mesh-deps';

const PEER_ID = 'cc'.repeat(16);
const REVOKED_ID = 'dd'.repeat(16);

describe('mesh-routes', () => {
  test('GET /api/mesh/nodes merges certs, peer_cache, reach, loggedIn; includes self; drops revoked', async () => {
    const peers = new FakePeers();
    peers.reach.set(PEER_ID, 'lan');
    const mesh = await bootMesh({ peers });
    try {
      mesh.userStore.upsertCert({
        nodeId: PEER_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 2,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(PEER_ID),
          ed_pk: new Uint8Array(32).fill(4),
          x25519_pk: new Uint8Array(32).fill(5),
          enroll_pk: new Uint8Array(32).fill(6),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
      });
      mesh.userStore.upsertPeer({
        nodeId: PEER_ID,
        name: 'studio',
        endpointsJson: '[]',
        inventoryJson: '{"version":"1.2.3"}',
        directCapable: true,
        lastSeenAt: 1,
        listVersion: 7,
      });
      mesh.userStore.upsertCert({
        nodeId: REVOKED_ID,
        userId: mesh.boot.userId,
        admitRecordSeq: 3,
        certificateBytes: encodeCertificate({
          domain: DOMAIN_CERTIFICATE,
          uid: mesh.boot.userId,
          node_id: hexToBytes(REVOKED_ID),
          ed_pk: new Uint8Array(32).fill(8),
          x25519_pk: new Uint8Array(32).fill(8),
          enroll_pk: new Uint8Array(32).fill(8),
          issued_at: 1n,
        }),
        certSig: new Uint8Array(64),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
        revokedLogSeq: 9,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `tmex_s_self=${sid}; tmex_s_${PEER_ID}=xyz` },
      });
      const body = (await list.json()) as {
        nodes: Array<{
          id: string;
          name: string;
          publicKey: string;
          online: boolean;
          reach: string | null;
          loggedIn: boolean;
          direct_capable: boolean;
          version: string | null;
        }>;
      };
      const ids = body.nodes.map((n) => n.id);
      expect(ids).toContain(NODE_ID);
      expect(ids).toContain(PEER_ID);
      expect(ids).not.toContain(REVOKED_ID);
      const self = body.nodes.find((n) => n.id === NODE_ID);
      expect(self?.online).toBe(true);
      expect(self?.loggedIn).toBe(true);
      expect(self?.publicKey).toBe(encodeBase64url(NODE_PK));
      const peer = body.nodes.find((n) => n.id === PEER_ID);
      expect(peer?.name).toBe('studio');
      expect(peer?.online).toBe(true);
      expect(peer?.reach).toBe('lan');
      expect(peer?.loggedIn).toBe(true);
      expect(peer?.direct_capable).toBe(true);
      expect(peer?.version).toBe('1.2.3');
      expect((self as { isHub?: boolean })?.isHub).toBe(false);
      expect((peer as { isHub?: boolean })?.isHub).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/nodes marks the persisted hub and broadcasts ENROLL_REDEEMED', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      mesh.userStore.upsertHubMeta({
        nodeId: NODE_ID,
        publicUrl: 'https://hub.example',
        now: 1,
      });
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const list = await call(mesh.runtime, 'http://localhost/api/mesh/nodes', {
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      const body = (await list.json()) as { nodes: Array<{ id: string; isHub: boolean }> };
      expect(body.nodes.find((n) => n.id === NODE_ID)?.isHub).toBe(true);

      const frames: Uint8Array[] = [];
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        send(d: Uint8Array) {
          frames.push(d);
          return d.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const enrollPk = new Uint8Array(32).fill(1);
      const certificate = new Uint8Array([9, 8, 7]);
      const certSig = new Uint8Array(64).fill(2);
      const otherFrames: Uint8Array[] = [];
      const other = {
        data: { kind: MESH_WS_KIND, sid: `${sid}-other`, uid: mesh.boot.userId },
        send(d: Uint8Array) {
          otherFrames.push(d);
          return d.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(other);
      mesh.runtime.mesh.forwardEnrollRedeemed({
        enrollPk,
        certificate,
        certSig,
        nodeId: PEER_ID,
        entrySid: sid,
      });
      expect(frames).toHaveLength(1);
      expect(otherFrames).toHaveLength(0);
      const frame = frames[0];
      if (!frame) throw new Error('missing ENROLL_REDEEMED frame');
      const env = wsBorsh.decodeEnvelope(frame);
      expect(env.kind).toBe(wsBorsh.KIND_ENROLL_REDEEMED);
      const payload = wsBorsh.decodePayload(wsBorsh.schema.EnrollRedeemedSchema, env.payload);
      expect(payload.nodeId).toBe(PEER_ID);
      expect(payload.enrollPk).toEqual(enrollPk);
      expect(payload.certificate).toEqual(certificate);
      expect(payload.certSig).toEqual(certSig);
      mesh.runtime.mesh.forwardEnrollRedeemed({
        enrollPk,
        certificate,
        certSig,
        nodeId: PEER_ID,
      });
      expect(frames).toHaveLength(1);
      expect(otherFrames).toHaveLength(0);
    } finally {
      mesh.close();
    }
  });

  test('GET /api/mesh/rtc-config and POST /api/rtc/authorize', async () => {
    const mesh = await bootMesh({
      rtc: {
        config: { getRtcConfig: () => ({ stun: ['stun:ex'], turn: null }) },
      },
    });
    try {
      const denied = await call(mesh.runtime, 'http://localhost/api/mesh/rtc-config');
      expect(denied.status).toBe(401);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cfg = await call(mesh.runtime, 'http://localhost/api/mesh/rtc-config', {
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      expect(await cfg.json()).toEqual({ stun: ['stun:ex'], turn: null });
    } finally {
      mesh.close();
    }

    const noRtc = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(noRtc.runtime, noRtc.boot);
      const authz = await call(noRtc.runtime, 'http://localhost/api/rtc/authorize', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          rtcSession: 's1',
          fp_browser: { algorithm: 'sha-256', value: 'AA' },
        }),
      });
      expect(authz.status).toBe(503);
      expect((await authz.json()).code).toBe('DIRECT_UNAVAILABLE');
    } finally {
      noRtc.close();
    }

    const withFp = await bootMesh();
    try {
      const runtime = new (await import('./mesh-http')).MeshHttpRuntime({
        roles: { hub: false, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: withFp.userStore,
        keyLogService: withFp.keyLogService,
        challengeStore: withFp.challengeStore,
        nodeSessionStore: withFp.nodeSessionStore,
        peers: withFp.peers,
        streams: withFp.streams,
        publisher: { publish() {} },
        rtc: {
          fingerprint: {
            authorizeBrowser: () => ({
              nonce: new Uint8Array(32).fill(7),
              fpNode: { algorithm: 'sha-256', value: 'BB' },
            }),
          },
        },
        primaryUserId: withFp.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, withFp.boot);
      const ok = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/rtc/authorize', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: `tmex_s_self=${sid}`,
            },
            body: JSON.stringify({
              rtcSession: 's1',
              fp_browser: { algorithm: 'sha-256', value: 'AA' },
            }),
          }),
          dummyServer
        )
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { nonce: string; fp_node: { value: string } };
      expect(body.fp_node.value).toBe('BB');
      expect(body.nonce.length).toBeGreaterThan(10);
      runtime.stop();
    } finally {
      withFp.close();
    }
  });

  test('GET /api/mesh/connection and authorize bind connectionId; 409 when multiple', async () => {
    const { MeshHttpRuntime } = await import('./mesh-http');
    const mesh = await bootMesh();
    try {
      const lookups: Array<{ sid: string; via: string; connectionId?: string | null }> = [];
      let mode: 'one' | 'many' | 'none' | 'match' = 'one';
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: true },
        nodeId: NODE_ID,
        nodePk: NODE_PK,
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        peers: mesh.peers,
        streams: mesh.streams,
        publisher: { publish() {} },
        rtc: {
          fingerprint: {
            authorizeBrowser: (input) => ({
              nonce: new Uint8Array(32).fill(7),
              fpNode: { algorithm: 'sha-256', value: input.connectionId ?? 'none' },
            }),
          },
        },
        connectionLookup: (input) => {
          lookups.push(input);
          if (mode === 'none') return { ok: false, code: 'NO_CONNECTION' };
          if (mode === 'many' && !input.connectionId) {
            return { ok: false, code: 'MULTIPLE_CONNECTIONS' };
          }
          return { ok: true, connectionId: input.connectionId || 'conn-latest' };
        },
        primaryUserId: mesh.boot.userId,
      });
      const { sid } = await challengeAndLogin(runtime, mesh.boot);
      const cookie = `tmex_s_self=${sid}`;
      const one = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection', { headers: { cookie } }),
          dummyServer
        )
      );
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({ connectionId: 'conn-latest' });

      mode = 'many';
      const many = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection', { headers: { cookie } }),
          dummyServer
        )
      );
      expect(many.status).toBe(409);
      expect((await many.json()).code).toBe('MULTIPLE_CONNECTIONS');

      const headered = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/mesh/connection', {
            headers: { cookie, 'x-tmex-connection': 'tab-a' },
          }),
          dummyServer
        )
      );
      expect(headered.status).toBe(200);
      expect(await headered.json()).toEqual({ connectionId: 'tab-a' });

      const conflict = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/rtc/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({
              rtcSession: 's1',
              fp_browser: { algorithm: 'sha-256', value: 'AA' },
            }),
          }),
          dummyServer
        )
      );
      expect(conflict.status).toBe(409);

      const ok = asResponse(
        await runtime.handleRequest(
          new Request('http://localhost/api/rtc/authorize', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({
              rtcSession: 's1',
              connectionId: 'tab-a',
              fp_browser: { algorithm: 'sha-256', value: 'AA' },
            }),
          }),
          dummyServer
        )
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { fp_node: { value: string } };
      expect(body.fp_node.value).toBe('tab-a');
      expect(lookups.some((row) => row.connectionId === 'tab-a')).toBe(true);
      runtime.stop();
    } finally {
      mesh.close();
    }
  });

  test('/mesh/ws requires session and broadcasts NODE_EVENT', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      let rejectData: unknown;
      const denyServer = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          rejectData = opts?.data;
          return true;
        },
      };
      const denied = await mesh.runtime.handleRequest(
        new Request('http://localhost/mesh/ws'),
        denyServer
      );
      expect(denied).toBeUndefined();
      expect(rejectData).toEqual({ kind: MESH_REJECT_4401_KIND });
      let closed: number | undefined;
      const rejectWs = {
        data: { kind: MESH_REJECT_4401_KIND },
        send() {},
        close(code?: number) {
          closed = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(rejectWs);
      expect(closed).toBe(WS_CLOSE_LOGIN_REQUIRED);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let data: { kind?: string; sid?: string; uid?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const up = await mesh.runtime.handleRequest(
        new Request('http://localhost/mesh/ws', { headers: { cookie: `tmex_s_self=${sid}` } }),
        server
      );
      expect(up).toBeUndefined();
      expect(data?.kind).toBe(MESH_WS_KIND);
      expect(data?.sid).toBe(sid);
      expect(data?.uid).toBe(mesh.boot.userId);

      const frames: Uint8Array[] = [];
      let loggedOut: number | undefined;
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        send(d: Uint8Array) {
          frames.push(d);
          return d.byteLength;
        },
        close(code?: number) {
          loggedOut = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      peers.emit({ nodeId: PEER_ID, status: 'online' });
      expect(frames.length).toBe(1);
      const frame = frames[0];
      if (!frame) throw new Error('missing NODE_EVENT frame');
      const env = wsBorsh.decodeEnvelope(frame);
      expect(env.kind).toBe(wsBorsh.KIND_NODE_EVENT);

      const logout = await call(mesh.runtime, 'http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      expect(logout.status).toBe(200);
      expect(loggedOut).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('/mesh/ws RTC_SIGNAL from browsers is forced from=browser and node frames are ignored', async () => {
    const sent: Array<{ from: string; owner?: { uid: string; sid: string } }> = [];
    const mesh = await bootMesh({
      rtc: {
        signals: {
          send(signal, owner) {
            sent.push({ from: signal.from, owner });
          },
          subscribe() {
            return () => {};
          },
        },
      },
    });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const ws = {
        data: { kind: MESH_WS_KIND, sid, uid: mesh.boot.userId },
        send() {},
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const nodeFrame = encodeRtcSignal(wsBorsh.RTC_SIGNAL_FROM_NODE);
      mesh.runtime.handleWebSocket.message(ws, nodeFrame);
      expect(sent).toEqual([]);
      const browserFrame = encodeRtcSignal(wsBorsh.RTC_SIGNAL_FROM_BROWSER);
      mesh.runtime.handleWebSocket.message(ws, browserFrame);
      expect(sent).toEqual([{ from: 'browser', owner: { uid: mesh.boot.userId, sid } }]);
    } finally {
      mesh.close();
    }
  });
});

function encodeRtcSignal(from: number): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
    rtcSession: 'sess-1',
    from,
    to: 'node-a',
    sdp: 'offer',
    candidate: null,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, payload, 1);
}
