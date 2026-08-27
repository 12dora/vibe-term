import { describe, expect, test } from 'bun:test';
import { asResponse, bootMesh, challengeAndLogin, dummyServer } from './auth-routes.test';
import {
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  type MeshServerWebSocket,
  WS_CLOSE_LOGIN_REQUIRED,
  WS_SESSION_VERIFY_MS,
} from './mesh-deps';

describe('mesh-http', () => {
  test('standalone localUiGuard always passes', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('localUiGuard 401 JSON for /api/*; static and /login pass', async () => {
    const mesh = await bootMesh();
    try {
      const api = mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'));
      expect(api?.status).toBe(401);
      expect(await api?.json()).toEqual({ code: 'UNAUTHORIZED' });

      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/assets/app.js'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/favicon.ico'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/auth/mode'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/devices'))).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('unknown paths return null so assembler continues', async () => {
    const mesh = await bootMesh();
    try {
      const res = await mesh.runtime.handleRequest(
        new Request('http://localhost/api/devices'),
        dummyServer
      );
      expect(res).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('guardGatewayWebSocket upgrades unauthenticated /ws to 4401', async () => {
    const mesh = await bootMesh();
    try {
      let data: { kind?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const res = mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), server);
      expect(res).toBeUndefined();
      expect(data?.kind).toBe(MESH_REJECT_4401_KIND);
      let closed: number | undefined;
      const ws = {
        data: { kind: MESH_REJECT_4401_KIND },
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

  test('guardGatewayWebSocket binds sid/uid and closes on logout', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let data: { kind?: string; sid?: string; uid?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const req = new Request('http://localhost/ws', {
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      expect(mesh.runtime.guardGatewayWebSocket(req, server)).toBeUndefined();
      expect(data?.kind).toBe(MESH_GATEWAY_WS_KIND);
      expect(data?.sid).toBe(sid);
      let closed: number | undefined;
      const ws = {
        data: {
          kind: MESH_GATEWAY_WS_KIND,
          sid,
          uid: mesh.boot.userId,
          via: 'self',
        },
        send() {},
        close(code?: number) {
          closed = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      mesh.runtime.closeSocketsForSid(sid);
      expect(closed).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('inbound gateway WS messages re-verify the sid every 5 minutes', async () => {
    let now = Date.now();
    const mesh = await bootMesh({ now: () => now });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let closed: number | undefined;
      const ws = {
        data: {
          kind: MESH_GATEWAY_WS_KIND,
          sid,
          uid: mesh.boot.userId,
          via: 'self',
        },
        send() {},
        close(code?: number) {
          closed = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      expect(mesh.runtime.touchSocket(ws)).toBe(true);
      mesh.nodeSessionStore.revoke(sid, now);
      expect(mesh.runtime.touchSocket(ws)).toBe(true);
      now += WS_SESSION_VERIFY_MS + 1;
      expect(mesh.runtime.touchSocket(ws)).toBe(false);
      expect(closed).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('/healthz is public status-only; full body requires self session', async () => {
    const mesh = await bootMesh();
    try {
      const anon = asResponse(
        await mesh.runtime.handleRequest(new Request('http://localhost/healthz'), dummyServer)
      );
      expect(await anon.json()).toEqual({ status: 'ok' });

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const authed = await mesh.runtime.handleRequest(
        new Request('http://localhost/healthz', { headers: { cookie: `tmex_s_self=${sid}` } }),
        dummyServer
      );
      expect(authed).toBeNull();
    } finally {
      mesh.close();
    }
  });
});
