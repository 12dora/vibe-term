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
  createSetupTransitionLock,
  getLocalStatus,
  precheckRelayUrl,
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
      VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
      VIBETERM_ROLES: 'standalone',
    },
  });
  authHandles.push(ctx);
  return ctx;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-setup-'));
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
    roles: { node: false, relay: false },
    nodeEnv: 'test',
    auth,
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
    now: () => 1_700_000_000_000,
    setupLock: createSetupTransitionLock(),
    ...overrides,
    envPath: overrides.envPath ?? envPath,
    installDir: overrides.installDir ?? dir,
  };
}

describe('precheckRelayUrl', () => {
  test('reachable when relay health answers ok', async () => {
    const deps = await baseDeps({
      fetch: (async () => Response.json({ ok: true })) as FetchLike,
    });
    expect(await precheckRelayUrl('https://relay.example.com', deps)).toEqual({
      reachable: true,
      isSelf: false,
      status: 200,
      error: null,
      resolvedUrl: 'https://relay.example.com',
      triedPorts: [443],
      probed: true,
    });
  });

  test('passes the local self-signed CA to fetch when available', async () => {
    let seenInit: RequestInit | undefined;
    const deps = await baseDeps({
      precheckCaPem: async () => '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      fetch: (async (_input: unknown, init?: RequestInit) => {
        seenInit = init;
        return Response.json({ ok: true });
      }) as FetchLike,
    });
    await precheckRelayUrl('https://relay.example.com', deps);
    expect((seenInit as { tls?: { ca?: string[] } }).tls?.ca?.[0]).toContain('BEGIN CERTIFICATE');
  });

  test('a 200 without ok is not reachable', async () => {
    const deps = await baseDeps({
      fetch: (async () => Response.json({ status: 'ok', startedAt: 42 })) as FetchLike,
    });
    expect(await precheckRelayUrl('https://relay.example.com:13443', deps)).toEqual({
      reachable: false,
      isSelf: false,
      status: 200,
      error: 'relay health status 200',
      resolvedUrl: null,
      triedPorts: [],
      probed: false,
    });
  });

  test('network failure returns reachable false', async () => {
    const deps = await baseDeps({
      fetch: (async () => {
        throw new Error('connection refused');
      }) as FetchLike,
    });
    const result = await precheckRelayUrl('https://hub.example.com:13443', deps);
    expect(result.reachable).toBe(false);
    expect(result.isSelf).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/connection refused/);
  });

  test('probes candidate ports when the url has no port and 443 is dead', async () => {
    const seen: string[] = [];
    const deps = await baseDeps({
      fetch: (async (input: unknown) => {
        const url = new URL(String(input));
        seen.push(`${url.port || '443'}${url.pathname}`);
        if (url.port !== '13443') throw new Error('connection refused');
        return Response.json({ ok: true });
      }) as FetchLike,
    });
    const result = await precheckRelayUrl('https://relay.example.com', deps);
    expect(result.reachable).toBe(true);
    expect(result.isSelf).toBe(false);
    expect(result.probed).toBe(true);
    expect(result.resolvedUrl).toBe('https://relay.example.com:13443');
    expect(result.triedPorts).toContain(13443);
    expect(seen.filter((item) => item === '13443/api/relay/health')).toHaveLength(2);
  });

  test('an explicit port is confirmed without a candidate sweep', async () => {
    const seen: string[] = [];
    const deps = await baseDeps({
      fetch: (async (input: unknown) => {
        seen.push(String(input));
        return Response.json({ ok: true });
      }) as FetchLike,
    });
    const result = await precheckRelayUrl('https://relay.example.com:13443', deps);
    expect(result).toEqual({
      reachable: true,
      isSelf: false,
      status: 200,
      error: null,
      resolvedUrl: null,
      triedPorts: [],
      probed: false,
    });
    expect(seen).toEqual(['https://relay.example.com:13443/api/relay/health']);
  });

  test('no candidate port answering reports every port tried', async () => {
    const deps = await baseDeps({
      fetch: (async () => {
        throw new Error('connection refused');
      }) as FetchLike,
    });
    const result = await precheckRelayUrl('https://relay.example.com', deps);
    expect(result.reachable).toBe(false);
    expect(result.probed).toBe(true);
    expect(result.resolvedUrl).toBeNull();
    expect(result.triedPorts.length).toBeGreaterThan(1);
    expect(result.error).toContain('443');
  });

  test("kind:'relay' probes and confirms with /api/relay/health", async () => {
    const seen: string[] = [];
    const deps = await baseDeps({
      fetch: (async (input: unknown) => {
        const url = new URL(String(input));
        seen.push(`${url.port || '443'}${url.pathname}`);
        if (url.port !== '13443') throw new Error('connection refused');
        return Response.json({ ok: true, version: '1.1.37' });
      }) as FetchLike,
    });
    const result = await precheckRelayUrl('https://relay.example.com', deps);
    expect(result.reachable).toBe(true);
    // 中继健康接口不下发 startedAt，本机判定只对 Hub 有意义
    expect(result.isSelf).toBe(false);
    expect(result.resolvedUrl).toBe('https://relay.example.com:13443');
    expect(seen.every((item) => item.endsWith('/api/relay/health'))).toBe(true);
  });

  test("kind:'relay' refuses a hub answering on a candidate port", async () => {
    const deps = await baseDeps({
      fetch: (async (input: unknown) => {
        // 一台 Hub / 普通节点占着 2053：/healthz 是 ok 的，但 /api/relay/health 不是
        if (new URL(String(input)).pathname === '/healthz') {
          return Response.json({ status: 'ok', startedAt: 1 });
        }
        return new Response('not found', { status: 404 });
      }) as FetchLike,
    });
    const result = await precheckRelayUrl('https://relay.example.com', deps);
    expect(result.reachable).toBe(false);
    expect(result.resolvedUrl).toBeNull();
    expect(result.probed).toBe(true);
  });

  test('rejects non-https remote urls', async () => {
    const deps = await baseDeps();
    await expect(precheckRelayUrl('http://example.com', deps)).rejects.toMatchObject({
      code: 'invalid_url',
      httpStatus: 400,
    });
  });
});

