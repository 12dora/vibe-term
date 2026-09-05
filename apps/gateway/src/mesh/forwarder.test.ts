import { describe, expect, test } from 'bun:test';
import { type NodeUnreachableReason, wsBorsh } from '@tmex/shared';
import { LinkError, type LinkSession } from '@tmex/shared/link';
import {
  FakePeers,
  FakeStreams,
  FakeWs,
  NODE_ID,
  asResponse,
  bootMesh,
  call,
  challengeAndLogin,
  dummyServer,
} from './auth-routes.test';
import {
  DEFAULT_PENDING_FORWARD_STREAM_TTL_MS,
  Forwarder,
  expirePendingForwardStream,
  getSelfRewrite,
  pendingForwardStreamCount,
  setPendingForwardStreamTtlMs,
} from './forwarder';
import {
  CHALLENGE_RATE_LIMIT,
  MESH_FORWARD_CSP,
  MESH_FORWARD_WS_KIND,
  MESH_REJECT_4401_KIND,
  type MeshServerWebSocket,
  STREAM_QUEUE_MAX_BYTES,
  STREAM_QUEUE_MAX_FRAMES,
  STREAM_QUEUE_OVERFLOW_REASON,
  X_TMEX_SET_SESSION,
  isMeshRewritten,
} from './mesh-deps';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';
import { X_TMEX_CLEAR_SHARE, X_TMEX_SET_SHARE, X_TMEX_SET_SHARE_MAX_AGE } from './share-credential';
import { waitUntil } from './test-support';
import { NodeUnreachableError, PeerHandshakeError } from './types';

const OTHER = 'bb'.repeat(16);
const dummyLink = {} as LinkSession;

