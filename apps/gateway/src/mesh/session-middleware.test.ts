import { describe, expect, test } from 'bun:test';
import { NODE_SESSION_RENEW_THROTTLE_MS } from '../auth/node-session-store';
import { asResponse, bootMesh, call, challengeAndLogin } from './auth-routes.test';
import { X_TMEX_SESSION_RENEWED, requestDispatchContext, setMeshRequestContext } from './mesh-deps';
import {
  authenticateRequest,
  isHttps,
  publicRequestUrl,
  requireSession,
} from './session-middleware';

describe('session-middleware', () => {
  test('standalone bypasses with uid=null', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const req = new Request('http://localhost/api/devices');
      const auth = authenticateRequest(req, {
        roles: { hub: false, node: false, relay: false },
        nodeSessionStore: mesh.nodeSessionStore,
      });
      expect(auth.ok).toBe(true);
      if (auth.ok) {
        expect(auth.userId).toBeNull();
        expect(auth.session).toBeNull();
      }
    } finally {
      mesh.close();
    }
  });

  test('standalone + localAuthEffective 无 cookie → 拒绝', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const req = new Request('http://localhost/api/devices');
      const auth = authenticateRequest(req, {
        roles: { hub: false, node: false, relay: false },
        nodeSessionStore: mesh.nodeSessionStore,
        localAuthEffective: () => true,
      });
      expect(auth.ok).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('standalone + enabled 但未生效仍短路', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const req = new Request('http://localhost/api/devices');
      const auth = authenticateRequest(req, {
        roles: { hub: false, node: false, relay: false },
        nodeSessionStore: mesh.nodeSessionStore,
        localAuthEffective: () => false,
      });
      expect(auth.ok).toBe(true);
      if (auth.ok) expect(auth.userId).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('standalone + effective 校验 cookie 会话', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const req = new Request('http://localhost/api/devices', {
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      const auth = authenticateRequest(req, {
        roles: { hub: false, node: false, relay: false },
        nodeSessionStore: mesh.nodeSessionStore,
        localAuthEffective: () => true,
      });
      expect(auth.ok).toBe(true);
      if (auth.ok) expect(auth.userId).toBe(mesh.boot.userId);
    } finally {
      mesh.close();
    }
  });

  test('node 角色不因 localAuthEffective=false 而短路', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: true, relay: false } });
    try {
      const req = new Request('http://localhost/api/devices');
      const auth = authenticateRequest(req, {
        roles: { hub: false, node: true, relay: false },
        nodeSessionStore: mesh.nodeSessionStore,
        localAuthEffective: () => false,
      });
      expect(auth.ok).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('local cookie session + renewal header after throttle window', async () => {
    let now = Date.now();
    const mesh = await bootMesh({ now: () => now });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      now += NODE_SESSION_RENEW_THROTTLE_MS + 1000;
      const req = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      const out = asResponse(await mesh.runtime.handleRequest(req, { upgrade: () => false }));
      expect(out.headers.get(X_TMEX_SESSION_RENEWED)).toBeTruthy();
    } finally {
      mesh.close();
    }
  });

  test('requireSession 401 without cookie', async () => {
    const mesh = await bootMesh();
    try {
      const handler = requireSession(
        {
          roles: { hub: false, node: true, relay: false },
          nodeSessionStore: mesh.nodeSessionStore,
        },
        async () => new Response('ok')
      );
      const res = await handler(new Request('http://localhost/api/x'));
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('UNAUTHORIZED');
    } finally {
      mesh.close();
    }
  });

  test('stream via uses injected auth sid not cookie', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        via: 'entry-a',
        entry: 'entry-a',
      });
      const req = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: 'tmex_s_self=wrong' },
      });
      const { setMeshRequestContext } = await import('./mesh-deps');
      setMeshRequestContext(req, { via: 'entry-a', auth: sid });
      const out = await call(mesh.runtime, 'http://localhost/api/auth/logout', {
        method: 'POST',
        via: 'entry-a',
        authSid: sid,
      });
      expect(out.status).toBe(200);
      void req;
    } finally {
      mesh.close();
    }
  });

  test('local renewal attaches x-tmex-session-renewed to later authed responses', async () => {
    let now = Date.now();
    const mesh = await bootMesh({ now: () => now });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      now += NODE_SESSION_RENEW_THROTTLE_MS + 1000;
      const req = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      const out = asResponse(await mesh.runtime.handleRequest(req, { upgrade: () => false }));
      expect(out.headers.get(X_TMEX_SESSION_RENEWED)).toBeTruthy();
    } finally {
      mesh.close();
    }
  });

  test('TMEX_TRUST_PROXY only applies to via=self', () => {
    const req = new Request('http://127.0.0.1:19663/api/auth/mode', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example.com',
      },
    });
    setMeshRequestContext(req, { via: 'self', trustProxy: true });
    expect(publicRequestUrl(req).origin).toBe('https://app.example.com');
    expect(isHttps(req)).toBe(true);

    const forwarded = new Request('http://127.0.0.1:19663/api/auth/mode', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example.com',
      },
    });
    setMeshRequestContext(forwarded, { via: 'entry-node', trustProxy: true });
    expect(publicRequestUrl(forwarded).origin).toBe('http://127.0.0.1:19663');
    expect(isHttps(forwarded)).toBe(false);
  });

  test('requestDispatchContext via is the trusted source', () => {
    const meshPromise = bootMesh();
    return meshPromise.then((mesh) => {
      try {
        const req = new Request('http://localhost/api/devices');
        setMeshRequestContext(req, { via: 'self', auth: 'cookie-sid' });
        requestDispatchContext.set(req, { uid: 'user-1', viaNodeId: 'peer-node' });
        const auth = authenticateRequest(req, {
          roles: { hub: false, node: true, relay: false },
          nodeSessionStore: mesh.nodeSessionStore,
        });
        expect(auth.ok).toBe(true);
        if (auth.ok) {
          expect(auth.userId).toBe('user-1');
        }
      } finally {
        mesh.close();
      }
    });
  });
});
