import { setMeshRequestContext } from '../../../../apps/gateway/src/mesh/mesh-deps';
import type { FetchLike } from '../lib/fetch-like';
import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { LocalAuthContext } from '../lib/local-auth';
import { openLocalAuth } from '../lib/local-auth';
import { handleSetupRequest } from './setup-routes';
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

async function openAuth(): Promise<LocalAuthContext> {
  const ctx = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
      VIBETERM_ROLES: 'standalone',
    },
  });
  authHandles.push(ctx);
  return ctx;
}

function deps(overrides: Partial<SetupServiceDeps> = {}): SetupServiceDeps {
  return {
    roles: { node: false, relay: false },
    nodeEnv: 'test',
    auth: {
      userStore: { getByUsername: () => null },
    } as unknown as LocalAuthContext,
    envPath: '/tmp/app.env',
    installDir: '/tmp',
    scheduleRestart: () => undefined,
    fetch: (async () => Response.json({ ok: true })) as FetchLike,
    readEnvFile: async () => ({ OTHER: 'keep' }),
    writeEnvFile: async () => undefined,
    writeStagedEnvFile: async () => undefined,
    renameEnvFile: async () => undefined,
    removeStagedEnvFile: async () => undefined,
    enableDirect: async () => ({
      ok: true,
      platformId: 'darwin-arm64',
      version: '1',
      addonPath: 'x',
    }),
    setupLock: createSetupTransitionLock(),
    ...overrides,
  };
}

async function jsonOf(res: Response | null): Promise<{ status: number; body: unknown }> {
  if (!res) throw new Error('expected a response');
  return { status: res.status, body: await res.json() };
}

function post(
  path: string,
  body: unknown,
  clientIp = '127.0.0.1',
  headers: Record<string, string> = {}
): Request {
  const req = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  setMeshRequestContext(req, { via: 'self', clientIp });
  return req;
}

describe('setup routes gating', () => {
  test('mesh returns 404 not_standalone for all setup paths', async () => {
    const mesh = deps({ roles: { node: true, relay: false } });
    for (const path of ['/api/setup/precheck', '/api/setup/relay', '/api/setup/relay-join']) {
      const { status, body } = await jsonOf(
        await handleSetupRequest(post(path, { url: 'https://h.example' }), mesh)
      );
      expect(status).toBe(404);
      expect(body).toEqual({
        error: { code: 'not_standalone', message: 'setup is only available in standalone mode' },
      });
    }
  });

  test('unrelated paths return null', async () => {
    expect(await handleSetupRequest(post('/api/auth/login', {}), deps())).toBeNull();
  });

  test('before credentials, a public client is loopback-only', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com' }, '203.0.113.9'),
        deps()
      )
    );
    expect(status).toBe(403);
    expect(body).toEqual({
      error: {
        code: 'LOOPBACK_REQUIRED',
        message: 'setup is only available on this machine',
      },
    });
  });

  test('once a user exists, loopback without a session is unauthorized', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com' }),
        deps({
          auth: {
            userStore: { listUsers: () => [{ id: 'u1' }], getByUsername: () => null },
          } as unknown as LocalAuthContext,
        })
      )
    );
    expect(status).toBe(401);
    expect(body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'login required' } });
  });

  test('a loopback socket with proxy headers is not local before credentials', async () => {
    const cases: Record<string, string>[] = [
      { 'x-forwarded-for': '203.0.113.8' },
      { 'x-real-ip': '203.0.113.8' },
      { 'cf-connecting-ip': '203.0.113.8' },
      { forwarded: 'for=203.0.113.8' },
    ];
    for (const headers of cases) {
      const { status, body } = await jsonOf(
        await handleSetupRequest(
          post('/api/setup/precheck', { url: 'https://relay.example.com' }, '127.0.0.1', headers),
          deps()
        )
      );
      expect(status).toBe(403);
      expect(body).toEqual({
        error: {
          code: 'LOOPBACK_REQUIRED',
          message: 'setup is only available on this machine',
        },
      });
    }
  });

  test('an open auth bypass still requires a loopback socket', async () => {
    const withUsers = deps({
      auth: {
        userStore: { listUsers: () => [{ id: 'u1' }], getByUsername: () => null },
      } as unknown as LocalAuthContext,
      authenticate: () => ({ ok: true, userId: null }),
    } as Partial<SetupServiceDeps> & {
      authenticate: () => { ok: true; userId: null };
    });
    const remote = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com' }, '203.0.113.9'),
        withUsers
      )
    );
    expect(remote.status).toBe(403);
    const local = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com' }),
        withUsers
      )
    );
    expect(local.status).toBe(200);
  });

  test('a valid session proceeds after credentials exist', async () => {
    const { status } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com' }),
        deps({
          auth: {
            userStore: { listUsers: () => [{ id: 'u1' }], getByUsername: () => null },
          } as unknown as LocalAuthContext,
          authenticate: () => ({ ok: true, userId: 'u1' }),
        } as Partial<SetupServiceDeps> & {
          authenticate: (req: Request) => { ok: true; userId: string };
        })
      )
    );
    expect(status).toBe(200);
  });
});

describe('POST /api/setup/precheck', () => {
  test('returns reachable/isSelf per contract', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com' }),
        deps()
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      reachable: true,
      isSelf: false,
      status: 200,
      error: null,
      resolvedUrl: 'https://relay.example.com',
      triedPorts: [443],
      probed: true,
    });
  });

  test("kind:'relay' switches the health predicate to /api/relay/health", async () => {
    const seen: string[] = [];
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com', kind: 'relay' }),
        deps({
          fetch: (async (input: unknown) => {
            seen.push(new URL(String(input)).pathname);
            return Response.json({ ok: true });
          }) as FetchLike,
        })
      )
    );
    expect(status).toBe(200);
    expect((body as { reachable: boolean; isSelf: boolean }).reachable).toBe(true);
    expect((body as { isSelf: boolean }).isSelf).toBe(false);
    expect(seen).toEqual(['/api/relay/health', '/api/relay/health']);
  });

  test('an unknown kind is 400', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://relay.example.com', kind: 'hub' }),
        deps()
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_body');
  });

  test('invalid_url is 400', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'ftp://hub.example.com' }),
        deps()
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_url');
  });
});

describe('POST /api/setup/relay-join', () => {
  test('happy path with stubbed performRelayPasswordJoin', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/relay-join', {
          relayUrl: 'https://relay.example',
          tenantId: 'tenant-1',
          password: 'vibeterm-test-pass',
          name: 'studio',
          directEnable: false,
        }),
        {
          ...deps(),
          ...({
            performRelayPasswordJoin: async () => ({
              relayUrl: 'https://relay.example',
              tenantId: 'tenant-1',
              userId: 'alice',
            }),
          } as object),
        } as SetupServiceDeps
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      relayUrl: 'https://relay.example',
      tenantId: 'tenant-1',
      username: 'alice',
      direct: 'skipped',
      directError: null,
      restarting: true,
    });
  });
});

describe('setup 默认安装直连插件', () => {
  test('/api/setup/relay 未传 directEnable 时启用插件', async () => {
    const auth = await openAuth();
    let calls = 0;
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/relay', {
          role: 'relay',
          relayPublicUrl: 'https://relay.example',
        }),
        deps({
          auth,
          enableDirect: async () => {
            calls += 1;
            return { ok: true, platformId: 'darwin-arm64', version: '1', addonPath: 'x' };
          },
        })
      )
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ direct: 'enabled', directError: null });
    expect(calls).toBe(1);
  });
});