describe('forwarder', () => {
  test('self fallthrough rewrites path and returns rewritten Request', async () => {
    const mesh = await bootMesh();
    try {
      const req = new Request('http://localhost/n/self/api/devices');
      const res = await mesh.runtime.handleRequest(req, dummyServer);
      expect(isMeshRewritten(res)).toBe(true);
      if (!isMeshRewritten(res)) throw new Error('expected rewrite');
      expect(new URL(res.rewritten.url).pathname).toBe('/api/devices');
      expect(getSelfRewrite(req)).toBe('/api/devices');
      expect(mesh.runtime.rewriteSelf(req)).not.toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('/n/self/api/auth/mode is handled internally', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/n/self/api/auth/mode');
      expect(res.status).toBe(200);
      expect((await res.json()).mode).toBe('mesh');
    } finally {
      mesh.close();
    }
  });

  test('unreachable node → 503 NODE_UNREACHABLE', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request('http://localhost/n/deadbeefdeadbeefdeadbeefdeadbeef/api/ping'),
          dummyServer
        )
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        code: 'NODE_UNREACHABLE',
        nodeId: 'deadbeefdeadbeefdeadbeefdeadbeef',
        reason: 'no_link',
      });
    } finally {
      mesh.close();
    }
  });

  test('NODE_UNREACHABLE reason 来自错误类别，不泄漏原文', async () => {
    const cases: Array<{ err: unknown; reason: NodeUnreachableReason }> = [
      { err: new NodeUnreachableError(OTHER, 'not admitted'), reason: 'not_admitted' },
      { err: new NodeUnreachableError(OTHER, 'revoked'), reason: 'not_admitted' },
      {
        err: new PeerHandshakeError('unknown', `no node_certs for ${OTHER}`),
        reason: 'handshake_failed',
      },
      { err: new PeerHandshakeError('timeout', 'handshake timeout'), reason: 'timeout' },
      { err: new LinkError('rst', 'quota-streams'), reason: 'relay_reset:quota-streams' },
      { err: new LinkError('rst', 'self-target'), reason: 'relay_reset:self-target' },
      { err: new LinkError('rst', 'unknown-target'), reason: 'relay_reset:unknown-target' },
      { err: new LinkError('rst', 'offline'), reason: 'relay_reset:offline' },
      { err: new LinkError('rst', 'open-failed'), reason: 'relay_reset:open-failed' },
      { err: new DOMException('The operation was aborted.', 'AbortError'), reason: 'timeout' },
      { err: new Error('https://evil.example/token=secret'), reason: 'no_link' },
    ];
    for (const { err, reason } of cases) {
      const peers = new FakePeers();
      peers.links.set(OTHER, dummyLink);
      const streams = new FakeStreams();
      streams.httpOpenError = err instanceof Error ? err : new Error(String(err));
      const mesh = await bootMesh({ peers, streams });
      try {
        const res = asResponse(
          await mesh.runtime.handleRequest(
            new Request(`http://localhost/n/${OTHER}/api/ping`, { method: 'POST' }),
            dummyServer
          )
        );
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          code: 'NODE_UNREACHABLE',
          nodeId: OTHER,
          reason,
        });
      } finally {
        mesh.close();
      }
    }
  });

  test('filters request headers; SVG/HTML → octet-stream attachment; PNG passes; unknown header dropped; CSP set', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response('<svg></svg>', {
      headers: {
        'content-type': 'image/svg+xml',
        'x-evil': '1',
        'cache-control': 'no-store',
        'set-cookie': 'stolen=1',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const svg = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/file`, {
            headers: {
              cookie: 'tmex_s_self=abc',
              authorization: 'Bearer x',
              host: 'evil.example',
              connection: 'keep-alive',
              upgrade: 'websocket',
              'proxy-authorization': 'x',
              'x-forwarded-for': '1.1.1.1',
              accept: 'image/*',
              'cf-connecting-ip': '203.0.113.9',
              'cf-access-jwt-assertion': 'header.payload.sig',
              'cf-access-authenticated-user-email': 'user@example.com',
              'cf-ray': 'abc123',
              'x-tmex-client-source': 'local',
            },
          }),
          dummyServer
        )
      );
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toBe('application/octet-stream');
      expect(svg.headers.get('content-disposition')).toBe('attachment');
      expect(svg.headers.get('x-evil')).toBeNull();
      expect(svg.headers.get('set-cookie')).toBeNull();
      expect(svg.headers.get('content-security-policy')).toBe(MESH_FORWARD_CSP);
      expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
      expect(svg.headers.get('cache-control')).toBe('no-store');
      expect(streams.lastOpen?.headers.cookie).toBeUndefined();
      expect(streams.lastOpen?.headers.authorization).toBeUndefined();
      expect(streams.lastOpen?.headers.host).toBeUndefined();
      expect(streams.lastOpen?.headers.connection).toBeUndefined();
      expect(streams.lastOpen?.headers.accept).toBe('image/*');
      expect(streams.lastOpen?.headers['cf-connecting-ip']).toBeUndefined();
      expect(streams.lastOpen?.headers['cf-access-jwt-assertion']).toBeUndefined();
      expect(streams.lastOpen?.headers['cf-access-authenticated-user-email']).toBeUndefined();
      expect(streams.lastOpen?.headers['cf-ray']).toBeUndefined();
      expect(streams.lastOpen?.headers['x-tmex-client-source']).toBeUndefined();

      streams.nextResponse = new Response('<html></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      const html = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/page`),
          dummyServer
        )
      );
      expect(html.headers.get('content-type')).toBe('application/octet-stream');
      expect(html.headers.get('content-disposition')).toBe('attachment');

      streams.nextResponse = new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      });
      const png = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/img`),
          dummyServer
        )
      );
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(png.headers.get('content-disposition')).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('stamps x-tmex-client-source: local for trusted entry clients and drops browser forgeries', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const mesh = await bootMesh({ peers, streams });
    try {
      const local = await call(mesh.runtime, `http://localhost/n/${OTHER}/api/auth/mode`, {
        clientIp: '127.0.0.1',
        headers: { 'x-tmex-client-source': 'forged' },
      });
      expect(local.status).toBe(200);
      expect(streams.lastOpen?.headers['x-tmex-client-source']).toBe('local');
      expect(streams.lastOpen?.path).toBe('/api/auth/mode');

      streams.nextResponse = new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
      const lan = await call(mesh.runtime, `http://localhost/n/${OTHER}/api/auth/login`, {
        method: 'POST',
        clientIp: '192.168.1.5',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(lan.status).toBe(200);
      expect(streams.lastOpen?.headers['x-tmex-client-source']).toBe('local');
      expect(streams.lastOpen?.path).toBe('/api/auth/login');

      streams.nextResponse = new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
      const publicSrc = await call(mesh.runtime, `http://localhost/n/${OTHER}/api/auth/mode`, {
        clientIp: '203.0.113.10',
        headers: { 'x-tmex-client-source': 'local' },
      });
      expect(publicSrc.status).toBe(200);
      expect(streams.lastOpen?.headers['x-tmex-client-source']).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('401 from remote /api/auth/login keeps the target code', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/login`, { method: 'POST' }),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'INVALID_CREDENTIALS' });
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('401 from target is augmented with NODE_LOGIN_REQUIRED', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ error: 'via_mismatch' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`, {
            headers: { cookie: `tmex_s_${OTHER}=stale` },
          }),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'via_mismatch',
        code: 'NODE_LOGIN_REQUIRED',
        nodeId: OTHER,
      });
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_${OTHER}=`);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=0');
      expect(cookie.includes('Secure')).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('401 via_mismatch expires the stale per-node cookie with login attributes', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ error: 'via_mismatch' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`https://entry.example/n/${OTHER}/api/devices`, {
            headers: { cookie: `tmex_s_${OTHER}=stale-sid` },
          }),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'via_mismatch',
        code: 'NODE_LOGIN_REQUIRED',
        nodeId: OTHER,
      });
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toBe(`tmex_s_${OTHER}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
    } finally {
      mesh.close();
    }
  });

  test('x-tmex-set-session becomes Set-Cookie tmex_s_<id> on entry', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ sid: 'abc', expires_at: 1 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [X_TMEX_SET_SESSION]: 'sessidvalue;64800',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
          dummyServer
        )
      );
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_${OTHER}=sessidvalue`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Max-Age=64800');
      expect(res.headers.get(X_TMEX_SET_SESSION)).toBeNull();
      expect(streams.lastOpen?.auth).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('entry rate-limits forwarded challenge by client IP and does not forward the 61st', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponseFactory = () =>
      new Response(JSON.stringify({ challenge_id: 'c1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const mesh = await bootMesh({ peers, streams });
    try {
      const ip = '203.0.113.70';
      const url = `http://localhost/n/${OTHER}/api/auth/challenge`;
      for (let i = 0; i < CHALLENGE_RATE_LIMIT; i += 1) {
        const res = await call(mesh.runtime, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uid: mesh.boot.userId }),
          clientIp: ip,
        });
        expect(res.status).toBe(200);
      }
      expect(streams.httpOpenCount).toBe(CHALLENGE_RATE_LIMIT);
      const blocked = await call(mesh.runtime, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: mesh.boot.userId }),
        clientIp: ip,
      });
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).code).toBe('RATE_LIMITED');
      expect(streams.httpOpenCount).toBe(CHALLENGE_RATE_LIMIT);

      const other = await call(mesh.runtime, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: mesh.boot.userId }),
        clientIp: '203.0.113.71',
      });
      expect(other.status).toBe(200);
      expect(streams.httpOpenCount).toBe(CHALLENGE_RATE_LIMIT + 1);
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws pumps frames both ways', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let data: { kind?: string; token?: string; auth?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(data?.kind).toBe(MESH_FORWARD_WS_KIND);
      expect(streams.wsAuth).toBe('remote-sid');
      expect(streams.wsCid).toBeUndefined();

      const sent: Uint8Array[] = [];
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send(frame: Uint8Array) {
          sent.push(frame);
          return frame.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      mesh.runtime.handleWebSocket.message(ws, new Uint8Array([1, 2, 3]));
      expect(streams.lastWs?.sent[0]).toEqual(new Uint8Array([1, 2, 3]));
      streams.lastWs?.pushFromRemote(new Uint8Array([9, 9]));
      expect(sent[0]).toEqual(new Uint8Array([9, 9]));
      void sid;
    } finally {
      mesh.close();
    }
  });

  test('MESH_FORWARD_WS pauses remote→browser pump on send -1 until drain and closes on 0', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string; token?: string; auth?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      const sent: Uint8Array[] = [];
      const closed: Array<{ code?: number; reason?: string }> = [];
      let sendResult = 2;
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send(frame: Uint8Array) {
          sent.push(frame.slice());
          return sendResult;
        },
        close(code?: number, reason?: string) {
          closed.push({ code, reason });
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      streams.lastWs?.pushFromRemote(new Uint8Array([1]));
      expect(sent).toEqual([new Uint8Array([1])]);

      sendResult = -1;
      streams.lastWs?.pushFromRemote(new Uint8Array([2]));
      expect(sent).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
      streams.lastWs?.pushFromRemote(new Uint8Array([3]));
      expect(sent).toHaveLength(2);

      sendResult = 2;
      mesh.runtime.handleWebSocket.drain(ws);
      expect(sent[2]).toEqual(new Uint8Array([3]));

      sendResult = 0;
      streams.lastWs?.pushFromRemote(new Uint8Array([4]));
      expect(closed.some((row) => row.code === 1011 && row.reason === 'forward-ws-closed')).toBe(
        true
      );
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws?cid= passes the client nonce through openWsStream', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws?cid=tab-nonce`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(data?.kind).toBe(MESH_FORWARD_WS_KIND);
      expect(streams.wsAuth).toBe('remote-sid');
      expect(streams.wsCid).toBe('tab-nonce');
    } finally {
      mesh.close();
    }
  });

  test('browser close before forward WS open drops the pending remote stream', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string; token?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const prior = pendingForwardStreamCount();
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(pendingForwardStreamCount()).toBe(prior + 1);
      const remote = streams.lastWs;
      expect(remote?.closedOnce).toBe(false);
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send() {
          return 0;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.close(ws);
      expect(pendingForwardStreamCount()).toBe(prior);
      expect(remote?.closedOnce).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('pending stream expiry is identity-checked', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string; token?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const prior = pendingForwardStreamCount();
      await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      const token = data?.token;
      const remote = streams.lastWs;
      if (!remote || typeof token !== 'string') throw new Error('expected pending stream');
      const other = new FakeWs();
      expirePendingForwardStream(token, other);
      expect(pendingForwardStreamCount()).toBe(prior + 1);
      expect(remote.closedOnce).toBe(false);
      expect(other.closedOnce).toBe(false);
      expirePendingForwardStream(token, remote);
      expect(pendingForwardStreamCount()).toBe(prior);
      expect(remote.closedOnce).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('pending stream survives delayed WS open past the old 15s TTL', async () => {
    const scale = 1_500;
    const ttl = DEFAULT_PENDING_FORWARD_STREAM_TTL_MS / scale;
    setPendingForwardStreamTtlMs(ttl);
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const server = {
        upgrade(_req: Request, _opts?: { data?: unknown }) {
          return true;
        },
      };
      const prior = pendingForwardStreamCount();
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(pendingForwardStreamCount()).toBe(prior + 1);
      const remote = streams.lastWs;
      await new Promise((resolve) => setTimeout(resolve, 15_000 / scale + 5));
      expect(pendingForwardStreamCount()).toBe(prior + 1);
      expect(remote?.closedOnce).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, ttl - 15_000 / scale + 20));
      expect(pendingForwardStreamCount()).toBe(prior);
      expect(remote?.closedOnce).toBe(true);
    } finally {
      setPendingForwardStreamTtlMs(DEFAULT_PENDING_FORWARD_STREAM_TTL_MS);
      mesh.close();
    }
  });

  test('DEVICE_CONNECTED is forwarded once per device; malformed payload still forwarded', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const sent: Uint8Array[] = [];
      ws.send = (frame: Uint8Array) => {
        sent.push(frame);
        return frame.byteLength;
      };
      const connected = encodeDeviceConnectedFrame('dev-1');
      streams.lastWs?.pushFromRemote(connected);
      streams.lastWs?.pushFromRemote(connected);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual(connected);
      const malformed = wsBorsh.encodeEnvelope(
        wsBorsh.KIND_DEVICE_CONNECTED,
        new Uint8Array([0xff, 0x00]),
        9
      );
      streams.lastWs?.pushFromRemote(malformed);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(malformed);
    } finally {
      mesh.close();
    }
  });

  test('对端节点低于 canonical v1.1 门槛时向浏览器报错并断流', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const sent: Uint8Array[] = [];
      ws.send = (frame: Uint8Array) => {
        sent.push(frame);
        return frame.byteLength;
      };
      streams.lastWs?.pushFromRemote(encodeHelloS2CFrame('1.1.21'));

      expect(sent).toHaveLength(1);
      const env = wsBorsh.decodeEnvelope(sent[0] as Uint8Array);
      expect(env.kind).toBe(wsBorsh.KIND_ERROR);
      const error = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, env.payload);
      expect(error.code).toBe(wsBorsh.ERROR_UNSUPPORTED_PROTOCOL);
      expect(error.message).toContain('canonical-state-v1.1 required');
      expect(error.retryable).toBe(false);
      expect(closed()?.code).toBe(1002);
      // 拒绝路径必须把上游 mesh 流也断掉，否则远端 GatewaySession 一直挂着。
      expect(streams.lastWs?.closedOnce).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('对端节点满足门槛时正常转发 HELLO_S2C', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const sent: Uint8Array[] = [];
      ws.send = (frame: Uint8Array) => {
        sent.push(frame);
        return frame.byteLength;
      };
      const hello = encodeHelloS2CFrame('1.1.23');
      streams.lastWs?.pushFromRemote(hello);

      expect(sent).toEqual([hello]);
      expect(closed()).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('切换后的新流不答 HELLO 时报错断流，不补订阅也不冲队列', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    answerHelloOnNewStreams(streams, (index) =>
      index === 0 ? encodeHelloS2CFrame('1.1.23') : null
    );
    const origGetLink = peers.getLink.bind(peers);
    let blockLink = false;
    let releaseLink: (() => void) | undefined;
    peers.getLink = async (nodeId: string) => {
      if (blockLink) {
        await new Promise<void>((resolve) => {
          releaseLink = resolve;
        });
      }
      return origGetLink(nodeId);
    };
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const sent: Uint8Array[] = [];
      ws.send = (frame: Uint8Array) => {
        sent.push(frame);
        return frame.byteLength;
      };
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      mesh.runtime.handleWebSocket.message(
        ws,
        encodeCanonicalSub(1n, '%1', 2, new Uint8Array(16).fill(5))
      );
      blockLink = true;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => releaseLink !== undefined, 2_000);
      const queued = new Uint8Array([0xa1, 0xa2]);
      mesh.runtime.handleWebSocket.message(ws, queued);
      releaseLink?.();
      await waitUntil(() => closed() !== undefined, 2_000);

      expect(closed()).toEqual({ code: 1002, reason: 'node-too-old' });
      const errors = decodeErrorFrames(sent);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(wsBorsh.ERROR_UNSUPPORTED_PROTOCOL);
      expect(errors[0]?.message).toContain('canonical-state-v1.1 required');
      const second = streams.wsOpens[1]?.ws;
      expect(second?.closedOnce).toBe(true);
      // 只补发了 HELLO：订阅没重放，排队的浏览器帧也没冲进去。
      expect(second?.sent).toHaveLength(1);
      expect(isHelloC2S(second?.sent[0] as Uint8Array)).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('切换后的新流回了坏 HELLO 时不沿用上一条流的版本判定', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    answerHelloOnNewStreams(streams, (index) =>
      index === 0 ? encodeHelloS2CFrame('1.1.23') : malformedHelloS2CFrame()
    );
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const sent: Uint8Array[] = [];
      ws.send = (frame: Uint8Array) => {
        sent.push(frame);
        return frame.byteLength;
      };
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => closed() !== undefined, 2_000);

      expect(closed()).toEqual({ code: 1002, reason: 'node-too-old' });
      const errors = decodeErrorFrames(sent);
      expect(errors).toHaveLength(1);
      // message 点名被拒的节点：浏览器只有靠它才知道是哪一个节点太旧
      expect(errors[0]?.message).toBe(
        `canonical-state-v1.1 required: node ${OTHER} version unknown < ${wsBorsh.CANONICAL_V11_MIN_PEER_VERSION}`
      );
      expect(streams.wsOpens[1]?.ws.closedOnce).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws without cookie closes 4401', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const mesh = await bootMesh({ peers });
    try {
      let data: { kind?: string; auth?: string | null } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const res = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`),
        server
      );
      expect(res).toBeUndefined();
      expect(data?.kind).toBe(MESH_REJECT_4401_KIND);
      let closed: number | undefined;
      const ws = {
        data: data ?? { kind: MESH_REJECT_4401_KIND, auth: null },
        send() {},
        close(code?: number) {
          closed = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      expect(closed).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws 4401 HTTP fallback (upgrade refused) never touches tmex_s_<target>', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const mesh = await bootMesh({ peers });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(new Request(`http://localhost/n/${OTHER}/ws`), {
          upgrade: () => false,
        })
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        code: 'NODE_LOGIN_REQUIRED',
        nodeId: OTHER,
      });
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws 4401 HTTP fallback does not emit Set-Cookie for non-canonical node ids', async () => {
    const mesh = await bootMesh({ peers: new FakePeers() });
    const refused = { upgrade: () => false };
    try {
      const cases = [
        'http://localhost/n/self%3D/ws',
        'http://localhost/n/aa%3Btmex_s_self/ws',
        'http://localhost/n/aa%00bb/ws',
        'http://localhost/n/aa%1bbb/ws',
        `http://localhost/n/${OTHER.toUpperCase()}/ws`,
        'http://localhost/n/deadbeef/ws',
      ];
      for (const url of cases) {
        const res = asResponse(await mesh.runtime.handleRequest(new Request(url), refused));
        expect(res.status).toBe(401);
        expect(res.headers.get('set-cookie')).toBeNull();
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('NODE_LOGIN_REQUIRED');
      }
    } finally {
      mesh.close();
    }
  });

  test('401 augmentation reads at most 64 KiB and drops representation headers', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const huge = 'x'.repeat(80 * 1024);
    streams.nextResponse = new Response(huge, {
      status: 401,
      headers: {
        'content-type': 'text/plain',
        'content-length': String(huge.length),
        'content-range': 'bytes 0-10/11',
        etag: '"abc"',
        'content-disposition': 'inline',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('content-length')).toBeNull();
      expect(res.headers.get('content-range')).toBeNull();
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('content-disposition')).toBeNull();
      const body = (await res.json()) as { message?: string; code: string; nodeId: string };
      expect(body.code).toBe('NODE_LOGIN_REQUIRED');
      expect(body.nodeId).toBe(OTHER);
      expect(body.message?.length).toBe(64 * 1024);
    } finally {
      mesh.close();
    }
  });

  test('logout x-tmex-set-session ;0 clears the target cookie', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [X_TMEX_SET_SESSION]: ';0',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/logout`, { method: 'POST' }),
          dummyServer
        )
      );
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_${OTHER}=`);
      expect(cookie).toContain('Max-Age=0');
      expect(res.headers.get(X_TMEX_SET_SESSION)).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('upstream WS abort fails over to another link, replays canonical subscription, keeps browser open', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const logs: string[] = [];
    const mesh = await bootMesh({
      peers,
      streams,
      sleep: async () => {},
      streamLog: (line) => logs.push(line),
    });
    try {
      let data: { kind?: string; token?: string; auth?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws?cid=tab-a`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      let browserClosed: { code?: number; reason?: string } | undefined;
      const sent: Uint8Array[] = [];
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send(frame: Uint8Array) {
          sent.push(frame);
          return frame.byteLength;
        },
        close(code?: number, reason?: string) {
          browserClosed = { code, reason };
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const hello = encodeHelloFrame();
      const epoch = new Uint8Array(16).fill(5);
      const subscribe = encodeCanonicalSub(1n, '%1', 2, epoch);
      mesh.runtime.handleWebSocket.message(ws, hello);
      mesh.runtime.handleWebSocket.message(ws, subscribe);
      expect(streams.wsOpens).toHaveLength(1);
      expect(streams.wsOpens[0]?.link).toBe(dcLink);
      expect(streams.lastWs?.sent[0]).toEqual(hello);
      expect(streams.lastWs?.sent[1]).toEqual(subscribe);

      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      expect(browserClosed).toBeUndefined();
      expect(streams.wsOpens[1]?.link).toBe(relayLink);
      expect(streams.wsOpens[1]?.cid).toBe('tab-a');
      expect(streams.wsOpens[1]?.auth).toBe('remote-sid');
      const replayed = streams.wsOpens[1]?.ws.sent ?? [];
      expect(replayed[0]).toEqual(hello);
      expect(decodeCanonicalSubs(replayed).map((row) => row.paneIds)).toContainEqual(['%1']);
      expect(logs.some((line) => line.includes('[mesh][stream] failover'))).toBe(true);
      expect(logs.some((line) => /from=dc to=relay resumed=1/.test(line))).toBe(true);
      expect(
        logs.some((line) => line.includes('failover_start') && line.includes('cause=stream_close'))
      ).toBe(true);
      expect(
        logs.some((line) => line.includes('failover_summary') && line.includes('duration_ms='))
      ).toBe(true);

      streams.wsOpens[1]?.ws.pushFromRemote(new Uint8Array([9, 9]));
      expect(sent.at(-1)).toEqual(new Uint8Array([9, 9]));
    } finally {
      mesh.close();
    }
  });

  test('canonical pane cursor is patched onto SetPaneSubscriptions during failover', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const hello = encodeHelloFrame();
      const epoch = new Uint8Array(16).fill(7);
      const pane = { deviceId: 'dev-1', serverEpoch: epoch, paneId: '%1' };
      const subscribe = wsBorsh.encodeEnvelope(
        wsBorsh.KIND_CANONICAL_COMMAND,
        wsBorsh.encodeCanonicalCommandPayload({
          SetPaneSubscriptions: {
            generation: 3n,
            activePanes: [{ pane, cursor: { paneEpoch: epoch, terminalSeq: 10n } }],
            hotPanes: [],
          },
        }),
        4
      );
      mesh.runtime.handleWebSocket.message(ws, hello);
      mesh.runtime.handleWebSocket.message(ws, subscribe);
      streams.lastWs?.pushFromRemote(
        wsBorsh.encodeEnvelope(
          wsBorsh.KIND_CANONICAL_EVENT,
          wsBorsh.encodeCanonicalEventPayload({
            PaneData: {
              pane,
              paneEpoch: epoch,
              seqStart: 39n,
              seqEnd: 40n,
              data: new Uint8Array([1]),
            },
          }),
          8
        )
      );
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const replayed = streams.wsOpens[1]?.ws.sent ?? [];
      const commandFrame = replayed.find((frame) => {
        try {
          return wsBorsh.decodeEnvelope(frame).kind === wsBorsh.KIND_CANONICAL_COMMAND;
        } catch {
          return false;
        }
      });
      expect(commandFrame).toBeDefined();
      const decoded = wsBorsh.decodeCanonicalCommandPayload(
        wsBorsh.decodeEnvelope(commandFrame as Uint8Array).payload
      );
      expect('SetPaneSubscriptions' in decoded.command).toBe(true);
      if (!('SetPaneSubscriptions' in decoded.command)) throw new Error('expected subscribe');
      const sub = decoded.command.SetPaneSubscriptions;
      expect(sub.generation).toBe(4n);
      expect(sub.activePanes[0]?.cursor?.terminalSeq).toBe(40n);
    } finally {
      mesh.close();
    }
  });

  test('malformed canonical PaneData does not patch the failover cursor', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const epoch = new Uint8Array(16).fill(7);
      const pane = { deviceId: 'dev-1', serverEpoch: epoch, paneId: '%1' };
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      mesh.runtime.handleWebSocket.message(
        ws,
        wsBorsh.encodeEnvelope(
          wsBorsh.KIND_CANONICAL_COMMAND,
          wsBorsh.encodeCanonicalCommandPayload({
            SetPaneSubscriptions: {
              generation: 3n,
              activePanes: [{ pane, cursor: { paneEpoch: epoch, terminalSeq: 10n } }],
              hotPanes: [],
            },
          }),
          4
        )
      );
      const valid = wsBorsh.encodeCanonicalEventPayload({
        PaneData: {
          pane,
          paneEpoch: epoch,
          seqStart: 39n,
          seqEnd: 40n,
          data: new Uint8Array([1]),
        },
      });
      const malformed = valid.slice();
      new DataView(malformed.buffer, malformed.byteOffset, malformed.byteLength).setBigUint64(
        malformed.byteLength - 1 - 4 - 8,
        99n,
        true
      );
      streams.lastWs?.pushFromRemote(
        wsBorsh.encodeEnvelope(wsBorsh.KIND_CANONICAL_EVENT, malformed, 8)
      );
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const replayed = streams.wsOpens[1]?.ws.sent ?? [];
      const commandFrame = replayed.find((frame) => {
        try {
          return wsBorsh.decodeEnvelope(frame).kind === wsBorsh.KIND_CANONICAL_COMMAND;
        } catch {
          return false;
        }
      });
      expect(commandFrame).toBeDefined();
      const decoded = wsBorsh.decodeCanonicalCommandPayload(
        wsBorsh.decodeEnvelope(commandFrame as Uint8Array).payload
      );
      if (!('SetPaneSubscriptions' in decoded.command)) throw new Error('expected subscribe');
      expect(decoded.command.SetPaneSubscriptions.activePanes[0]?.cursor?.terminalSeq).toBe(10n);
    } finally {
      mesh.close();
    }
  });

  test('subscribe change sent mid-failover wins on the new link without generation conflict', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const origGetLink = peers.getLink.bind(peers);
    let blockLink = false;
    let releaseLink: (() => void) | undefined;
    peers.getLink = async (nodeId: string) => {
      if (blockLink) {
        await new Promise<void>((resolve) => {
          releaseLink = resolve;
        });
      }
      return origGetLink(nodeId);
    };
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const epoch = new Uint8Array(16).fill(7);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      mesh.runtime.handleWebSocket.message(ws, encodeCanonicalSub(3n, '%1', 4, epoch));
      blockLink = true;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => releaseLink !== undefined, 2_000);
      mesh.runtime.handleWebSocket.message(ws, encodeCanonicalSub(4n, '%2', 5, epoch));
      releaseLink?.();
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const subs = decodeCanonicalSubs(streams.wsOpens[1]?.ws.sent ?? []);
      expect(subs.length).toBeGreaterThan(0);
      for (let i = 1; i < subs.length; i += 1) {
        expect(subs[i]?.generation).toBeGreaterThan(subs[i - 1]?.generation ?? 0n);
      }
      expect(subs.at(-1)?.paneIds).toEqual(['%2']);
    } finally {
      mesh.close();
    }
  });

  test('closing the browser during failover getLink/openWsStream closes the orphan upstream', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const origOpen = streams.openWsStream.bind(streams);
    let blockOpen = false;
    let releaseOpen: (() => void) | undefined;
    streams.openWsStream = async (link, auth, cid) => {
      if (blockOpen) {
        await new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
      }
      return origOpen(link, auth, cid);
    };
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      expect(streams.wsOpens).toHaveLength(1);
      blockOpen = true;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => releaseOpen !== undefined, 2_000);
      mesh.runtime.handleWebSocket.close(ws);
      releaseOpen?.();
      await waitUntil(() => (streams.wsOpens[1]?.ws.closedOnce ?? false) === true, 2_000);
      expect(streams.wsOpens).toHaveLength(2);
      expect(streams.wsOpens[1]?.ws.closedOnce).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('failover retries until a link appears, then resumes; budget exhaustion closes the browser WS', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      peers.failGetLink = 2;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      expect(closed()).toBeUndefined();
      expect(streams.wsOpens[1]?.link).toBe(relayLink);
    } finally {
      mesh.close();
    }

    const peersDead = new FakePeers();
    peersDead.links.set(OTHER, dcLink);
    peersDead.transport.set(OTHER, 'dc');
    const streamsDead = new FakeStreams();
    const meshDead = await bootMesh({
      peers: peersDead,
      streams: streamsDead,
      sleep: async () => {},
    });
    try {
      const { ws, closed } = await openForwardWs(meshDead.runtime, peersDead, streamsDead, OTHER);
      peersDead.links.delete(OTHER);
      streamsDead.lastWs?.close(1011, 'reset');
      await waitUntil(() => closed() !== undefined, 2_000);
      expect(closed()?.reason).toBe('failover-exhausted');
    } finally {
      meshDead.close();
    }
  });

  test('queued frames during failover are flushed exactly once after resume', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const origGetLink = peers.getLink.bind(peers);
    let blockLink = false;
    let releaseLink: (() => void) | undefined;
    peers.getLink = async (nodeId: string) => {
      if (blockLink) {
        await new Promise<void>((resolve) => {
          releaseLink = resolve;
        });
      }
      return origGetLink(nodeId);
    };
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      blockLink = true;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => releaseLink !== undefined, 2_000);
      const queued = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x01]);
      mesh.runtime.handleWebSocket.message(ws, queued);
      releaseLink?.();
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const matches = (streams.wsOpens[1]?.ws.sent ?? []).filter((frame) =>
        bytesEqual(frame, queued)
      );
      expect(matches).toHaveLength(1);
    } finally {
      mesh.close();
    }
  });

  test('failover queue frame cap closes the browser instead of dropping frames', async () => {
    const { mesh, ws, closed, release } = await beginBlockedFailover();
    try {
      for (let i = 0; i < STREAM_QUEUE_MAX_FRAMES; i += 1) {
        mesh.runtime.handleWebSocket.message(ws, new Uint8Array([i & 0xff]));
      }
      expect(closed()).toBeUndefined();
      mesh.runtime.handleWebSocket.message(ws, new Uint8Array([0xee]));
      expect(closed()?.code).toBe(1011);
      expect(closed()?.reason).toBe(STREAM_QUEUE_OVERFLOW_REASON);
    } finally {
      release();
      mesh.close();
    }
  });

  test('failover queue byte cap closes the browser instead of dropping frames', async () => {
    const { mesh, ws, closed, release } = await beginBlockedFailover();
    try {
      const chunk = new Uint8Array(1024 * 1024);
      let queued = 0;
      while (queued + chunk.byteLength <= STREAM_QUEUE_MAX_BYTES) {
        mesh.runtime.handleWebSocket.message(ws, chunk);
        queued += chunk.byteLength;
      }
      expect(closed()).toBeUndefined();
      mesh.runtime.handleWebSocket.message(ws, chunk);
      expect(closed()?.code).toBe(1011);
      expect(closed()?.reason).toBe(STREAM_QUEUE_OVERFLOW_REASON);
    } finally {
      release();
      mesh.close();
    }
  });

  test('queued frames under the cap replay after failover', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const origGetLink = peers.getLink.bind(peers);
    let blockLink = false;
    let releaseLink: (() => void) | undefined;
    peers.getLink = async (nodeId: string) => {
      if (blockLink) {
        await new Promise<void>((resolve) => {
          releaseLink = resolve;
        });
      }
      return origGetLink(nodeId);
    };
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      blockLink = true;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      answerHelloOnNewStreams(streams);
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => releaseLink !== undefined, 2_000);
      const queued: Uint8Array[] = [];
      for (let i = 0; i < 8; i += 1) {
        const frame = new Uint8Array([0xa0, i, 0x0d, 0x0a]);
        queued.push(frame);
        mesh.runtime.handleWebSocket.message(ws, frame);
      }
      releaseLink?.();
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const sent = streams.wsOpens[1]?.ws.sent ?? [];
      for (const frame of queued) {
        expect(sent.filter((row) => bytesEqual(row, frame))).toHaveLength(1);
      }
    } finally {
      mesh.close();
    }
  });

  test('rejected stream write triggers failover once without unhandled rejection', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const events = process as unknown as {
      on(event: string, listener: (reason: unknown) => void): void;
      off(event: string, listener: (reason: unknown) => void): void;
    };
    events.on('unhandledRejection', onUnhandled);
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      const first = streams.lastWs;
      expect(first).not.toBeNull();
      if (!first) throw new Error('expected upstream ws');
      answerHelloOnNewStreams(streams);
      first.sendError = new Error('write-closed');
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      mesh.runtime.handleWebSocket.message(ws, new Uint8Array([0x11, 0x22]));
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      expect(closed()).toBeUndefined();
      expect(streams.wsOpens).toHaveLength(2);
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      events.off('unhandledRejection', onUnhandled);
      mesh.close();
    }
  });

  test('HTTP forward removes the request abort listener after success and error', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response('ok', { headers: { 'content-type': 'text/plain' } });
    const mesh = await bootMesh({ peers, streams });
    try {
      const success = trackAbort(new AbortController());
      const ok = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`, { signal: success.signal }),
          dummyServer
        )
      );
      expect(ok.status).toBe(200);
      expect(success.added).toBe(1);
      expect(success.removed).toBe(1);

      streams.httpOpenError = new Error('upstream down');
      const failure = trackAbort(new AbortController());
      const err = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/mutate`, {
            method: 'POST',
            body: 'x',
            signal: failure.signal,
          }),
          dummyServer
        )
      );
      expect(err.status).toBe(503);
      expect(failure.added).toBe(1);
      expect(failure.removed).toBe(1);
    } finally {
      mesh.close();
    }
  });

  test('GET http forward retries getLink after a transient failure', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    peers.failGetLink = 1;
    const streams = new FakeStreams();
    streams.nextResponse = new Response('ok', { headers: { 'content-type': 'text/plain' } });
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`),
          dummyServer
        )
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      mesh.close();
    }
  });

  test('retry.attempts 让非幂等方法重试；带 rawBody 时一律只推一次', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams, sleep: async () => {} });
    const cookie = `tmex_s_${OTHER}=remote-sid`;
    let opens = 0;
    streams.openHttpStream = async () => {
      opens += 1;
      throw new Error('link lost');
    };
    const deleteRes = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', { headers: { cookie } }),
      {
        nodeId: OTHER,
        method: 'DELETE',
        path: '/api/system/upgrade/package',
        retry: { attempts: 3 },
      }
    );
    expect(deleteRes.status).toBe(503);
    expect(opens).toBe(3);

    opens = 0;
    const rawBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const putRes = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', { headers: { cookie } }),
      {
        nodeId: OTHER,
        method: 'PUT',
        path: '/api/system/upgrade/package',
        rawBody,
        retry: { attempts: 5 },
      }
    );
    expect(putRes.status).toBe(503);
    // 流只能读一次：重发必须由调用方按偏移重建，转发层不能自作主张。
    expect(opens).toBe(1);
  });

  test('显式重试逐次重建 JSON 体：首次尝试锁住流后第二次仍能成功', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams, sleep: async () => {} });
    const sent: string[] = [];
    let opens = 0;
    streams.openHttpStream = async (_link, _open, body) => {
      opens += 1;
      if (body?.locked) throw new Error('ReadableStream is locked');
      if (opens === 1) {
        // 第一次尝试已经开始读，链路随后断掉：这条流永远处于 locked
        await body?.getReader().read();
        throw new Error('link lost');
      }
      sent.push(body ? await new Response(body).text() : '');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
      }),
      {
        nodeId: OTHER,
        method: 'DELETE',
        path: '/api/system/upgrade/package',
        retry: { attempts: 2 },
      }
    );
    expect(opens).toBe(2);
    expect(res.status).toBe(200);
    expect(sent).toEqual(['{}']);
  });

  test('rawBody 上行进度按节流回调，累计字节单调递增', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.openHttpStream = async (_link, _open, body) => {
      if (body) await new Response(body).arrayBuffer();
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams });
    const chunkBytes = 256 * 1024;
    const chunks = 4;
    const rawBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks; i += 1) controller.enqueue(new Uint8Array(chunkBytes));
        controller.close();
      },
    });
    const seen: number[] = [];
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        method: 'PUT',
        headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
      }),
      {
        nodeId: OTHER,
        method: 'PUT',
        path: '/api/system/upgrade/package',
        rawBody,
        headers: { 'content-type': 'application/octet-stream' },
        onProgress: (bytes) => seen.push(bytes),
      }
    );
    expect(res.status).toBe(200);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]).toBeLessThan(chunkBytes * chunks);
    expect(seen[seen.length - 1]).toBe(chunkBytes * chunks);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] as number).toBeGreaterThan(seen[i - 1] as number);
    }
  });

  test('abort during openHttpStream is classified as timeout, not lastError', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    let started = false;
    streams.openHttpStream = async (_link, _open, _body, signal) => {
      started = true;
      await new Promise<void>((_, reject) => {
        const fail = () => reject(new Error('link lost'));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener('abort', fail, { once: true });
      });
      throw new Error('unreachable');
    };
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const ac = new AbortController();
      const pending = mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/ping`, {
          method: 'POST',
          body: 'x',
          signal: ac.signal,
        }),
        dummyServer
      );
      await waitUntil(() => started);
      ac.abort();
      const res = asResponse(await pending);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        code: 'NODE_UNREACHABLE',
        nodeId: OTHER,
        reason: 'timeout',
      });
    } finally {
      mesh.close();
    }
  });
});

describe('forwardAuthorizedHttp', () => {
  test('GET retries a transient open failure; POST does not retry', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    let opens = 0;
    const orig = streams.openHttpStream.bind(streams);
    streams.openHttpStream = async (link, open, body, signal) => {
      opens += 1;
      if (opens === 1) throw new Error('transient');
      return orig(link, open, body, signal);
    };
    streams.nextResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const forwarder = new Forwarder({
      nodeId: NODE_ID,
      peers,
      streams,
      sleep: async () => {},
    });
    const cookie = `tmex_s_${OTHER}=remote-sid`;
    const getRes = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', { headers: { cookie } }),
      { nodeId: OTHER, method: 'GET', path: '/api/system/upgrade' }
    );
    expect(getRes.status).toBe(200);
    expect(opens).toBe(2);

    opens = 0;
    streams.openHttpStream = async () => {
      opens += 1;
      throw new Error('post failed');
    };
    const postRes = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        method: 'POST',
        headers: { cookie },
      }),
      { nodeId: OTHER, method: 'POST', path: '/api/system/upgrade', body: { version: '9.9.9' } }
    );
    expect(postRes.status).toBe(503);
    expect(await postRes.json()).toEqual({
      code: 'NODE_UNREACHABLE',
      nodeId: OTHER,
      reason: 'no_link',
    });
    expect(opens).toBe(1);
  });

  test('abort during openHttpStream is classified as timeout, not lastError', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    let started = false;
    streams.openHttpStream = async (_link, _open, _body, signal) => {
      started = true;
      await new Promise<void>((_, reject) => {
        const fail = () => reject(new Error('link lost'));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener('abort', fail, { once: true });
      });
      throw new Error('unreachable');
    };
    const forwarder = new Forwarder({
      nodeId: NODE_ID,
      peers,
      streams,
      sleep: async () => {},
    });
    const ac = new AbortController();
    const pending = forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        method: 'POST',
        headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        signal: ac.signal,
      }),
      { nodeId: OTHER, method: 'POST', path: '/api/system/upgrade', body: { version: '9.9.9' } }
    );
    await waitUntil(() => started);
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'NODE_UNREACHABLE',
      nodeId: OTHER,
      reason: 'timeout',
    });
  });

  test('sends the stored target-node session as stream auth', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ state: 'idle' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams });
    await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        headers: { cookie: `tmex_s_${OTHER}=sess-from-cookie` },
      }),
      { nodeId: OTHER, method: 'GET', path: '/api/system/upgrade' }
    );
    expect(streams.lastOpen?.auth).toBe('sess-from-cookie');
    expect(streams.lastOpen?.path).toBe('/api/system/upgrade');
    expect(streams.lastOpen?.method).toBe('GET');
  });

  test('missing target session → NODE_LOGIN_REQUIRED without opening a stream', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams });
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade'),
      { nodeId: OTHER, method: 'GET', path: '/api/system/upgrade' }
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'NODE_LOGIN_REQUIRED', nodeId: OTHER });
    expect(streams.lastOpen).toBeNull();
  });

  test('rawBody wins over JSON body and forwards custom headers', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const captured: {
      headers: Record<string, string>;
      body: Uint8Array | null;
      method: string;
      path: string;
      query: string;
    }[] = [];
    const streams = new FakeStreams();
    streams.openHttpStream = async (_link, open, body) => {
      const bytes = body ? new Uint8Array(await new Response(body).arrayBuffer()) : null;
      captured.push({
        headers: open.headers,
        body: bytes,
        method: open.method,
        path: open.path,
        query: open.query,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams });
    const raw = new Uint8Array([0, 1, 2, 3, 4]);
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        method: 'PUT',
        headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
      }),
      {
        nodeId: OTHER,
        method: 'PUT',
        path: '/api/system/upgrade/package',
        query: `?version=1.2.3&sha256=${'ab'.repeat(32)}`,
        body: { version: 'should-not-send' },
        rawBody: new ReadableStream({
          start(controller) {
            controller.enqueue(raw);
            controller.close();
          },
        }),
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(raw.byteLength),
        },
      }
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe('PUT');
    expect(captured[0]?.path).toBe('/api/system/upgrade/package');
    expect(captured[0]?.query).toBe(`?version=1.2.3&sha256=${'ab'.repeat(32)}`);
    expect(captured[0]?.headers['content-type']).toBe('application/octet-stream');
    expect(captured[0]?.headers['content-length']).toBe('5');
    expect(captured[0]?.body).toEqual(raw);
  });

  test('JSON POST body path stays compatible when rawBody is omitted', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const captured: { headers: Record<string, string>; body: string | null }[] = [];
    const streams = new FakeStreams();
    streams.openHttpStream = async (_link, open, body) => {
      captured.push({
        headers: open.headers,
        body: body ? await new Response(body).text() : null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams });
    await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        method: 'POST',
        headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
      }),
      { nodeId: OTHER, method: 'POST', path: '/api/system/upgrade', body: { version: '9.9.9' } }
    );
    expect(captured[0]?.headers['content-type']).toBe('application/json');
    expect(captured[0]?.body).toBe(JSON.stringify({ version: '9.9.9' }));
  });

  test('raw-body push failure logs bytes and includes the underlying error', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.openHttpStream = async (_link, _open, body) => {
      const reader = body?.getReader();
      if (reader) {
        await reader.read();
        await reader.cancel();
      }
      throw new Error('websocket send discarded');
    };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const forwarder = new Forwarder({ nodeId: NODE_ID, peers, streams });
    try {
      const raw = new Uint8Array(32).fill(4);
      const res = await forwarder.forwardAuthorizedHttp(
        new Request('http://localhost/api/mesh/nodes/x/upgrade', {
          method: 'PUT',
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        {
          nodeId: OTHER,
          method: 'PUT',
          path: '/api/system/upgrade/package',
          rawBody: new ReadableStream({
            start(controller) {
              controller.enqueue(raw);
              controller.close();
            },
          }),
          headers: { 'content-type': 'application/octet-stream' },
        }
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        code: 'NODE_UNREACHABLE',
        nodeId: OTHER,
        reason: 'no_link',
        error: 'websocket send discarded',
      });
      expect(warnings.some((line) => line.includes('[mesh][forward] raw-body push aborted'))).toBe(
        true
      );
      expect(warnings.some((line) => line.includes(`node=${OTHER}`))).toBe(true);
      expect(warnings.some((line) => line.includes('bytes=32'))).toBe(true);
      expect(warnings.some((line) => line.includes('err=websocket send discarded'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('forwardAuthorizedHttp multi-MiB raw body over in-memory link', () => {
  test('streams a 3 MiB request body through link flow control', async () => {
    const { createInMemoryLinkPair } = await import('@tmex/shared/link');
    const { acceptHttpStream, openHttpStream } = await import('./stream-targets');
    const [local, remote] = createInMemoryLinkPair();
    let received = 0;
    remote.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as never,
        async dispatchHttp(req) {
          const reader = req.body?.getReader();
          if (!reader) return new Response('no-body', { status: 400 });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value?.byteLength ?? 0;
          }
          return new Response(JSON.stringify({ received }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
    });
    const peers = new FakePeers();
    peers.links.set(OTHER, local);
    const forwarder = new Forwarder({
      nodeId: NODE_ID,
      peers,
      streams: {
        openHttpStream: (link, open, body, signal) => openHttpStream(link, open, body, signal),
        openWsStream: async () => {
          throw new Error('ws not used');
        },
      },
    });
    const total = 3 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024).fill(7);
    let remaining = total;
    const rawBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const n = Math.min(chunk.byteLength, remaining);
        controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
        remaining -= n;
      },
    });
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://localhost/api/mesh/nodes/x/upgrade', {
        method: 'PUT',
        headers: { cookie: `tmex_s_${OTHER}=remote-sid`, origin: 'http://localhost' },
      }),
      {
        nodeId: OTHER,
        method: 'PUT',
        path: '/api/system/upgrade/package',
        query: `?version=1.2.3&sha256=${'ab'.repeat(32)}`,
        rawBody,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(total),
        },
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: total });
    expect(received).toBe(total);
  });

  test('target 413 without cancelling the request body is visible to the entry, not 503', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createInMemoryLinkPair } = await import('@tmex/shared/link');
    const { acceptHttpStream, openHttpStream } = await import('./stream-targets');
    const { UpgradeController } = await import('../system/upgrade');
    const installDir = mkdtempSync(join(tmpdir(), 'tmex-fwd-413-'));
    const controller = new UpgradeController({
      getInstallInfo: () => ({
        installedViaCli: true,
        deployment: 'launchd',
        installDir,
        serviceName: 'tmex',
        cliVersion: '1.0.0',
        bunPath: '/usr/bin/bun',
      }),
      maxPackageBytes: 64 * 1024,
    });
    const [local, remote] = createInMemoryLinkPair();
    remote.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as never,
        async dispatchHttp(req) {
          const url = new URL(req.url);
          const version = url.searchParams.get('version') ?? '';
          const sha256 = url.searchParams.get('sha256') ?? '';
          const result = await controller.stagePackage(version, sha256, req.body);
          if (!result.ok) {
            return new Response(JSON.stringify({ code: result.code }), {
              status: result.status,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
    });
    const peers = new FakePeers();
    peers.links.set(OTHER, local);
    const forwarder = new Forwarder({
      nodeId: NODE_ID,
      peers,
      streams: {
        openHttpStream: (link, open, body, signal) => openHttpStream(link, open, body, signal),
        openWsStream: async () => {
          throw new Error('ws not used');
        },
      },
    });
    try {
      const total = 256 * 1024;
      const chunk = new Uint8Array(16 * 1024).fill(3);
      let remaining = total;
      const rawBody = new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (remaining <= 0) {
            ctl.close();
            return;
          }
          const n = Math.min(chunk.byteLength, remaining);
          ctl.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
          remaining -= n;
        },
      });
      const res = await forwarder.forwardAuthorizedHttp(
        new Request('http://localhost/api/mesh/nodes/x/upgrade', {
          method: 'PUT',
          headers: { cookie: `tmex_s_${OTHER}=remote-sid`, origin: 'http://localhost' },
        }),
        {
          nodeId: OTHER,
          method: 'PUT',
          path: '/api/system/upgrade/package',
          query: `?version=1.2.3&sha256=${'ab'.repeat(32)}`,
          rawBody,
          headers: { 'content-type': 'application/octet-stream' },
        }
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ code: 'PACKAGE_TOO_LARGE' });
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});

function encodeHelloFrame(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'failover-test',
    clientVersion: '1.1.23',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1);
}

function encodeHelloS2CFrame(serverVersion = '1.1.23'): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
    serverImpl: 'tmex-gateway',
    serverVersion,
    selectedVersion: wsBorsh.CURRENT_VERSION,
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    heartbeatIntervalMs: 15_000,
    capabilities: ['canonical-state-v1', 'canonical-state-v1.1'],
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, 1);
}

function encodeDeviceConnectFrame(deviceId: string, seq: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECT,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId }),
    seq
  );
}

function encodeDeviceConnectedFrame(deviceId: string): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECTED,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, { deviceId }),
    2
  );
}

function encodeCanonicalSub(
  generation: bigint,
  paneId: string,
  seq: number,
  epoch: Uint8Array
): Uint8Array {
  const pane = { deviceId: 'dev-1', serverEpoch: epoch, paneId };
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_COMMAND,
    wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation,
        activePanes: [{ pane, cursor: { paneEpoch: epoch, terminalSeq: 0n } }],
        hotPanes: [],
      },
    }),
    seq
  );
}

function decodeCanonicalSubs(
  frames: Uint8Array[]
): Array<{ generation: bigint; paneIds: string[] }> {
  const out: Array<{ generation: bigint; paneIds: string[] }> = [];
  for (const frame of frames) {
    try {
      const env = wsBorsh.decodeEnvelope(frame);
      if (env.kind !== wsBorsh.KIND_CANONICAL_COMMAND) continue;
      const decoded = wsBorsh.decodeCanonicalCommandPayload(env.payload);
      if (!('SetPaneSubscriptions' in decoded.command)) continue;
      const sub = decoded.command.SetPaneSubscriptions;
      out.push({
        generation: sub.generation,
        paneIds: [...sub.activePanes, ...sub.hotPanes].map((row) => row.pane.paneId),
      });
    } catch {
      // ignore
    }
  }
  return out;
}

function sentKinds(frames: Uint8Array[]): number[] {
  const kinds: number[] = [];
  for (const frame of frames) {
    try {
      kinds.push(wsBorsh.decodeEnvelope(frame).kind);
    } catch {
      // ignore
    }
  }
  return kinds;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function trackAbort(controller: AbortController): {
  signal: AbortSignal;
  added: number;
  removed: number;
} {
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const tracked = { signal, added: 0, removed: 0 };
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions
  ) => {
    if (type === 'abort') tracked.added += 1;
    return add(type, listener, opts);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    opts?: boolean | EventListenerOptions
  ) => {
    if (type === 'abort') tracked.removed += 1;
    return remove(type, listener, opts);
  }) as typeof signal.removeEventListener;
  return tracked;
}

/**
 * 让此后新开的转发流像真节点一样应答 HELLO_S2C：失败切换的 canonical v1.1 版本门要求。
 * `reply` 按开流序号给出应答帧，返回 null 表示这条流不答 HELLO。
 */
function answerHelloOnNewStreams(
  streams: FakeStreams,
  reply: (index: number) => Uint8Array | null = () => encodeHelloS2CFrame('1.1.23')
): void {
  let index = 0;
  const open = streams.openWsStream.bind(streams);
  streams.openWsStream = async (link: LinkSession, auth: string, cid?: string) => {
    const stream = (await open(link, auth, cid)) as FakeWs;
    const answer = reply(index);
    index += 1;
    const send = stream.send.bind(stream);
    stream.send = (bytes: Uint8Array) => {
      const result = send(bytes);
      if (answer && isHelloC2S(bytes)) stream.pushFromRemote(answer);
      return result;
    };
    return stream;
  };
}

function malformedHelloS2CFrame(): Uint8Array {
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, new Uint8Array([0xff, 0x00]), 1);
}

function decodeErrorFrames(frames: Uint8Array[]) {
  return frames.flatMap((frame) => {
    const env = wsBorsh.decodeEnvelope(frame);
    if (env.kind !== wsBorsh.KIND_ERROR) return [];
    return [wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, env.payload)];
  });
}

function isHelloC2S(bytes: Uint8Array): boolean {
  try {
    return wsBorsh.decodeEnvelopeView(bytes).kind === wsBorsh.KIND_HELLO_C2S;
  } catch {
    return false;
  }
}

async function beginBlockedFailover(): Promise<{
  mesh: Awaited<ReturnType<typeof bootMesh>>;
  ws: MeshServerWebSocket;
  closed: () => { code?: number; reason?: string } | undefined;
  release: () => void;
}> {
  const dcLink = { id: 'dc' } as unknown as LinkSession;
  const relayLink = { id: 'relay' } as unknown as LinkSession;
  const peers = new FakePeers();
  peers.links.set(OTHER, dcLink);
  peers.transport.set(OTHER, 'dc');
  const streams = new FakeStreams();
  const origGetLink = peers.getLink.bind(peers);
  let blockLink = false;
  let releaseLink: (() => void) | undefined;
  peers.getLink = async (nodeId: string) => {
    if (blockLink) {
      await new Promise<void>((resolve) => {
        releaseLink = resolve;
      });
    }
    return origGetLink(nodeId);
  };
  const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
  const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
  mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
  blockLink = true;
  peers.links.set(OTHER, relayLink);
  peers.transport.set(OTHER, 'relay');
  streams.lastWs?.close(1011, 'reset');
  await waitUntil(() => releaseLink !== undefined, 2_000);
  return {
    mesh,
    ws,
    closed,
    release: () => releaseLink?.(),
  };
}

async function openForwardWs(
  runtime: Awaited<ReturnType<typeof bootMesh>>['runtime'],
  _peers: FakePeers,
  _streams: FakeStreams,
  nodeId: string
): Promise<{
  ws: MeshServerWebSocket;
  closed: () => { code?: number; reason?: string } | undefined;
}> {
  let data: { kind?: string } | undefined;
  const server = {
    upgrade(_req: Request, opts?: { data?: unknown }) {
      data = opts?.data as typeof data;
      return true;
    },
  };
  await runtime.handleRequest(
    new Request(`http://localhost/n/${nodeId}/ws`, {
      headers: { cookie: `tmex_s_${nodeId}=remote-sid` },
    }),
    server
  );
  let browserClosed: { code?: number; reason?: string } | undefined;
  const ws = {
    data: data ?? { kind: MESH_FORWARD_WS_KIND },
    send(frame: Uint8Array) {
      return frame.byteLength || 1;
    },
    close(code?: number, reason?: string) {
      browserClosed = { code, reason };
    },
  } as MeshServerWebSocket;
  runtime.handleWebSocket.open(ws);
  return { ws, closed: () => browserClosed };
}

