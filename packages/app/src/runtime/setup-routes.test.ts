import type { FetchLike } from '../lib/fetch-like';
import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { JoinError } from '../commands/hub';
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
      TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
      TMEX_ROLES: 'standalone',
    },
  });
  authHandles.push(ctx);
  return ctx;
}

function deps(overrides: Partial<SetupServiceDeps> = {}): SetupServiceDeps {
  return {
    roles: { hub: false, node: false, relay: false },
    nodeEnv: 'test',
    auth: {
      userStore: { getByUsername: () => null },
    } as unknown as LocalAuthContext,
    envPath: '/tmp/app.env',
    installDir: '/tmp',
    scheduleRestart: () => undefined,
    startedAt: 7,
    fetch: (async () => Response.json({ status: 'ok', startedAt: 7 })) as FetchLike,
    performHubJoin: async () => ({
      userId: 'uid',
      username: 'alice',
      hubUrl: 'https://hub.example.com',
    }),
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

function post(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('setup routes gating', () => {
  test('mesh returns 404 not_standalone for all setup paths', async () => {
    const mesh = deps({ roles: { hub: true, node: true, relay: false } });
    for (const path of [
      '/api/setup/precheck',
      '/api/setup/hub',
      '/api/setup/join',
      '/api/setup/relay',
      '/api/setup/relay-join',
    ]) {
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
});

describe('POST /api/setup/precheck', () => {
  test('returns reachable/isSelf per contract', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/precheck', { url: 'https://hub.example.com' }),
        deps()
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({ reachable: true, isSelf: true, status: 200, error: null });
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

describe('POST /api/setup/hub', () => {
  test('validation errors map to contract codes', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/hub', {
          hubPublicUrl: 'https://hub.example.com',
          username: 'alice',
          password: 'short',
          directEnable: false,
        }),
        deps()
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('weak_password');
  });

  test('user_exists is 409', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/hub', {
          hubPublicUrl: 'https://hub.example.com',
          username: 'alice',
          password: 'tmex-test-pass',
          directEnable: false,
        }),
        deps({
          auth: {
            userStore: { getByUsername: () => ({ id: 'u' }) },
          } as unknown as LocalAuthContext,
        })
      )
    );
    expect(status).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe('user_exists');
  });

  test('concurrent becomeHub yields one 200 and one 409 setup_in_progress', async () => {
    const auth = await openAuth();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const shared = deps({
      auth: {
        ...auth,
        userKeys: {
          bootstrapUserWithSelfAdmit: async (input) => {
            entered += 1;
            await held;
            return auth.userKeys.bootstrapUserWithSelfAdmit(input);
          },
        } as LocalAuthContext['userKeys'],
      },
    });
    const bodyOf = (username: string) =>
      post('/api/setup/hub', {
        hubPublicUrl: 'https://hub.example.com',
        username,
        password: 'tmex-test-pass',
        directEnable: false,
      });
    const first = handleSetupRequest(bodyOf('alice'), shared);
    while (entered === 0) await Bun.sleep(1);
    const second = await jsonOf(await handleSetupRequest(bodyOf('bob'), shared));
    expect(second.status).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe('setup_in_progress');
    release();
    const firstRes = await jsonOf(await first);
    expect(firstRes.status).toBe(200);
    expect((firstRes.body as { ok: boolean; restarting: boolean }).ok).toBe(true);
  });

  test('post-commit hub request is 409 setup_committed', async () => {
    const auth = await openAuth();
    const shared = deps({ auth });
    const first = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/hub', {
          hubPublicUrl: 'https://hub.example.com',
          username: 'alice',
          password: 'tmex-test-pass',
          directEnable: false,
        }),
        shared
      )
    );
    expect(first.status).toBe(200);
    const second = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/hub', {
          hubPublicUrl: 'https://hub.example.com',
          username: 'bob',
          password: 'tmex-test-pass',
          directEnable: false,
        }),
        shared
      )
    );
    expect(second.status).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe('setup_committed');
  });
});

describe('POST /api/setup/join', () => {
  test('happy path with stubbed join', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/join', {
          hubUrl: 'https://hub.example.com',
          token: 'token',
          name: 'studio',
          directEnable: false,
        }),
        deps()
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      hubUrl: 'https://hub.example.com',
      username: 'alice',
      direct: 'skipped',
      directError: null,
      restarting: true,
    });
  });

  test('join env rename failure is 500 with recovery message and does not restart', async () => {
    const restarts: number[] = [];
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/join', {
          hubUrl: 'https://hub.example.com',
          token: 'token',
          name: 'studio',
          directEnable: false,
        }),
        deps({
          scheduleRestart: () => {
            restarts.push(1);
          },
          renameEnvFile: async () => {
            throw new Error('EACCES rename');
          },
        })
      )
    );
    expect(status).toBe(500);
    expect((body as { error: { code: string; message: string } }).error.code).toBe(
      'env_write_failed'
    );
    expect((body as { error: { message: string } }).error.message).toMatch(/joined locally/);
    expect((body as { error: { message: string } }).error.message).toContain('TMEX_ROLES=node');
    expect((body as { error: { message: string } }).error.message).toContain(
      'TMEX_HUB_URL=https://hub.example.com'
    );
    expect(restarts).toEqual([]);
  });

  test('join errors map to HTTP statuses', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/join', {
          hubUrl: 'https://hub.example.com',
          token: 'token',
          name: 'studio',
          directEnable: false,
        }),
        deps({
          performHubJoin: async () => {
            throw new JoinError('hub_unreachable', 'down');
          },
        })
      )
    );
    expect(status).toBe(502);
    expect((body as { error: { code: string; message: string } }).error).toEqual({
      code: 'hub_unreachable',
      message: 'down',
    });
  });

  test('password method exchanges then joins', async () => {
    let issued = '';
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/join', {
          hubUrl: 'https://hub.example.com',
          method: 'password',
          password: 'tmex-test-pass',
          name: 'studio',
          directEnable: false,
        }),
        deps({
          requestEnrollmentByPassword: async () => ({
            token: 'issued-token',
            hubUrl: 'https://hub.example.com',
            caFingerprint: null,
          }),
          performHubJoin: async (input) => {
            issued = input.token;
            return {
              userId: 'uid',
              username: 'alice',
              hubUrl: 'https://hub.example.com',
            };
          },
        })
      )
    );
    expect(status).toBe(200);
    expect(issued).toBe('issued-token');
    expect((body as { ok: boolean; username: string }).username).toBe('alice');
  });

  test('token and password together are 400', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/join', {
          hubUrl: 'https://hub.example.com',
          token: 'tok',
          password: 'pw',
          name: 'studio',
          directEnable: false,
        }),
        deps()
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_body');
  });

  test('token and password both empty are 400', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/join', {
          hubUrl: 'https://hub.example.com',
          name: 'studio',
          directEnable: false,
        }),
        deps()
      )
    );
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('invalid_body');
  });
});

describe('POST /api/setup/relay', () => {
  test('standalone relay role returns contract body without admin token', async () => {
    const auth = await openAuth();
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/relay', {
          role: 'relay',
          relayPublicUrl: 'https://relay.example',
          relayPassword: 'tenant-pass',
        }),
        deps({ auth })
      )
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      role: 'relay',
      relayPublicUrl: 'https://relay.example',
      hasPassword: true,
      restarting: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/admin/i);
  });

  test('invalid url is 400', async () => {
    const { status, body } = await jsonOf(
      await handleSetupRequest(
        post('/api/setup/relay', { role: 'relay', relayPublicUrl: 'ftp://relay.example' }),
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
          password: 'tmex-test-pass',
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
