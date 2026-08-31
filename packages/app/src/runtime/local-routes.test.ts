import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import { authenticateRequest } from '../../../../apps/gateway/src/mesh/session-middleware';
import { parseEnvContent } from '../lib/env-file';
import type { LocalAuthContext } from '../lib/local-auth';
import { openLocalAuth } from '../lib/local-auth';
import { handleLocalRequest } from './local-routes';
import type { LocalRouteDeps } from './local-routes';
import {
  type SetupServiceDeps,
  createSetupTransitionLock,
  resetProcessSetupLockForTests,
} from './setup-service';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const authHandles: LocalAuthContext[] = [];

afterEach(() => {
  resetProcessSetupLockForTests();
  for (const ctx of authHandles.splice(0)) ctx.close();
});

function okAuth(): AuthenticateResult {
  return { ok: true, userId: 'u1', session: null, sid: 'sid' };
}

function failAuth(): AuthenticateResult {
  return { ok: false };
}

function deps(overrides: Partial<LocalRouteDeps> = {}): LocalRouteDeps {
  const env: Record<string, string> = {};
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
    readEnvFile: async () => ({ ...env }),
    writeEnvFile: async (_path, values) => {
      for (const key of Object.keys(env)) delete env[key];
      Object.assign(env, values);
    },
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
        enabled: true,
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

  test('enabled is false when env says false even if addon is installed', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status'),
        deps({
          readNativeManifest: async () => ({ version: '1' }),
          rtcCapable: true,
          readEnvFile: async () => ({ TMEX_DIRECT_ENABLED: 'false' }),
        })
      )
    );
    expect(status).toBe(200);
    expect(
      (body as { direct: { enabled: boolean; installed: boolean; capable: boolean } }).direct
    ).toEqual({
      supported: true,
      installed: true,
      enabled: false,
      capable: true,
      version: '1',
      platform: 'darwin-arm64',
    });
  });

  test('unrelated paths return null', async () => {
    expect(
      await handleLocalRequest(new Request('http://127.0.0.1/api/devices'), deps())
    ).toBeNull();
  });

  test('standalone 把鉴权交给 authenticate：拒绝则 401，放行则 200', async () => {
    const denied = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status'),
        deps({ authenticate: failAuth })
      )
    );
    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'login required' } });

    const allowed = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/status'),
        deps({ authenticate: okAuth })
      )
    );
    expect(allowed.status).toBe(200);
    expect((allowed.body as { role: string }).role).toBe('standalone');
  });
});

describe('POST /api/local/direct', () => {
  test('install success returns enabled and restartRequired', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'install' }),
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
      enabled: true,
      capable: false,
      restartRequired: true,
    });
  });

  test('remove deletes native and returns enabled false', async () => {
    let removed = 0;
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'remove' }),
        }),
        deps({
          disableDirect: async () => {
            removed += 1;
          },
        })
      )
    );
    expect(status).toBe(200);
    expect(removed).toBe(1);
    expect(body).toEqual({
      ok: true,
      installed: false,
      enabled: false,
      capable: false,
      restartRequired: true,
    });
  });

  test('enable without install is 409 direct_not_installed', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'enable' }),
        }),
        deps({ readNativeManifest: async () => null })
      )
    );
    expect(status).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('direct_not_installed');
  });

  test('enable when installed writes env without downloading', async () => {
    let downloaded = 0;
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'enable' }),
        }),
        deps({
          readNativeManifest: async () => ({ version: '1' }),
          enableDirect: async () => {
            downloaded += 1;
            return { ok: true, platformId: 'darwin-arm64', version: '1', addonPath: 'x' };
          },
        })
      )
    );
    expect(status).toBe(200);
    expect(downloaded).toBe(0);
    expect(body).toEqual({
      ok: true,
      installed: true,
      enabled: true,
      capable: false,
      restartRequired: true,
    });
  });

  test('disable writes enabled false without removing native', async () => {
    let removed = 0;
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'disable' }),
        }),
        deps({
          readNativeManifest: async () => ({ version: '1' }),
          disableDirect: async () => {
            removed += 1;
          },
        })
      )
    );
    expect(status).toBe(200);
    expect(removed).toBe(0);
    expect(body).toEqual({
      ok: true,
      installed: true,
      enabled: false,
      capable: false,
      restartRequired: true,
    });
  });

  test('legacy { enable } body is 400 invalid_action', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable: true }),
        }),
        deps()
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_action');
  });

  test('missing or unknown action is 400 invalid_action', async () => {
    for (const payload of [null, {}, { action: 'toggle' }, { action: 1 }]) {
      const { status, body } = await jsonOf(
        await handleLocalRequest(
          new Request('http://127.0.0.1/api/local/direct', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload === null ? 'null' : JSON.stringify(payload),
          }),
          deps()
        )
      );
      expect(status).toBe(400);
      expect((body as { error: { code: string } }).error.code).toBe('invalid_action');
    }
  });

  test('unsupported is 409', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'install' }),
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
          body: JSON.stringify({ action: 'install' }),
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
          body: JSON.stringify({ action: 'install' }),
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

  test('standalone POST 同样走 authenticate', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'remove' }),
        }),
        deps({ authenticate: failAuth })
      )
    );
    expect(status).toBe(401);
    expect((body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  test('mesh 401 applies to POST as well', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        new Request('http://127.0.0.1/api/local/direct', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'remove' }),
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

describe('POST /api/local/leave', () => {
  function leaveRequest(body: unknown): Request {
    return new Request('http://127.0.0.1/api/local/leave', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('standalone is 400 not_member without auth', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        leaveRequest({ expectedRole: 'node' }),
        deps({ authenticate: failAuth })
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('not_member');
  });

  test('mesh without a self session is 401 unauthorized', async () => {
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        leaveRequest({ expectedRole: 'node' }),
        deps({
          roles: { hub: false, node: true },
          authenticate: failAuth,
        })
      )
    );
    expect(status).toBe(401);
    expect(body).toEqual({ error: { code: 'unauthorized', message: 'login required' } });
  });

  test('mesh happy path clears membership and returns restarting', async () => {
    const ctx = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'node',
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
    const env: Record<string, string> = {
      TMEX_ROLES: 'node',
      TMEX_HUB_URL: 'https://hub.example',
      TMEX_HUB_PUBLIC_URL: 'https://stale.example',
    };
    let staged = '';
    const restarts: number[] = [];
    const { status, body } = await jsonOf(
      await handleLocalRequest(
        leaveRequest({ expectedRole: 'node' }),
        deps({
          roles: { hub: false, node: true },
          auth: ctx,
          authenticate: okAuth,
          scheduleRestart: () => {
            restarts.push(1);
          },
          setupLock: createSetupTransitionLock(),
          readEnvFile: async () => ({ ...env }),
          writeStagedEnvFile: async (_path, content) => {
            staged = content;
          },
          renameEnvFile: async () => {
            const parsed = parseEnvContent(staged);
            for (const key of Object.keys(env)) delete env[key];
            Object.assign(env, parsed);
          },
        })
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, fromRole: 'node', restarting: true });
    expect(restarts).toEqual([1]);
    expect(ctx.userStore.listUsers()).toHaveLength(0);
    expect(await ctx.identityStore.load()).toBeNull();
    expect(env.TMEX_ROLES).toBe('standalone');
    expect(env.TMEX_HUB_URL).toBe('');
    expect(env.TMEX_HUB_PUBLIC_URL).toBe('');
  });
});