describe('forwarder 分享凭证', () => {
  const SHARE_TOKEN = 'sh-1.secret';

  test('/n/:id/api/share-access/* 用 tmex_sh_<node> 换 share: 凭证', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      streams.nextResponse = new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
      await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/share-access/sh-1`, {
          headers: { cookie: `tmex_sh_${OTHER}=${SHARE_TOKEN}` },
        }),
        dummyServer
      );
      expect(streams.lastOpen?.auth).toBe(`share:${SHARE_TOKEN}`);
      expect(streams.lastOpen?.headers.cookie).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('分享 cookie 不能给常规 /api/*；分享路径缺 cookie 也照常匿名转发', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      streams.nextResponse = new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
      await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/devices`, {
          headers: { cookie: `tmex_sh_${OTHER}=${SHARE_TOKEN}` },
        }),
        dummyServer
      );
      expect(streams.lastOpen?.auth).toBeNull();

      streams.nextResponse = new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
      await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/share-access/sh-1`),
        dummyServer
      );
      expect(streams.lastOpen?.auth).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('节点端的 x-tmex-set-share 在 Hub 翻成 cookie，不回给浏览器', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      streams.nextResponse = new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
          [X_TMEX_SET_SHARE]: SHARE_TOKEN,
          [X_TMEX_SET_SHARE_MAX_AGE]: '86400',
        },
      });
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/share-access/sh-1/login`, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          }),
          dummyServer
        )
      );
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_sh_${OTHER}=${SHARE_TOKEN}`);
      expect(cookie).toContain('Max-Age=86400');
      expect(res.headers.get(X_TMEX_SET_SHARE)).toBeNull();
      expect(res.headers.get(X_TMEX_SET_SHARE_MAX_AGE)).toBeNull();

      streams.nextResponse = new Response('{}', {
        headers: { 'content-type': 'application/json', [X_TMEX_CLEAR_SHARE]: '1' },
      });
      const out = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/share-access/sh-1/logout`, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          }),
          dummyServer
        )
      );
      expect(out.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
      expect(out.headers.get(X_TMEX_CLEAR_SHARE)).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('分享路径的 401 不被改写成 NODE_LOGIN_REQUIRED', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      streams.nextResponse = new Response(JSON.stringify({ code: 'SHARE_PASSWORD_INVALID' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/share-access/sh-1/login`, {
            method: 'POST',
            body: '{}',
            headers: {
              'content-type': 'application/json',
              cookie: `tmex_sh_${OTHER}=${SHARE_TOKEN}`,
            },
          }),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'SHARE_PASSWORD_INVALID' });
    } finally {
      mesh.close();
    }
  });

  test('/s/:id 与 /n/:id/s/:id 不被 mesh 接管，交给入口的静态前端', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      expect(
        await mesh.runtime.handleRequest(new Request('http://localhost/s/sh-1'), dummyServer)
      ).toBeNull();
      const scoped = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/s/sh-1`),
        dummyServer
      );
      expect(scoped).toBeNull();
      expect(streams.httpOpenCount).toBe(0);
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/s/sh-1'))).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws 无节点会话时用分享 cookie 开流', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_sh_${OTHER}=${SHARE_TOKEN}` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(data?.kind).toBe(MESH_FORWARD_WS_KIND);
      expect(streams.wsAuth).toBe(`share:${SHARE_TOKEN}`);
    } finally {
      mesh.close();
    }
  });

  test('节点端终止性关闭码直接透给浏览器，不再 failover', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_sh_${OTHER}=${SHARE_TOKEN}` },
        }),
        server
      );
      const closes: Array<{ code?: number; reason?: string }> = [];
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send(frame: Uint8Array) {
          return frame.byteLength;
        },
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const opens = streams.wsOpens.length;
      streams.lastWs?.close(4410, 'SHARE_ENDED');
      await Promise.resolve();
      expect(closes[0]).toEqual({ code: 4410, reason: 'SHARE_ENDED' });
      expect(streams.wsOpens.length).toBe(opens);
    } finally {
      mesh.close();
    }
  });
});
