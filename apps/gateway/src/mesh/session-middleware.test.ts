import { describe, expect, test } from 'bun:test';
import { NODE_SESSION_RENEW_THROTTLE_MS } from '../auth/node-session-store';
import { bootMesh, call, challengeAndLogin } from './auth-routes.test';
import { X_TMEX_SESSION_RENEWED } from './mesh-deps';
import { authenticateRequest, requireSession } from './session-middleware';

describe('session-middleware', () => {
  test('standalone bypasses with uid=null', async () => {
    const mesh = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const req = new Request('http://localhost/api/devices');
      const auth = authenticateRequest(req, {
        roles: { hub: false, node: false },
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

  test('local cookie session + renewal header after throttle window', async () => {
    let now = Date.now();
    const mesh = await bootMesh({ now: () => now });
    try {
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { sid } = (await res.json()) as { sid: string };
      now += NODE_SESSION_RENEW_THROTTLE_MS + 1000;
      const req = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}` },
      });
      const out = await mesh.runtime.handleRequest(req, { upgrade: () => false });
      expect(out).toBeTruthy();
      expect(out?.headers.get(X_TMEX_SESSION_RENEWED)).toBeTruthy();
    } finally {
      mesh.close();
    }
  });

  test('requireSession 401 without cookie', async () => {
    const mesh = await bootMesh();
    try {
      const handler = requireSession(
        { roles: { hub: false, node: true }, nodeSessionStore: mesh.nodeSessionStore },
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
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        via: 'entry-a',
        entry: 'entry-a',
      });
      const { sid } = (await res.json()) as { sid: string };
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
});
