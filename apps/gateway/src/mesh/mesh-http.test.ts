import { describe, expect, test } from 'bun:test';
import { MemoryLocalAuthStore } from '../db/local-auth-settings';
import { asResponse, bootMesh, challengeAndLogin, dummyServer } from './auth-routes.test';
import {
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_WS_KIND,
  type MeshServerWebSocket,
  WS_CLOSE_LOGIN_REQUIRED,
  WS_SESSION_VERIFY_MS,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { X_TMEX_MESH_PEER } from './peer-request-marker';

const LOGIN_PUBLIC = [
  '/api/auth/mode',
  '/api/auth/nodes',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
] as const;
const LOCAL_PRESESSION = ['/api/auth/local', '/api/auth/local/bootstrap'] as const;

function upgradeSpy() {
  let data: { kind?: string; sid?: string; uid?: string; cid?: string } | undefined;
  const server = {
    upgrade(_req: Request, opts?: { data?: unknown }) {
      data = opts?.data as typeof data;
      return true;
    },
  };
  return { server, dataOf: () => data };
}

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
      let data: { kind?: string; sid?: string; uid?: string; cid?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const req = new Request('http://localhost/ws?cid=tab-nonce', {
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      expect(mesh.runtime.guardGatewayWebSocket(req, server)).toBeUndefined();
      expect(data?.kind).toBe(MESH_GATEWAY_WS_KIND);
      expect(data?.sid).toBe(sid);
      expect(data?.cid).toBe('tab-nonce');
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

  test('/mesh/ws re-verifies the sid every 5 minutes and closes 4401 on expiry', async () => {
    let now = Date.now();
    const mesh = await bootMesh({ now: () => now });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let closed: number | undefined;
      const ws = {
        data: {
          kind: MESH_WS_KIND,
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

  test('mesh-internal 无标记 → 403；外部伪造标记被剥掉仍 403', async () => {
    const mesh = await bootMesh();
    try {
      const denied = await mesh.runtime.handleRequest(
        new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: 'd', paneId: '%1' }),
        }),
        dummyServer
      );
      expect(denied instanceof Response ? denied.status : 0).toBe(403);

      const spoofed = await mesh.runtime.handleRequest(
        new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tmex-mesh-peer': 'forged-peer',
          },
          body: JSON.stringify({ deviceId: 'd', paneId: '%1' }),
        }),
        dummyServer
      );
      expect(spoofed instanceof Response ? spoofed.status : 0).toBe(403);
    } finally {
      mesh.close();
    }
  });

  test('peer inbound 保留标记，mesh-internal 不因缺 cookie 返回 403', async () => {
    const mesh = await bootMesh();
    try {
      const req = new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [X_TMEX_MESH_PEER]: 'entry-peer',
        },
        body: JSON.stringify({ deviceId: 'missing', paneId: '%1' }),
      });
      setMeshRequestContext(req, { via: 'entry-peer', clientIp: 'peer:entry-peer' });
      const res = await mesh.runtime.handleRequest(req, dummyServer);
      expect(res instanceof Response).toBe(true);
      if (res instanceof Response) {
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
      }
    } finally {
      mesh.close();
    }
  });

  test('localUiGuard 不拦截 /api/mesh-internal（由标记鉴权）', async () => {
    const mesh = await bootMesh();
    try {
      expect(
        mesh.runtime.localUiGuard(new Request('http://localhost/api/mesh-internal/tmux/pane-info'))
      ).toBeNull();
    } finally {
      mesh.close();
    }
  });
});