describe('direct status and setLocalDirect', () => {
  test('getLocalStatus maps supported/installed/capable/version/platform', async () => {
    const deps = await baseDeps({
      roles: { node: true, relay: false },
      nodeEnv: 'production',
      isDirectSupported: () => true,
      readNativeManifest: async () => ({ version: '0.33.1' }),
      rtcCapable: true,
      platform: 'darwin-arm64',
    });
    expect(await getLocalStatus(deps)).toEqual({
      role: 'node',
      nodeEnv: 'production',
      direct: {
        supported: true,
        installed: true,
        enabled: true,
        capable: true,
        version: '0.33.1',
        platform: 'darwin-arm64',
      },
      tls: { mode: 'none' },
      relay: null,
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

  test('getLocalStatus enabled is false when VIBETERM_DIRECT_ENABLED is false', async () => {
    const deps = await baseDeps({
      readNativeManifest: async () => ({ version: '0.33.1' }),
      rtcCapable: true,
    });
    await writeFile(deps.envPath, 'VIBETERM_DIRECT_ENABLED=false\n', 'utf8');
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
    expect((await readEnvFile(deps.envPath)).VIBETERM_DIRECT_ENABLED).toBe('true');
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
    expect((await readEnvFile(deps.envPath)).VIBETERM_DIRECT_ENABLED).toBe('false');
  });

  test('setLocalDirect enable requires install and writes VIBETERM_DIRECT_ENABLED=true', async () => {
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
    expect((await readEnvFile(deps.envPath)).VIBETERM_DIRECT_ENABLED).toBe('true');
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
    expect((await readEnvFile(deps.envPath)).VIBETERM_DIRECT_ENABLED).toBeUndefined();
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
    expect((await readEnvFile(deps.envPath)).VIBETERM_DIRECT_ENABLED).toBe('false');
  });

  test('getLocalStatus relay block is null unless roles.relay', async () => {
    const deps = await baseDeps({
      roles: { node: true, relay: true },
      relayStatus: async () => ({
        publicUrl: 'https://relay.example',
        hasPassword: true,
        tenantCount: 2,
        nodesOnline: 3,
        currentNodes: 5,
        turn: {
          enabled: true,
          source: 'builtin',
          url: 'turn:relay.example:3478?transport=udp',
          port: 3478,
          externalIp: '203.0.113.9',
          listening: true,
          allocations: 0,
          error: null,
          relayPortRange: '49160-49259',
        },
      }),
    });
    const status = await getLocalStatus(deps);
    expect(status.role).toBe('relay,node');
    expect(status.relay).toEqual({
      publicUrl: 'https://relay.example',
      hasPassword: true,
      tenantCount: 2,
      nodesOnline: 3,
      currentNodes: 5,
      turn: {
        enabled: true,
        source: 'builtin',
        url: 'turn:relay.example:3478?transport=udp',
        port: 3478,
        externalIp: '203.0.113.9',
        listening: true,
        allocations: 0,
        error: null,
        relayPortRange: '49160-49259',
      },
    });
    expect(JSON.stringify(status)).not.toContain('token');
  });
});
