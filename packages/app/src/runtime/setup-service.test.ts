import type { FetchLike } from '../lib/fetch-like';
import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { enableDirect } from '../commands/direct';
import type { DirectEnableResult } from '../commands/direct';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { pathExists } from '../lib/fs-utils';
import type { LocalAuthContext } from '../lib/local-auth';
import { openLocalAuth } from '../lib/local-auth';
import {
  NATIVE_ADDON_FILENAME,
  NATIVE_DATACHANNEL_VERSION,
  type NativePin,
} from '../lib/native-manifest';
import {
  SetupError,
  becomeHub,
  createSetupTransitionLock,
  getLocalStatus,
  joinHub,
  precheckHubUrl,
  resetProcessSetupLockForTests,
  setLocalDirect,
} from './setup-service';
import type { SetupServiceDeps } from './setup-service';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');

const authHandles: LocalAuthContext[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  resetProcessSetupLockForTests();
  for (const ctx of authHandles.splice(0)) ctx.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-setup-'));
  tempDirs.push(dir);
  return dir;
}

async function baseDeps(
  overrides: Partial<SetupServiceDeps> = {}
): Promise<SetupServiceDeps & { envPath: string; installDir: string }> {
  const dir = await tempDir();
  const envPath = join(dir, 'app.env');
  await writeFile(envPath, 'GATEWAY_PORT=21111\nOTHER=keep\n', 'utf8');
  const auth = overrides.auth ?? (await openAuth());
  return {
    roles: { hub: false, node: false, relay: false },
    nodeEnv: 'test',
    auth,
    hubUrl: null,
    hubPublicUrl: null,
    fetch: (async () => new Response('nope', { status: 404 })) as FetchLike,
    enableDirect: async () => ({
      ok: true,
      platformId: 'darwin-arm64',
      version: '1',
      addonPath: '',
    }),
    disableDirect: async () => undefined,
    isDirectSupported: () => true,
    readNativeManifest: async () => null,
    rtcCapable: false,
    platform: 'darwin-arm64',
    scheduleRestart: () => undefined,
    startedAt: 111,
    now: () => 1_700_000_000_000,
    setupLock: createSetupTransitionLock(),
    ...overrides,
    envPath: overrides.envPath ?? envPath,
    installDir: overrides.installDir ?? dir,
  };
}

