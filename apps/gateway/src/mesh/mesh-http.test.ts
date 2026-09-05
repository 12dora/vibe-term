import { afterEach, describe, expect, test } from 'bun:test';
import { SHARE_WS_CLOSE_ENDED } from '@tmex/shared/share';
import { MemoryLocalAuthStore } from '../db/local-auth-settings';
import { asResponse, bootMesh, challengeAndLogin, dummyServer } from './auth-routes.test';
import {
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_SHARE_WS_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  type MeshServerWebSocket,
  SHARE_WS_VERIFY_MS,
  WS_CLOSE_LOGIN_REQUIRED,
  WS_SESSION_VERIFY_MS,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { X_TMEX_MESH_PEER } from './peer-request-marker';
import { setShareAccessVerifier, setShareEndedReader } from './share-credential';

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

const SHARE_SCOPE = { shareId: 'sh-1', deviceId: 'dev-1', windowId: 'win-1' };
const SHARE_TOKEN = 'sh-1.secret';

function shareSpy() {
  let data: Record<string, unknown> | undefined;
  const server = {
    upgrade(_req: Request, opts?: { data?: unknown }) {
      data = opts?.data as Record<string, unknown>;
      return true;
    },
  };
  return { server, dataOf: () => data };
}

function acceptOnly(tokens: Set<string>): void {
  setShareAccessVerifier((token) =>
    tokens.has(token) ? { scope: SHARE_SCOPE, accessId: 'acc-1', expiresAt: 2_000_000 } : null
  );
}

describe('mesh-http share access', () => {
  afterEach(() => {
    setShareAccessVerifier(null);
    setShareEndedReader(null);
  });

  test('localUiGuard 放行 /api/share-access/*，其余 /api/* 仍 401', async () => {
    const mesh = await bootMesh();
    try {
      expect(
        mesh.runtime.localUiGuard(new Request('http://localhost/api/share-access/abc'))
      ).toBeNull();
      expect(
        mesh.runtime.localUiGuard(
          new Request('http://localhost/api/share-access/abc/login', { method: 'POST' })
        )
      ).toBeNull();
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/devices'))?.status).toBe(
        401
      );
      expect(mesh.runtime.localUiGuard(new Request('http://localhost/api/share'))?.status).toBe(
        401
      );
    } finally {
      mesh.close();
    }
  });

  test('tmex_sh_self 有效 → 以分享作用域升级，不登记会话', async () => {
    acceptOnly(new Set([SHARE_TOKEN]));
    const mesh = await bootMesh();
    try {
      const spy = shareSpy();
      const res = mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws?cid=c1', {
          headers: { cookie: `tmex_sh_self=${SHARE_TOKEN}` },
        }),
        spy.server
      );
      expect(res).toBeUndefined();
      const data = spy.dataOf();
      expect(data?.kind).toBe(MESH_SHARE_WS_KIND);
      expect(data?.scope).toEqual(SHARE_SCOPE);
      expect(data?.accessId).toBe('acc-1');
      expect(data?.cid).toBe('c1');
      expect(data?.sid).toBeUndefined();
      expect(data?.uid).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('分享 cookie 无效 → 4401 SHARE_LOGIN_REQUIRED', async () => {
    acceptOnly(new Set());
    const mesh = await bootMesh();
    try {
      const spy = shareSpy();
      mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws', { headers: { cookie: 'tmex_sh_self=stale.token' } }),
        spy.server
      );
      const data = spy.dataOf();
      expect(data?.kind).toBe(MESH_REJECT_4401_KIND);
      expect(data?.closeReason).toBe('SHARE_LOGIN_REQUIRED');
      const closes: Array<{ code?: number; reason?: string }> = [];
      mesh.runtime.handleWebSocket.open({
        data,
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
        send: () => 0,
      } as unknown as MeshServerWebSocket);
      expect(closes[0]).toEqual({
        code: WS_CLOSE_LOGIN_REQUIRED,
        reason: 'SHARE_LOGIN_REQUIRED',
      });
    } finally {
      mesh.close();
    }
  });

  test('无任何 cookie 仍是 NODE_LOGIN_REQUIRED', async () => {
    acceptOnly(new Set());
    const mesh = await bootMesh();
    try {
      const spy = shareSpy();
      mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), spy.server);
      expect(spy.dataOf()?.kind).toBe(MESH_REJECT_4401_KIND);
      expect(spy.dataOf()?.closeReason).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('分享连接按 SHARE_WS_VERIFY_MS 复验；凭证失效即 4410', async () => {
    const live = new Set([SHARE_TOKEN]);
    acceptOnly(live);
    let now = 10_000;
    const mesh = await bootMesh({ now: () => now });
    try {
      const spy = shareSpy();
      mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws', {
          headers: { cookie: `tmex_sh_self=${SHARE_TOKEN}` },
        }),
        spy.server
      );
      const closes: Array<{ code?: number; reason?: string }> = [];
      const ws = {
        data: spy.dataOf(),
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
        send: () => 0,
      } as unknown as MeshServerWebSocket;
      expect(mesh.runtime.touchSocket(ws)).toBe(true);
      live.delete(SHARE_TOKEN);
      now += SHARE_WS_VERIFY_MS - 1;
      expect(mesh.runtime.touchSocket(ws)).toBe(true);
      now += 2;
      expect(mesh.runtime.touchSocket(ws)).toBe(false);
      expect(closes[0]).toEqual({ code: SHARE_WS_CLOSE_ENDED, reason: 'SHARE_ENDED' });
    } finally {
      mesh.close();
    }
  });
});

