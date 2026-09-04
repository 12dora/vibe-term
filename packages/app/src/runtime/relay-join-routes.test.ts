import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile } from '../lib/env-file';
import type { LocalAuthContext } from '../lib/local-auth';
import { handleRelayJoinRequest } from './relay-join-routes';
import { type SetupServiceDeps, createSetupTransitionLock } from './setup-service';
import { resetProcessSetupLockForTests } from './setup-shared';

const tempDirs: string[] = [];

afterEach(async () => {
  resetProcessSetupLockForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function deps(overrides: Partial<SetupServiceDeps> = {}): Promise<SetupServiceDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-relay-join-'));
  tempDirs.push(dir);
  const envPath = join(dir, 'app.env');
  await writeFile(
    envPath,
    'TMEX_ROLES=standalone\nOTHER=keep\nTMEX_HUB_URL=https://stale.example\n',
    'utf8'
  );
  return {
    roles: { hub: false, node: false, relay: false },
    nodeEnv: 'test',
    auth: { userStore: { getByUsername: () => null } } as unknown as LocalAuthContext,
    envPath,
    installDir: dir,
    scheduleRestart: () => undefined,
    setupLock: createSetupTransitionLock(),
    ...overrides,
  };
}

describe('handleRelayJoinRequest', () => {
  test('calls performRelayPasswordJoin and writes node env via staged promote', async () => {
    let seen: unknown;
    const base = await deps();
    const res = await handleRelayJoinRequest(
      {
        relayUrl: 'https://relay.example',
        tenantId: 'abc',
        password: 'tmex-test-pass',
        name: 'studio',
        caFingerprint: 'ab'.repeat(32),
        directEnable: false,
      },
      {
        ...base,
        performRelayPasswordJoin: async (input) => {
          seen = input;
          return { relayUrl: input.relayUrl, tenantId: input.tenantId, userId: 'alice' };
        },
      }
    );
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({
      relayUrl: 'https://relay.example',
      tenantId: 'abc',
      password: 'tmex-test-pass',
      name: 'studio',
      caFingerprint: 'ab'.repeat(32),
    });
    const env = await readEnvFile(base.envPath);
    expect(env.TMEX_ROLES).toBe('node');
    expect(env.TMEX_HUB_URL).toBe('');
    expect(env.TMEX_HUB_PUBLIC_URL).toBe('');
    expect(env.OTHER).toBe('keep');
  });

  test('keeps the relay role when the machine already runs relay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-relay-join-'));
    tempDirs.push(dir);
    const envPath = join(dir, 'app.env');
    await writeFile(envPath, 'TMEX_ROLES=relay\n', 'utf8');
    const res = await handleRelayJoinRequest(
      {
        relayUrl: 'https://relay.example',
        tenantId: 'abc',
        password: 'tmex-test-pass',
        name: 'studio',
      },
      {
        ...(await deps({ envPath, installDir: dir })),
        envPath,
        installDir: dir,
        performRelayPasswordJoin: async (input) => ({
          relayUrl: input.relayUrl,
          tenantId: input.tenantId,
          userId: 'alice',
        }),
      }
    );
    expect(res.status).toBe(200);
    expect((await readEnvFile(envPath)).TMEX_ROLES).toBe('relay,node');
  });
});