describe('becomeHub', () => {
  test('creates the user, writes owned env keys, and schedules restart', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
    });
    const result = await becomeHub(
      {
        hubPublicUrl: 'https://hub.example.com',
        username: 'alice',
        password: 'tmex-test-pass',
        directEnable: false,
      },
      deps
    );
    expect(result).toEqual({
      ok: true,
      fingerprint: result.fingerprint,
      direct: 'skipped',
      directError: null,
      restarting: true,
    });
    expect(result.fingerprint).toHaveLength(64);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    const envText = await readFile(deps.envPath, 'utf8');
    expect(envText).toContain('TMEX_ROLES=hub,node');
    expect(envText).toContain('TMEX_HUB_PUBLIC_URL=https://hub.example.com');
    expect(envText).toContain('GATEWAY_PORT=21111');
    expect(envText).toContain('OTHER=keep');
    expect(restarts).toEqual([1]);
  });

  test('directEnable true maps enableDirect success to enabled', async () => {
    let enabled = 0;
    const deps = await baseDeps({
      enableDirect: async () => {
        enabled += 1;
        return { ok: true, platformId: 'darwin-arm64', version: '1', addonPath: '' };
      },
    });
    const result = await becomeHub(
      {
        hubPublicUrl: 'https://hub.example.com',
        username: 'alice',
        password: 'tmex-test-pass',
        directEnable: true,
      },
      deps
    );
    expect(result.direct).toBe('enabled');
    expect(result.directError).toBeNull();
    expect(enabled).toBe(1);
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBe('true');
  });

  test('direct enable failure is non-fatal', async () => {
    const deps = await baseDeps({
      enableDirect: async () => ({ ok: false, reason: 'HTTP 500' }),
    });
    const result = await becomeHub(
      {
        hubPublicUrl: 'https://hub.example.com',
        username: 'alice',
        password: 'tmex-test-pass',
        directEnable: true,
      },
      deps
    );
    expect(result.direct).toBe('failed');
    expect(result.directError).toBe('HTTP 500');
    expect(result.restarting).toBe(true);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
  });

  test('rejects invalid url, username, and weak password', async () => {
    const deps = await baseDeps();
    await expect(
      becomeHub(
        {
          hubPublicUrl: 'http://example.com',
          username: 'alice',
          password: 'tmex-test-pass',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'invalid_url', httpStatus: 400 });
    await expect(
      becomeHub(
        {
          hubPublicUrl: 'https://hub.example.com',
          username: 'bad name',
          password: 'tmex-test-pass',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'invalid_username', httpStatus: 400 });
    await expect(
      becomeHub(
        {
          hubPublicUrl: 'https://hub.example.com',
          username: 'alice',
          password: 'short',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'weak_password', httpStatus: 400 });
    expect(deps.auth.userStore.getByUsername('alice')).toBeNull();
  });

  test('allows http localhost when not production', async () => {
    const deps = await baseDeps({ nodeEnv: 'development' });
    const result = await becomeHub(
      {
        hubPublicUrl: 'http://127.0.0.1:9443',
        username: 'alice',
        password: 'tmex-test-pass',
        directEnable: false,
      },
      deps
    );
    expect(result.ok).toBe(true);
    const envText = await readFile(deps.envPath, 'utf8');
    expect(envText).toContain('TMEX_HUB_PUBLIC_URL=http://127.0.0.1:9443');
  });

  test('user_exists is 409 and does not restart', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
    });
    const { ensureNodeIdentity } = await import(
      '../../../../apps/gateway/src/auth/node-identity-service'
    );
    const identity = await ensureNodeIdentity(deps.auth.identityStore);
    await deps.auth.userKeys.bootstrapUserWithSelfAdmit({
      username: 'alice',
      password: 'tmex-test-pass',
      identity,
      now: 1,
    });
    await expect(
      becomeHub(
        {
          hubPublicUrl: 'https://hub.example.com',
          username: 'alice',
          password: 'tmex-test-pass',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'user_exists', httpStatus: 409 });
    expect(restarts).toEqual([]);
  });

  test('UNIQUE constraint from bootstrap maps to 409 user_exists', async () => {
    const auth = await openAuth();
    const deps = await baseDeps({
      auth: {
        ...auth,
        userStore: {
          getByUsername: () => null,
        } as unknown as LocalAuthContext['userStore'],
        userKeys: {
          bootstrapUserWithSelfAdmit: async () => {
            throw Object.assign(new Error('UNIQUE constraint failed: users.username'), {
              code: 'SQLITE_CONSTRAINT_UNIQUE',
            });
          },
        } as unknown as LocalAuthContext['userKeys'],
      },
    });
    await expect(
      becomeHub(
        {
          hubPublicUrl: 'https://hub.example.com',
          username: 'alice',
          password: 'tmex-test-pass',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'user_exists', httpStatus: 409 });
  });

  test('concurrent becomeHub: one succeeds and the other is 409 setup_in_progress', async () => {
    const auth = await openAuth();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const deps = await baseDeps({
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
    const input = (username: string) => ({
      hubPublicUrl: 'https://hub.example.com',
      username,
      password: 'tmex-test-pass',
      directEnable: false,
    });
    const first = becomeHub(input('alice'), deps);
    while (entered === 0) await Bun.sleep(1);
    const second = await becomeHub(input('bob'), deps).catch((error) => error);
    expect(second).toBeInstanceOf(SetupError);
    expect((second as SetupError).code).toBe('setup_in_progress');
    expect((second as SetupError).httpStatus).toBe(409);
    release();
    const result = await first;
    expect(result.ok).toBe(true);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    expect(deps.auth.userStore.getByUsername('bob')).toBeNull();
  });

  test('post-commit becomeHub or join is 409 setup_committed', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
      performHubJoin: async () => ({
        userId: 'u',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
    });
    await becomeHub(
      {
        hubPublicUrl: 'https://hub.example.com',
        username: 'alice',
        password: 'tmex-test-pass',
        directEnable: false,
      },
      deps
    );
    expect(restarts).toEqual([1]);
    await expect(
      becomeHub(
        {
          hubPublicUrl: 'https://hub.example.com',
          username: 'carol',
          password: 'tmex-test-pass',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'setup_committed', httpStatus: 409 });
    await expect(
      joinHub(
        {
          hubUrl: 'https://hub.example.com',
          token: 'token-value',
          name: 'studio',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'setup_committed', httpStatus: 409 });
    expect(restarts).toEqual([1]);
  });

  test('env_write_failed leaves the user but does not restart', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
      writeEnvFile: async () => {
        throw new Error('disk full');
      },
    });
    const err = await becomeHub(
      {
        hubPublicUrl: 'https://hub.example.com',
        username: 'alice',
        password: 'tmex-test-pass',
        directEnable: false,
      },
      deps
    ).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('env_write_failed');
    expect((err as SetupError).httpStatus).toBe(500);
    expect((err as SetupError).message).toMatch(/user record may already exist/);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    expect(restarts).toEqual([]);
  });
});

