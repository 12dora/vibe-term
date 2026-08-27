import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@tmex/shared/link';
import {
  FakePeers,
  FakeStreams,
  NODE_ID,
  bootMesh,
  call,
  challengeAndLogin,
  dummyServer,
} from './auth-routes.test';
import { getSelfRewrite } from './forwarder';
import {
  MESH_FORWARD_CSP,
  MESH_FORWARD_WS_KIND,
  type MeshServerWebSocket,
  X_TMEX_SET_SESSION,
} from './mesh-deps';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';

const OTHER = 'bb'.repeat(16);
const dummyLink = {} as LinkSession;

describe('forwarder', () => {
  test('self fallthrough rewrites path and returns null for gateway routes', async () => {
    const mesh = await bootMesh();
    try {
      const req = new Request('http://localhost/n/self/api/devices');
      const res = await mesh.runtime.handleRequest(req, dummyServer);
      expect(res).toBeNull();
      expect(getSelfRewrite(req)).toBe('/api/devices');
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
      const res = await mesh.runtime.handleRequest(
        new Request('http://localhost/n/deadbeefdeadbeefdeadbeefdeadbeef/api/ping'),
        dummyServer
      );
      expect(res?.status).toBe(503);
      expect(await res?.json()).toEqual({
        code: 'NODE_UNREACHABLE',
        nodeId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      });
    } finally {
      mesh.close();
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
      const svg = await mesh.runtime.handleRequest(
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
          },
        }),
        dummyServer
      );
      expect(svg?.status).toBe(200);
      expect(svg?.headers.get('content-type')).toBe('application/octet-stream');
      expect(svg?.headers.get('content-disposition')).toBe('attachment');
      expect(svg?.headers.get('x-evil')).toBeNull();
      expect(svg?.headers.get('set-cookie')).toBeNull();
      expect(svg?.headers.get('content-security-policy')).toBe(MESH_FORWARD_CSP);
      expect(svg?.headers.get('x-content-type-options')).toBe('nosniff');
      expect(svg?.headers.get('cache-control')).toBe('no-store');
      expect(streams.lastOpen?.headers.cookie).toBeUndefined();
      expect(streams.lastOpen?.headers.authorization).toBeUndefined();
      expect(streams.lastOpen?.headers.host).toBeUndefined();
      expect(streams.lastOpen?.headers.connection).toBeUndefined();
      expect(streams.lastOpen?.headers.accept).toBe('image/*');

      streams.nextResponse = new Response('<html></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      const html = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/page`),
        dummyServer
      );
      expect(html?.headers.get('content-type')).toBe('application/octet-stream');
      expect(html?.headers.get('content-disposition')).toBe('attachment');

      streams.nextResponse = new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      });
      const png = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/img`),
        dummyServer
      );
      expect(png?.headers.get('content-type')).toBe('image/png');
      expect(png?.headers.get('content-disposition')).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('401 from target is augmented with NODE_LOGIN_REQUIRED', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ error: 'missing auth' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/devices`),
        dummyServer
      );
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({
        error: 'missing auth',
        code: 'NODE_LOGIN_REQUIRED',
        nodeId: OTHER,
      });
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
      const res = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        dummyServer
      );
      const cookie = res?.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_${OTHER}=sessidvalue`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Max-Age=64800');
      expect(streams.lastOpen?.auth).toBeNull();
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
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { sid } = (await res.json()) as { sid: string };
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
      let closed: number | undefined;
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND, auth: null },
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
});
