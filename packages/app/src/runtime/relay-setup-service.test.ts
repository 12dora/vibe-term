import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RelayConfigStore } from '../../../../apps/gateway/src/relay/relay-config-store';
import { verifyRelayPassword } from '../../../../apps/gateway/src/relay/relay-password';
import { readEnvFile } from '../lib/env-file';
import type { LocalAuthContext } from '../lib/local-auth';
import { openLocalAuth } from '../lib/local-auth';
import { parseTmexRoles } from '../lib/roles';
import { becomeRelay } from './relay-setup-service';
import {
  SetupError,
  type SetupServiceDeps,
  createSetupTransitionLock,
  getLocalStatus,
  resetProcessSetupLockForTests,
} from './setup-service';

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
  const dir = await mkdtemp(join(tmpdir(), 'tmex-relay-setup-'));
  tempDirs.push(dir);
  return dir;
}

async function baseDeps(overrides: Partial<SetupServiceDeps> = {}): Promise<SetupServiceDeps> {
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
    scheduleRestart: () => undefined,
    now: () => 1_700_000_000_000,
    setupLock: createSetupTransitionLock(),
    enableDirect: async () => ({
      ok: true,
      platformId: 'darwin-arm64',
      version: '1',
      addonPath: '',
    }),
    ...overrides,
    envPath: overrides.envPath ?? envPath,
    installDir: overrides.installDir ?? dir,
  };
}

describe('becomeRelay', () => {
  test('role relay writes env, hashes password, and does not create a user', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
    });
    const result = await becomeRelay(
      {
        role: 'relay',
        relayPublicUrl: 'https://relay.example',
        relayPassword: 'tenant-admit-pass',
      },
      deps
    );
    expect(result).toEqual({
      ok: true,
      role: 'relay',
      relayPublicUrl: 'https://relay.example',
      hasPassword: true,
      restarting: true,
    });
    expect(result).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(result)).not.toContain('TMEX_RELAY_ADMIN_TOKEN');
    expect(deps.auth.userStore.listUsers()).toHaveLength(0);
    expect(await deps.auth.identityStore.load()).toBeNull();
    const env = await readEnvFile(deps.envPath);
    expect(env.TMEX_ROLES).toBe('relay');
    expect(env.TMEX_RELAY_PUBLIC_URL).toBe('https://relay.example');
    expect(env.TMEX_HUB_URL).toBe('');
    expect(env.TMEX_HUB_PUBLIC_URL).toBe('');
    expect(env.TMEX_RELAY_ADMIN_TOKEN).toBeTruthy();
    expect(env.OTHER).toBe('keep');
    expect(restarts).toEqual([1]);
    const config = new RelayConfigStore(deps.auth.db).read();
    expect(config?.passwordHash).toBeTruthy();
    expect(config?.passwordEpoch).toBe(1);
    expect(await verifyRelayPassword(config?.passwordHash ?? '', 'tenant-admit-pass')).toBe(true);
    const envText = await readFile(deps.envPath, 'utf8');
    expect(envText).not.toContain('tenant-admit-pass');
  });

  test('role relay,node bootstraps user, parses roles, and getLocalStatus reports relay,node', async () => {
    const deps = await baseDeps();
    const result = await becomeRelay(
      {
        role: 'relay,node',
        relayPublicUrl: 'https://relay.example',
        username: 'alice',
        password: 'tmex-test-pass',
      },
      deps
    );
    expect(result.role).toBe('relay,node');
    expect(result.hasPassword).toBe(false);
    expect(result.fingerprint).toHaveLength(64);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    const env = await readEnvFile(deps.envPath);
    expect(parseTmexRoles(env.TMEX_ROLES)).toEqual({ hub: false, node: true, relay: true });
    const status = await getLocalStatus({
      ...deps,
      roles: parseTmexRoles(env.TMEX_ROLES),
    });
    expect(status.role).toBe('relay,node');
    expect(status.relay).toEqual({
      publicUrl: null,
      hasPassword: false,
      tenantCount: 0,
      nodesOnline: 0,
      currentNodes: 0,
    });
  });

  test('preserves an existing admin token and does not return it', async () => {
    const dir = await tempDir();
    const envPath = join(dir, 'app.env');
    await writeFile(envPath, 'TMEX_RELAY_ADMIN_TOKEN=keep-this-token\nOTHER=keep\n', 'utf8');
    const deps = await baseDeps({ envPath, installDir: dir });
    const result = await becomeRelay(
      { role: 'relay', relayPublicUrl: 'https://relay.example' },
      deps
    );
    expect(JSON.stringify(result)).not.toContain('keep-this-token');
    expect((await readEnvFile(deps.envPath)).TMEX_RELAY_ADMIN_TOKEN).toBe('keep-this-token');
  });

  test('null or empty relayPassword means no password and does not rotate epoch', async () => {
    const deps = await baseDeps();
    await becomeRelay(
      { role: 'relay', relayPublicUrl: 'https://relay.example', relayPassword: null },
      deps
    );
    const config = new RelayConfigStore(deps.auth.db).read();
    expect(config?.passwordHash).toBeNull();
    expect(config?.passwordEpoch).toBe(0);
  });

  test('rejects invalid relay url, role, and weak node password', async () => {
    const deps = await baseDeps();
    await expect(
      becomeRelay({ role: 'relay', relayPublicUrl: 'http://example.com' }, deps)
    ).rejects.toMatchObject({ code: 'invalid_url', httpStatus: 400 });
    await expect(
      becomeRelay({ role: 'hub,node' as 'relay', relayPublicUrl: 'https://relay.example' }, deps)
    ).rejects.toMatchObject({ code: 'invalid_role', httpStatus: 400 });
    await expect(
      becomeRelay(
        {
          role: 'relay,node',
          relayPublicUrl: 'https://relay.example',
          username: 'alice',
          password: 'short',
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'weak_password', httpStatus: 400 });
    await expect(
      becomeRelay(
        {
          role: 'relay',
          relayPublicUrl: 'https://relay.example',
          relayPassword: 'short',
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'weak_password', httpStatus: 400 });
  });

  test('loopback http is allowed in test', async () => {
    const deps = await baseDeps();
    const result = await becomeRelay(
      { role: 'relay', relayPublicUrl: 'http://127.0.0.1:19993' },
      deps
    );
    expect(result.relayPublicUrl).toBe('http://127.0.0.1:19993');
  });

  test('not_standalone is 409', async () => {
    const deps = await baseDeps({ roles: { hub: true, node: true, relay: false } });
    await expect(
      becomeRelay({ role: 'relay', relayPublicUrl: 'https://relay.example' }, deps)
    ).rejects.toMatchObject({ code: 'not_standalone', httpStatus: 409 });
  });

  test('user_exists is 409 for relay,node', async () => {
    const deps = await baseDeps();
    await becomeRelay(
      {
        role: 'relay,node',
        relayPublicUrl: 'https://relay.example',
        username: 'alice',
        password: 'tmex-test-pass',
      },
      deps
    );
    resetProcessSetupLockForTests();
    const again = await baseDeps({
      auth: deps.auth,
      envPath: deps.envPath,
      installDir: deps.installDir,
      setupLock: createSetupTransitionLock(),
    });
    await expect(
      becomeRelay(
        {
          role: 'relay,node',
          relayPublicUrl: 'https://relay.example',
          username: 'alice',
          password: 'tmex-test-pass',
        },
        again
      )
    ).rejects.toMatchObject({ code: 'user_exists', httpStatus: 409 });
  });
});