describe('joinHub', () => {
  test('happy path with stubbed performHubJoin writes env and restarts', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
      performHubJoin: async () => ({
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
    });
    await writeFile(
      deps.envPath,
      'GATEWAY_PORT=21111\nOTHER=keep\nTMEX_HUB_PUBLIC_URL=https://stale.example\n',
      'utf8'
    );
    const result = await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: false,
      },
      deps
    );
    expect(result).toEqual({
      ok: true,
      hubUrl: 'https://hub.example.com',
      username: 'bob',
      direct: 'skipped',
      directError: null,
      restarting: true,
    });
    const envText = await readFile(deps.envPath, 'utf8');
    expect(envText).toContain('TMEX_ROLES=node');
    expect(envText).toContain('TMEX_HUB_URL=https://hub.example.com');
    expect(envText).toContain('TMEX_HUB_PUBLIC_URL=');
    expect((await readEnvFile(deps.envPath)).TMEX_HUB_PUBLIC_URL).toBe('');
    expect(envText).toContain('OTHER=keep');
    expect(restarts).toEqual([1]);
  });

  test('directEnable true installs addon and writes TMEX_DIRECT_ENABLED', async () => {
    const deps = await baseDeps({
      performHubJoin: async () => ({
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
      enableDirect: async () => ({
        ok: true as const,
        platformId: 'darwin-arm64',
        version: '1',
        addonPath: '',
      }),
    });
    const result = await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: true,
      },
      deps
    );
    expect(result.direct).toBe('enabled');
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBe('true');
  });

  test('join env rename failure after commit returns 500 recovery and does not restart', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
      performHubJoin: async () => ({
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
      renameEnvFile: async () => {
        throw new Error('EACCES rename');
      },
    });
    const err = await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: false,
      },
      deps
    ).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('env_write_failed');
    expect((err as SetupError).httpStatus).toBe(500);
    expect((err as SetupError).message).toMatch(/joined locally/);
    expect((err as SetupError).message).toContain('TMEX_ROLES=node');
    expect((err as SetupError).message).toContain('TMEX_HUB_URL=https://hub.example.com');
    expect(restarts).toEqual([]);
    const leftovers = (await readdir(dirname(deps.envPath))).filter((name) =>
      name.endsWith('.tmp')
    );
    expect(leftovers).toEqual([]);
  });

  test('join promotion through an absolute symlink updates the target and keeps the link', async () => {
    const dir = await tempDir();
    const volumeDir = join(dir, 'volume');
    const overlayDir = join(dir, 'overlay');
    await mkdir(volumeDir);
    await mkdir(overlayDir);
    const realPath = join(volumeDir, 'app.env');
    const linkPath = join(overlayDir, 'app.env');
    await writeFile(realPath, 'GATEWAY_PORT=21111\nOTHER=keep\n', 'utf8');
    await symlink(realPath, linkPath);
    const deps = await baseDeps({
      envPath: linkPath,
      installDir: dir,
      performHubJoin: async () => ({
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
    });
    await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: false,
      },
      deps
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await realpath(linkPath)).toBe(await realpath(realPath));
    expect(await readEnvFile(realPath)).toMatchObject({
      TMEX_ROLES: 'node',
      TMEX_HUB_URL: 'https://hub.example.com',
      OTHER: 'keep',
    });
  });

  test('join promotion through a relative symlink updates the target and keeps the link', async () => {
    const dir = await tempDir();
    const volumeDir = join(dir, 'volume');
    const overlayDir = join(dir, 'overlay');
    await mkdir(volumeDir);
    await mkdir(overlayDir);
    const realPath = join(volumeDir, 'app.env');
    const linkPath = join(overlayDir, 'app.env');
    await writeFile(realPath, 'GATEWAY_PORT=21111\nOTHER=keep\n', 'utf8');
    await symlink('../volume/app.env', linkPath);
    const deps = await baseDeps({
      envPath: linkPath,
      installDir: dir,
      performHubJoin: async () => ({
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
    });
    await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: false,
      },
      deps
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readEnvFile(realPath)).toMatchObject({
      TMEX_ROLES: 'node',
      TMEX_HUB_URL: 'https://hub.example.com',
    });
  });

  test('join promotion through a dangling symlink writes the missing target', async () => {
    const dir = await tempDir();
    const volumeDir = join(dir, 'volume');
    const overlayDir = join(dir, 'overlay');
    await mkdir(volumeDir);
    await mkdir(overlayDir);
    const realPath = join(volumeDir, 'app.env');
    const linkPath = join(overlayDir, 'app.env');
    await symlink(realPath, linkPath);
    const deps = await baseDeps({
      envPath: linkPath,
      installDir: dir,
      performHubJoin: async () => ({
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      }),
    });
    await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: false,
      },
      deps
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readEnvFile(realPath)).toMatchObject({
      TMEX_ROLES: 'node',
      TMEX_HUB_URL: 'https://hub.example.com',
    });
  });

  test('re-reads env before promote so a concurrent TRUST_PROXY write is kept', async () => {
    const deps = await baseDeps();
    deps.performHubJoin = async () => {
      await withEnvLock(async () => {
        const current = await readEnvFile(deps.envPath);
        await writeEnvFile(deps.envPath, { ...current, TMEX_TRUST_PROXY: 'true' });
      });
      return {
        userId: 'uid-1',
        username: 'bob',
        hubUrl: 'https://hub.example.com',
      };
    };
    await joinHub(
      {
        hubUrl: 'https://hub.example.com',
        token: 'token-value',
        name: 'studio',
        directEnable: false,
      },
      deps
    );
    const env = await readEnvFile(deps.envPath);
    expect(env.TMEX_ROLES).toBe('node');
    expect(env.TMEX_HUB_URL).toBe('https://hub.example.com');
    expect(env.TMEX_TRUST_PROXY).toBe('true');
    expect(env.OTHER).toBe('keep');
  });

  test('maps JoinError codes onto SetupError', async () => {
    const { JoinError } = await import('../commands/hub');
    const deps = await baseDeps({
      performHubJoin: async () => {
        throw new JoinError('node_revoked', 'this node identity was revoked');
      },
    });
    await expect(
      joinHub(
        {
          hubUrl: 'https://hub.example.com',
          token: 'token-value',
          name: 'studio',
          directEnable: false,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'node_revoked', httpStatus: 409 });
  });
});