describe('mesh-http 整站门 × localAuth', () => {
  test('standalone 未生效：API / UI / WS / local 端点全部放行', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const store = new MemoryLocalAuthStore();
      mesh.runtime.auth.setLocalAuthStore(store);
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/devices'))).toBeNull();
      for (const path of LOGIN_PUBLIC) {
        expect(mesh.runtime.localUiGuard(new Request(`http://localhost${path}`))).toBeNull();
      }
      for (const path of LOCAL_PRESESSION) {
        expect(mesh.runtime.localUiGuard(new Request(`http://localhost${path}`))).toBeNull();
      }
      const { server, dataOf } = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), server)
      ).toBeNull();
      expect(dataOf()).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('standalone 生效：API 与未登录 WS 拒绝；登录流与 /login 仍公开', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const store = new MemoryLocalAuthStore();
      store.setEnabled(true);
      mesh.runtime.auth.setLocalAuthStore(store);

      const api = mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'));
      expect(api?.status).toBe(401);
      expect(await api?.json()).toEqual({ code: 'UNAUTHORIZED' });

      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/assets/app.js'))).toBeNull();
      for (const path of LOGIN_PUBLIC) {
        expect(mesh.runtime.localUiGuard(new Request(`http://localhost${path}`))).toBeNull();
      }
      for (const path of LOCAL_PRESESSION) {
        const blocked = mesh.runtime.localUiGuard(new Request(`http://localhost${path}`));
        expect(blocked?.status).toBe(401);
      }

      const { server, dataOf } = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), server)
      ).toBeUndefined();
      expect(dataOf()?.kind).toBe(MESH_REJECT_4401_KIND);

      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const cookie = { headers: { cookie: `tmex_s_self=${sid}` } };
      expect(
        mesh.runtime.localUiGuard(new Request('http://localhost/api/devices', cookie))
      ).toBeNull();
      expect(
        mesh.runtime.localUiGuard(new Request('http://localhost/api/auth/local', cookie))
      ).toBeNull();

      const authed = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(
          new Request('http://localhost/ws', { headers: { cookie: `tmex_s_self=${sid}` } }),
          authed.server
        )
      ).toBeUndefined();
      expect(authed.dataOf()?.kind).toBe(MESH_GATEWAY_WS_KIND);
      expect(authed.dataOf()?.sid).toBe(sid);
    } finally {
      mesh.close();
    }
  });

  test('standalone 运行时开关：开启不卡住当前请求，关闭立即恢复开放', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const store = new MemoryLocalAuthStore();
      mesh.runtime.auth.setLocalAuthStore(store);
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/auth/local'))).toBeNull();

      store.setEnabled(true);
      const afterEnable = mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'));
      expect(afterEnable?.status).toBe(401);
      const toggleBlocked = mesh.runtime.localUiGuard(
        new Request('http://localhost/api/auth/local')
      );
      expect(toggleBlocked?.status).toBe(401);

      store.setEnabled(false);
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'))).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/auth/local'))).toBeNull();
      const { server, dataOf } = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), server)
      ).toBeNull();
      expect(dataOf()).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('node 角色 localUiGuard / WS 行为与本机登录无关', async () => {
    const mesh = await bootMesh();
    try {
      const store = new MemoryLocalAuthStore();
      store.setEnabled(true);
      mesh.runtime.auth.setLocalAuthStore(store);

      const api = mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'));
      expect(api?.status).toBe(401);
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/login'))).toBeNull();
      for (const path of LOGIN_PUBLIC) {
        expect(mesh.runtime.localUiGuard(new Request(`http://localhost${path}`))).toBeNull();
      }
      const local = mesh.runtime.localUiGuard(new Request('http://localhost/api/auth/local'));
      expect(local?.status).toBe(401);

      const { server, dataOf } = upgradeSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), server)
      ).toBeUndefined();
      expect(dataOf()?.kind).toBe(MESH_REJECT_4401_KIND);
    } finally {
      mesh.close();
    }
  });
});

describe('mesh-http authSurfaceOnly', () => {
  test('不挂 /api/mesh，且构造不需要 peers/streams', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false }, skipUserBootstrap: true });
    try {
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: false },
        nodeId: 'aa'.repeat(16),
        nodePk: Uint8Array.from({ length: 32 }, () => 9),
        userStore: mesh.userStore,
        keyLogService: mesh.keyLogService,
        challengeStore: mesh.challengeStore,
        nodeSessionStore: mesh.nodeSessionStore,
        publisher: { publish() {} },
        authSurfaceOnly: true,
      });
      const nodes = await runtime.handleRequest(
        new Request('http://localhost/api/mesh/nodes'),
        dummyServer
      );
      expect(nodes).toBeNull();
      const mode = asResponse(
        await runtime.handleRequest(new Request('http://localhost/api/auth/mode'), dummyServer)
      );
      expect(mode.status).toBe(200);
      expect(((await mode.json()) as { mode: string }).mode).toBe('none');
      runtime.stop();
    } finally {
      mesh.close();
    }
  });
});
