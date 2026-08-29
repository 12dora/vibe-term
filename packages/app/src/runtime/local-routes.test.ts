import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import { authenticateRequest } from '../../../../apps/gateway/src/mesh/session-middleware';
import type { LocalAuthContext } from '../lib/local-auth';
import { openLocalAuth } from '../lib/local-auth';
import { handleLocalRequest } from './local-routes';
import type { LocalRouteDeps } from './local-routes';
import type { SetupServiceDeps } from './setup-service';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const authHandles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of authHandles.splice(0)) ctx.close();
});

function okAuth(): AuthenticateResult {
  return { ok: true, userId: 'u1', session: null, sid: 'sid' };
}

function failAuth(): AuthenticateResult {
  return { ok: false };
}

function deps(overrides: Partial<LocalRouteDeps> = {}): LocalRouteDeps {
  const base: SetupServiceDeps = {
    roles: { hub: false, node: false },
    nodeEnv: 'test',
    auth: {} as SetupServiceDeps['auth'],
    envPath: '/tmp/app.env',
    installDir: '/tmp',
    isDirectSupported: () => true,
    readNativeManifest: async () => null,
    rtcCapable: false,
    platform: 'darwin-arm64',
    hubUrl: null,
    hubPublicUrl: null,
  };
  return {
    ...base,
    authenticate: okAuth,
    tlsStatus: async () => ({ mode: 'none', listenerRunning: false, tlsPort: 9443 }),
    ...overrides,
  };
}

async function jsonOf(res: Response | null): Promise<{ status: number; body: unknown }> {
  if (!res) throw new Error('expected a response');
  return { status: res.status, body: await res.json() };
}

describe('GET /api/local/status', () => {
  test('standalone is open and returns the contract body', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(new Request('http://127.0.0.1/api/local/status'), deps())
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      role: 'standalone',
      nodeEnv: 'test',
      hubUrl: null,
      hubPublicUrl: null,
      direct: {
        supported: true,
        installed: false,
        capable: false,
        version: null,
        platform: 'darwin-arm64',
      },
      tls: { mode: 'none', listenerRunning: false, tlsPort: 9443 },
    });
  });

  test('tls fields come from tlsStatus and keep mode first', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status'),
        deps({
          tlsStatus: async () => ({
            mode: 'selfsigned',
            listenerRunning: true,
            tlsPort: 21443,
          }),
        })
      )
    );
    expect(status).toBe(200);
    expect(Object.keys((body as { tls: object }).tls)).toEqual([
      'mode',
      'listenerRunning',
      'tlsPort',
    ]);
    expect((body as { tls: unknown }).tls).toEqual({
      mode: 'selfsigned',
      listenerRunning: true,
      tlsPort: 21443,
    });
  });

  test('mesh without a self session is 401 UNAUTHORIZED', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status'),
        deps({
          roles: { hub: false, node: true },
          authenticate: failAuth,
        })
      )
    );
    expect(status).toBe(401);
    expect(body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'login required' } });
  });

  test('mesh with a valid session returns 200', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status'),
        deps({
          roles: { hub: true, node: true },
          hubPublicUrl: 'https://hub.example',
          authenticate: okAuth,
        })
      )
    );
    expect(status).toBe(200);
    expect((body as { role: string }).role).toBe('hub,node');
  });

  test('unrelated paths return null', async () => {
    expect(
      await handleLocalRequest(new Request('http://127.0.0.1/api/devices'), deps())
    ).toBeNull();
  });
});

describe('POST /api/local/direct', () => {
  test('enable success returns restartRequired', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable: true }),
        }),
        deps({
          enableDirect: async () => ({
            ok: true,
            platformId: 'darwin-arm64',
            version: '1',
            addonPath: 'x',
          }),
        })
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      installed: true,
      capable: false,
      restartRequired: true,
    });
  });

  test('unsupported is 409', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable: true }),
        }),
        deps({ isDirectSupported: () => false, platform: 'linux-riscv64' })
      )
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      error: {
        code: 'direct_unsupported',
        message: 'no pinned manifest for linux-riscv64',
      },
    });
  });

  test('download failure is 502', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable: true }),
        }),
        deps({
          enableDirect: async () => ({ ok: false, kind: 'download', reason: 'HTTP 503' }),
        })
      )
    );
    expect(status).toBe(502);
    expect((body as { error: { code: string; message: string } }).error).toEqual({
      code: 'direct_download_failed',
      message: 'HTTP 503',
    });
  });

  test('integrity failure is 500 direct_failed', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable: true }),
        }),
        deps({
          enableDirect: async () => ({
            ok: false,
            kind: 'integrity',
            reason: 'integrity mismatch',
          }),
        })
      )
    );
    expect(status).toBe(500);
    expect((body as { error: { code: string; message: string } }).error).toEqual({
      code: 'direct_failed',
      message: 'integrity mismatch',
    });
  });

  test('mesh 401 applies to POST as well', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable: false }),
        }),
        deps({
          roles: { hub: false, node: true },
          authenticate: failAuth,
        })
      )
    );
    expect(status).toBe(401);
    expect((body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/local/status mesh gating with NodeSessionStore', () => {
  async function meshWithSession(): Promise<{
    routeDeps: LocalRouteDeps;
    sid: string;
  }> {
    const ctx = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
      },
    });
    authHandles.push(ctx);
    const identity = await ensureNodeIdentity(ctx.identityStore);
    await ctx.userKeys.bootstrapUserWithSelfAdmit({
      username: 'alice',
      password: 'tmex-test-pass',
      identity,
      now: Date.now(),
    });
    const user = ctx.userStore.getByUsername('alice');
    if (!user) throw new Error('expected alice');
    const issued = ctx.nodeSessionStore.issue({
      userId: user.id,
      viaNodeId: 'self',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const roles = { hub: true, node: true };
    return {
      sid: issued.sid,
      routeDeps: deps({
        roles,
        hubPublicUrl: 'https://hub.example',
        authenticate: (req) =>
          authenticateRequest(req, {
            roles,
            nodeSessionStore: ctx.nodeSessionStore,
          }),
      }),
    };
  }

  test('real NodeSessionStore rejects missing cookie with 401 and accepts a valid self session', async () => {
    const { routeDeps, sid } = await meshWithSession();
    const denied = await jsonOf(
      await handleLocalRequest(new Request('http://127.0.0.1/api/local/status'), routeDeps)
    );
    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'login required' } });

    const allowed = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status', {
          headers: { cookie: `tmex_s_self=${sid}` },
        }),
        routeDeps
      )
    );
    expect(allowed.status).toBe(200);
    expect((allowed.body as { role: string }).role).toBe('hub,node');
  });
});