describe('precheckHubUrl', () => {
  test('reachable + isSelf when healthz matches startedAt', async () => {
    const deps = await baseDeps({
      startedAt: 42,
      fetch: (async () => Response.json({ status: 'ok', startedAt: 42 })) as FetchLike,
    });
    expect(await precheckHubUrl('https://hub.example.com', deps)).toEqual({
      reachable: true,
      isSelf: true,
      status: 200,
      error: null,
    });
  });

  test('passes the local self-signed CA to fetch when available', async () => {
    let seenInit: RequestInit | undefined;
    const deps = await baseDeps({
      startedAt: 42,
      precheckCaPem: async () => '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      fetch: (async (_input: unknown, init?: RequestInit) => {
        seenInit = init;
        return Response.json({ status: 'ok', startedAt: 42 });
      }) as FetchLike,
    });
    await precheckHubUrl('https://hub.example.com', deps);
    expect((seenInit as { tls?: { ca?: string[] } }).tls?.ca?.[0]).toContain('BEGIN CERTIFICATE');
  });

  test('reachable but not self when startedAt differs', async () => {
    const deps = await baseDeps({
      startedAt: 42,
      fetch: (async () => Response.json({ status: 'ok', startedAt: 99 })) as FetchLike,
    });
    expect(await precheckHubUrl('https://hub.example.com', deps)).toEqual({
      reachable: true,
      isSelf: false,
      status: 200,
      error: null,
    });
  });

  test('network failure returns reachable false', async () => {
    const deps = await baseDeps({
      fetch: (async () => {
        throw new Error('connection refused');
      }) as FetchLike,
    });
    const result = await precheckHubUrl('https://hub.example.com', deps);
    expect(result.reachable).toBe(false);
    expect(result.isSelf).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/connection refused/);
  });

  test('rejects non-https remote urls', async () => {
    const deps = await baseDeps();
    await expect(precheckHubUrl('http://example.com', deps)).rejects.toMatchObject({
      code: 'invalid_url',
      httpStatus: 400,
    });
  });
});

