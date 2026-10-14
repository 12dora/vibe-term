import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bootMesh, call, challengeAndLogin } from './auth-routes.test';
import { MESH_VIA_SELF, requestDispatchContext, setMeshRequestContext } from './mesh-deps';
import { applyInboundDispatchContext } from './mesh-inbound-dispatch';
import { tokenScopeDenied } from './token-guard';
import { TOKEN_USER, type TokenFixture, bootTokenFixture } from './token-test-support';

let fixture: TokenFixture;
beforeEach(() => {
  fixture = bootTokenFixture();
});
afterEach(() => fixture.close());

const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://localhost${path}`, { method, headers });

async function codeOf(res: Response | null): Promise<string | null> {
  return res ? ((await res.json()) as { code: string }).code : null;
}

describe('local guard: token presentation and scope', () => {
  test('Bearer and vibeterm_t_self cookie are accepted on allowed paths', async () => {
    const mesh = await bootMesh();
    try {
      const { secret } = fixture.mint(['exec']);
      for (const headers of [bearer(secret), { cookie: `vibeterm_t_self=${secret}` }]) {
        expect(mesh.runtime.localUiGuard(get('/api/devices', headers))).toBeNull();
        expect(mesh.runtime.localUiGuard(get('/api/exec', headers, 'POST'))).toBeNull();
        expect(mesh.runtime.localUiGuard(get('/api/mesh/nodes', headers))).toBeNull();
      }
    } finally {
      mesh.close();
    }
  });

  test('the request context carries the token principal, not a session', async () => {
    const mesh = await bootMesh();
    try {
      const { secret, id } = fixture.mint(['files']);
      const req = get('/api/files/list', bearer(secret));
      expect(mesh.runtime.localUiGuard(req)).toBeNull();
      expect(requestDispatchContext.get(req)).toMatchObject({
        uid: 'tok-user',
        tokenId: id,
        tokenScopes: ['files'],
      });
      expect(requestDispatchContext.get(req)?.sid).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('paths outside the scope table are 403 TOKEN_SCOPE', async () => {
    const mesh = await bootMesh();
    try {
      const { secret } = fixture.mint(['exec']);
      const denied: Array<[string, string]> = [
        ['GET', '/api/files/list'],
        ['GET', '/api/portmap'],
        ['GET', '/api/auth/tokens'],
        ['POST', '/api/auth/tokens'],
        ['DELETE', '/api/auth/tokens/abc'],
        ['POST', '/api/auth/logout'],
        ['GET', '/api/auth/keylog'],
        ['GET', '/api/settings/site'],
        ['POST', '/api/auth/local'],
      ];
      for (const [method, path] of denied) {
        const res = mesh.runtime.localUiGuard(get(path, bearer(secret), method));
        expect(res?.status).toBe(403);
        expect(await codeOf(res)).toBe('TOKEN_SCOPE');
      }
    } finally {
      mesh.close();
    }
  });

  test('an invalid, revoked or expired token is a plain 401', async () => {
    const mesh = await bootMesh();
    try {
      const revoked = fixture.mint(['exec']);
      fixture.service.revoke(TOKEN_USER, revoked.id);
      const expiring = fixture.mint(['exec'], 1);
      fixture.setNow(1_800_000_000_000 + 2 * 86_400_000);
      for (const secret of ['vtk_nope', revoked.secret, expiring.secret]) {
        const res = mesh.runtime.localUiGuard(get('/api/devices', bearer(secret)));
        expect(res?.status).toBe(401);
        expect(await codeOf(res)).toBe('UNAUTHORIZED');
      }
      expect(mesh.runtime.localUiGuard(get('/api/devices'))?.status).toBe(401);
    } finally {
      mesh.close();
    }
  });

  test('a live session wins over any token, even an invalid or out-of-scope one', async () => {
    const mesh = await bootMesh();
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { secret } = fixture.mint(['forward']);
      for (const token of [secret, 'vtk_garbage']) {
        const req = get('/api/settings/site', {
          cookie: `vibeterm_s_self=${sid}; vibeterm_t_self=${token}`,
          authorization: `Bearer ${token}`,
        });
        expect(mesh.runtime.localUiGuard(req)).toBeNull();
        expect(requestDispatchContext.get(req)?.tokenId ?? null).toBeNull();
        expect(requestDispatchContext.get(req)?.sid).toBe(sid);
      }
    } finally {
      mesh.close();
    }
  });

  test('public auth-flow paths ignore tokens entirely (valid or broken)', async () => {
    const mesh = await bootMesh();
    try {
      const { secret } = fixture.mint(['files']);
      for (const token of [secret, 'vtk_garbage']) {
        for (const path of ['/api/auth/mode', '/api/auth/challenge', '/api/auth/login']) {
          const method = path === '/api/auth/mode' ? 'GET' : 'POST';
          const req = get(path, { ...bearer(token), cookie: `vibeterm_t_self=${token}` }, method);
          expect(mesh.runtime.localUiGuard(req)).toBeNull();
          expect(requestDispatchContext.get(req)?.tokenId ?? null).toBeNull();
        }
      }
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode', {
        headers: bearer('vtk_garbage'),
      });
      expect(res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });
});

describe('/n/self rewrite cannot launder a token past the scope table', () => {
  test('rewritten /n/self/api/auth/tokens with Bearer is 403 at the guard', async () => {
    const mesh = await bootMesh();
    try {
      const { secret } = fixture.mint(['exec', 'files', 'forward']);
      const original = get('/n/self/api/auth/tokens', bearer(secret), 'POST');
      const rewritten = mesh.runtime.rewriteSelf(original);
      if (!rewritten) throw new Error('expected rewrite');
      expect(new URL(rewritten.url).pathname).toBe('/api/auth/tokens');
      const res = mesh.runtime.localUiGuard(rewritten);
      expect(res?.status).toBe(403);
      expect(await codeOf(res)).toBe('TOKEN_SCOPE');
    } finally {
      mesh.close();
    }
  });

  test('the token context survives rewriteRequest and handleRequest denies it before AuthRoutes', async () => {
    const mesh = await bootMesh();
    try {
      const { secret } = fixture.mint(['exec', 'files', 'forward']);
      const req = get('/api/devices', bearer(secret));
      expect(mesh.runtime.localUiGuard(req)).toBeNull();
      const forged = get('/n/self/api/auth/logout', bearer(secret), 'POST');
      setMeshRequestContext(forged, {
        via: MESH_VIA_SELF,
        uid: 'tok-user',
        tokenId: 't1',
        tokenScopes: ['exec'],
      });
      const rewritten = mesh.runtime.rewriteSelf(forged);
      expect(requestDispatchContext.get(rewritten as Request)?.tokenId).toBe('t1');
      const res = await mesh.runtime.handleRequest(forged, { upgrade: () => true });
      expect((res as Response).status).toBe(403);
      const logout = await mesh.runtime.handleRequest(rewritten as Request, {
        upgrade: () => true,
      });
      expect((logout as Response).status).toBe(403);
    } finally {
      mesh.close();
    }
  });
});

describe('mesh-inbound token context', () => {
  function inbound(path: string, method = 'GET') {
    const request = get(path, {}, method);
    applyInboundDispatchContext(request, {
      uid: 'tok-user',
      viaNodeId: 'bb'.repeat(16),
      tokenId: 't1',
      tokenScopes: ['exec'],
    });
    return request;
  }

  test('applyInboundDispatchContext keeps the token fields in both contexts', () => {
    const request = inbound('/api/exec', 'POST');
    expect(requestDispatchContext.get(request)).toMatchObject({
      uid: 'tok-user',
      tokenId: 't1',
      tokenScopes: ['exec'],
    });
    expect(requestDispatchContext.get(request)?.sid).toBeUndefined();
  });

  test('scope check passes allowed paths and denies management routes', async () => {
    expect(tokenScopeDenied(inbound('/api/exec', 'POST'))).toBeNull();
    expect(tokenScopeDenied(inbound('/api/devices'))).toBeNull();
    for (const [method, path] of [
      ['GET', '/api/auth/tokens'],
      ['POST', '/api/auth/logout'],
      ['GET', '/api/files/list'],
      ['GET', '/n/self/api/auth/tokens'],
    ] as const) {
      const res = tokenScopeDenied(inbound(path, method));
      expect(res?.status).toBe(403);
      expect(await codeOf(res)).toBe('TOKEN_SCOPE');
    }
  });

  test('handleRequest on the target denies before AuthRoutes (logout, tokens)', async () => {
    const mesh = await bootMesh();
    try {
      for (const [method, path] of [
        ['POST', '/api/auth/logout'],
        ['GET', '/api/auth/tokens'],
        ['GET', '/n/self/api/auth/tokens'],
      ] as const) {
        const res = await mesh.runtime.handleRequest(inbound(path, method), {
          upgrade: () => true,
        });
        expect((res as Response).status).toBe(403);
      }
    } finally {
      mesh.close();
    }
  });

  test('requests with no token in the context are never scope-checked', () => {
    expect(tokenScopeDenied(get('/api/auth/tokens'))).toBeNull();
  });
});