describe('mesh-http share ws binding', () => {
  afterEach(() => {
    setShareAccessVerifier(null);
    setShareEndedReader(null);
  });

  test('?share=<id> 与 cookie 绑定同一分享 → 作用域升级', async () => {
    acceptOnly(new Set([SHARE_TOKEN]));
    const mesh = await bootMesh();
    try {
      const spy = shareSpy();
      const res = mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws?cid=c1&share=sh-1', {
          headers: { cookie: `tmex_sh_self=${SHARE_TOKEN}` },
        }),
        spy.server
      );
      expect(res).toBeUndefined();
      expect(spy.dataOf()?.kind).toBe(MESH_SHARE_WS_KIND);
      expect(spy.dataOf()?.scope).toEqual(SHARE_SCOPE);
    } finally {
      mesh.close();
    }
  });

  test('?share=<id> 与 cookie 绑定的分享不一致 → 4401', async () => {
    acceptOnly(new Set([SHARE_TOKEN]));
    const mesh = await bootMesh();
    try {
      const spy = shareSpy();
      mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws?share=sh-2', {
          headers: { cookie: `tmex_sh_self=${SHARE_TOKEN}` },
        }),
        spy.server
      );
      expect(spy.dataOf()?.kind).toBe(MESH_REJECT_4401_KIND);
      expect(spy.dataOf()?.closeReason).toBe('SHARE_LOGIN_REQUIRED');
      expect(spy.dataOf()?.closeCode).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('?share=<id> 时常规会话一律不认，缺分享 cookie 即 4401', async () => {
    acceptOnly(new Set([SHARE_TOKEN]));
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const spy = shareSpy();
      mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws?share=sh-1', {
          headers: { cookie: `tmex_s_self=${sid}` },
        }),
        spy.server
      );
      expect(spy.dataOf()?.kind).toBe(MESH_REJECT_4401_KIND);
      expect(spy.dataOf()?.closeReason).toBe('SHARE_LOGIN_REQUIRED');
    } finally {
      mesh.close();
    }
  });

  test('分享已结束时 ?share=<id> 回 4410 SHARE_ENDED', async () => {
    acceptOnly(new Set());
    setShareEndedReader((shareId) => shareId === 'sh-1');
    const mesh = await bootMesh();
    try {
      const spy = shareSpy();
      mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws?share=sh-1', {
          headers: { cookie: 'tmex_sh_self=sh-1.stale' },
        }),
        spy.server
      );
      expect(spy.dataOf()?.closeCode).toBe(SHARE_WS_CLOSE_ENDED);
      expect(spy.dataOf()?.closeReason).toBe('SHARE_ENDED');
      const closes: Array<{ code?: number; reason?: string }> = [];
      mesh.runtime.handleWebSocket.open({
        data: spy.dataOf(),
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
        send: () => 0,
      } as unknown as MeshServerWebSocket);
      expect(closes[0]).toEqual({ code: SHARE_WS_CLOSE_ENDED, reason: 'SHARE_ENDED' });
    } finally {
      mesh.close();
    }
  });

  test('免登录 standalone：有效分享 cookie 仍以作用域升级，不是全权限连接', async () => {
    acceptOnly(new Set([SHARE_TOKEN]));
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const spy = shareSpy();
      const res = mesh.runtime.guardGatewayWebSocket(
        new Request('http://localhost/ws', {
          headers: { cookie: `tmex_sh_self=${SHARE_TOKEN}` },
        }),
        spy.server
      );
      expect(res).toBeUndefined();
      expect(spy.dataOf()?.kind).toBe(MESH_SHARE_WS_KIND);
      expect(spy.dataOf()?.scope).toEqual(SHARE_SCOPE);
    } finally {
      mesh.close();
    }
  });

  test('免登录 standalone：无分享 cookie 照旧直接放行', async () => {
    acceptOnly(new Set());
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const spy = shareSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(new Request('http://localhost/ws'), spy.server)
      ).toBeNull();
      expect(spy.dataOf()).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('免登录 standalone：失效分享 cookie 不锁死普通页面', async () => {
    acceptOnly(new Set());
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const spy = shareSpy();
      expect(
        mesh.runtime.guardGatewayWebSocket(
          new Request('http://localhost/ws', { headers: { cookie: 'tmex_sh_self=sh-9.dead' } }),
          spy.server
        )
      ).toBeNull();
    } finally {
      mesh.close();
    }
  });
});

describe('mesh-http', () => {
  test('standalone localUiGuard always passes', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
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

  test('localUiGuard 对可信本机 GET /api/mesh/relay/status 放行', async () => {
    const mesh = await bootMesh();
    try {
      const local = new Request('http://localhost/api/mesh/relay/status');
      setMeshRequestContext(local, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
      expect(mesh.runtime.localUiGuard(local)).toBeNull();

      const publicIp = new Request('http://localhost/api/mesh/relay/status', {
        headers: { 'x-tmex-client-source': 'local' },
      });
      setMeshRequestContext(publicIp, { via: MESH_VIA_SELF, clientIp: '203.0.113.10' });
      expect(mesh.runtime.localUiGuard(publicIp)?.status).toBe(401);

      const peer = new Request('http://localhost/api/mesh/relay/status', {
        headers: { 'x-tmex-client-source': 'local' },
      });
      setMeshRequestContext(peer, { via: 'ab'.repeat(16), clientIp: 'peer:entry' });
      expect(mesh.runtime.localUiGuard(peer)?.status).toBe(401);

      const leave = new Request('http://localhost/api/mesh/relay/leave/prepare', {
        method: 'POST',
      });
      setMeshRequestContext(leave, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
      expect(mesh.runtime.localUiGuard(leave)?.status).toBe(401);
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
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
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
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
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
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
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
    const mesh = await bootMesh({
      roles: { hub: false, node: false, relay: false },
      skipUserBootstrap: true,
    });
    try {
      const runtime = new MeshHttpRuntime({
        roles: { hub: false, node: false, relay: false },
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