describe('direct status and setLocalDirect', () => {
  test('getLocalStatus maps supported/installed/capable/version/platform', async () => {
    const deps = await baseDeps({
      roles: { hub: true, node: true, relay: false },
      nodeEnv: 'production',
      hubUrl: 'https://hub.example.com',
      hubPublicUrl: 'https://pub.example.com',
      isDirectSupported: () => true,
      readNativeManifest: async () => ({ version: '0.33.1' }),
      rtcCapable: true,
      platform: 'darwin-arm64',
    });
    expect(await getLocalStatus(deps)).toEqual({
      role: 'hub,node',
      nodeEnv: 'production',
      hubUrl: 'https://hub.example.com',
      hubPublicUrl: 'https://pub.example.com',
      direct: {
        supported: true,
        installed: true,
        enabled: true,
        capable: true,
        version: '0.33.1',
        platform: 'darwin-arm64',
      },
      tls: { mode: 'none' },
    });
  });

  test('standalone capable is false even if addon files exist', async () => {
    const deps = await baseDeps({
      readNativeManifest: async () => ({ version: '0.33.1' }),
      rtcCapable: false,
    });
    const status = await getLocalStatus(deps);
    expect(status.role).toBe('standalone');
    expect(status.direct.installed).toBe(true);
    expect(status.direct.enabled).toBe(true);
    expect(status.direct.capable).toBe(false);
  });

  test('getLocalStatus enabled is false when TMEX_DIRECT_ENABLED is false', async () => {
    const deps = await baseDeps({
      readNativeManifest: async () => ({ version: '0.33.1' }),
      rtcCapable: true,
    });
    await writeFile(deps.envPath, 'TMEX_DIRECT_ENABLED=false\n', 'utf8');
    const status = await getLocalStatus(deps);
    expect(status.direct.enabled).toBe(false);
    expect(status.direct.installed).toBe(true);
    expect(status.direct.capable).toBe(true);
  });

  test('setLocalDirect install success includes enabled and restartRequired', async () => {
    const deps = await baseDeps({
      enableDirect: async () =>
        ({
          ok: true,
          platformId: 'darwin-arm64',
          version: '1',
          addonPath: 'x',
        }) satisfies DirectEnableResult,
      readNativeManifest: async () => ({ version: '1' }),
      rtcCapable: false,
    });
    expect(await setLocalDirect('install', deps)).toEqual({
      ok: true,
      installed: true,
      enabled: true,
      capable: false,
      restartRequired: true,
    });
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBe('true');
  });

  test('setLocalDirect unsupported is 409', async () => {
    const deps = await baseDeps({
      isDirectSupported: () => false,
      platform: 'linux-riscv64',
    });
    await expect(setLocalDirect('install', deps)).rejects.toMatchObject({
      code: 'direct_unsupported',
      httpStatus: 409,
    });
  });

  test('setLocalDirect download failure is 502', async () => {
    const deps = await baseDeps({
      enableDirect: async () => ({ ok: false, kind: 'download', reason: 'HTTP 503' }),
    });
    await expect(setLocalDirect('install', deps)).rejects.toMatchObject({
      code: 'direct_download_failed',
      httpStatus: 502,
    });
  });

  test('setLocalDirect maps enableDirect failure kinds', async () => {
    const cases = [
      { kind: 'unsupported', code: 'direct_unsupported', status: 409 },
      { kind: 'download', code: 'direct_download_failed', status: 502 },
      { kind: 'integrity', code: 'direct_failed', status: 500 },
      { kind: 'install', code: 'direct_failed', status: 500 },
    ] as const;
    for (const item of cases) {
      const deps = await baseDeps({
        enableDirect: async () =>
          ({
            ok: false,
            kind: item.kind,
            reason: item.kind,
            ...(item.kind === 'unsupported' ? { unsupported: true } : {}),
          }) satisfies DirectEnableResult,
      });
      await expect(setLocalDirect('install', deps)).rejects.toMatchObject({
        code: item.code,
        httpStatus: item.status,
      });
    }
  });

  test('direct timeout aborts fetch and leaves no native/', async () => {
    let fetchSawAborted = false;
    const hangingFetch = (async (_url, init) => {
      const signal = init?.signal;
      await new Promise<never>((_resolve, reject) => {
        const fail = () => {
          fetchSawAborted = signal?.aborted === true;
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail, { once: true });
      });
      throw new Error('unreachable');
    }) as FetchLike;
    const pin: NativePin = {
      platformId: 'darwin-arm64',
      npmPackage: '@node-datachannel/darwin-arm64',
      version: NATIVE_DATACHANNEL_VERSION,
      tarballUrl: 'https://example.test/addon.tgz',
      addonPath: `package/${NATIVE_ADDON_FILENAME}`,
      integrity: 'sha512-unused',
      napiVersion: 8,
    };
    const deps = await baseDeps({
      fetch: hangingFetch,
      enableDirect: (opts) => enableDirect({ ...opts, pin }),
      isDirectSupported: () => true,
      directTimeoutMs: 40,
    });
    await expect(setLocalDirect('install', deps)).rejects.toMatchObject({
      code: 'direct_download_failed',
      httpStatus: 502,
    });
    expect(fetchSawAborted).toBe(true);
    expect(await pathExists(join(deps.installDir, 'native'))).toBe(false);
  });

  test('setLocalDirect remove maps to installed false, enabled false, and restartRequired', async () => {
    let disabled = 0;
    const deps = await baseDeps({
      disableDirect: async () => {
        disabled += 1;
      },
      readNativeManifest: async () => null,
      rtcCapable: true,
    });
    expect(await setLocalDirect('remove', deps)).toEqual({
      ok: true,
      installed: false,
      enabled: false,
      capable: true,
      restartRequired: true,
    });
    expect(disabled).toBe(1);
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBe('false');
  });

  test('setLocalDirect enable requires install and writes TMEX_DIRECT_ENABLED=true', async () => {
    let downloaded = 0;
    const deps = await baseDeps({
      enableDirect: async () => {
        downloaded += 1;
        return { ok: true, platformId: 'darwin-arm64', version: '1', addonPath: 'x' };
      },
      readNativeManifest: async () => ({ version: '1' }),
      rtcCapable: true,
    });
    expect(await setLocalDirect('enable', deps)).toEqual({
      ok: true,
      installed: true,
      enabled: true,
      capable: true,
      restartRequired: true,
    });
    expect(downloaded).toBe(0);
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBe('true');
  });

  test('setLocalDirect enable without install is 409 direct_not_installed', async () => {
    let downloaded = 0;
    const deps = await baseDeps({
      enableDirect: async () => {
        downloaded += 1;
        return { ok: true, platformId: 'darwin-arm64', version: '1', addonPath: 'x' };
      },
      readNativeManifest: async () => null,
    });
    await expect(setLocalDirect('enable', deps)).rejects.toMatchObject({
      code: 'direct_not_installed',
      httpStatus: 409,
    });
    expect(downloaded).toBe(0);
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBeUndefined();
  });

  test('setLocalDirect disable writes env false without removing native', async () => {
    let removed = 0;
    const deps = await baseDeps({
      disableDirect: async () => {
        removed += 1;
      },
      readNativeManifest: async () => ({ version: '1' }),
      rtcCapable: true,
    });
    expect(await setLocalDirect('disable', deps)).toEqual({
      ok: true,
      installed: true,
      enabled: false,
      capable: true,
      restartRequired: true,
    });
    expect(removed).toBe(0);
    expect((await readEnvFile(deps.envPath)).TMEX_DIRECT_ENABLED).toBe('false');
  });
});
