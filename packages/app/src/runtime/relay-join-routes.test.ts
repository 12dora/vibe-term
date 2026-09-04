import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile } from '../lib/env-file';
import type { LocalAuthContext } from '../lib/local-auth';
import { RelayPasswordJoinError } from '../lib/relay-password-join-flow';
import { mapError } from './http';
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

const JOIN_BODY = {
  relayUrl: 'https://relay.example',
  tenantId: 'abc',
  password: 'tmex-test-pass',
  name: 'studio',
};

async function joinErrorResponse(code: string, message: string): Promise<Response> {
  const base = await deps();
  try {
    return await handleRelayJoinRequest(JOIN_BODY, {
      ...base,
      performRelayPasswordJoin: async () => {
        throw new RelayPasswordJoinError(code, message);
      },
    });
  } catch (error) {
    return mapError(error);
  }
}

describe('handleRelayJoinRequest error mapping', () => {
  const cases: Array<{ code: string; message: string; status: number; out: string }> = [
    {
      code: 'relay_password_invalid',
      message: 'HTTP 401 RELAY_BAD_PROOF',
      status: 401,
      out: 'relay_password_invalid',
    },
    {
      code: 'relay_tenant_unknown',
      message: 'HTTP 404 RELAY_TENANT_NOT_FOUND',
      status: 404,
      out: 'relay_tenant_unknown',
    },
    {
      code: 'relay_pack_invalid',
      message: 'pack authentication failed',
      status: 409,
      out: 'relay_pack_invalid',
    },
    {
      code: 'head_hash_mismatch',
      message: 'head mismatch',
      status: 409,
      out: 'relay_pack_invalid',
    },
    {
      code: 'relay_unreachable',
      message: 'connection refused',
      status: 502,
      out: 'relay_unreachable',
    },
    {
      code: 'local_user_exists',
      message: 'already has a mesh user',
      status: 409,
      out: 'local_user_exists',
    },
    {
      code: 'relay_not_authorized',
      message: '该中继不在根签名的中继列表里',
      status: 403,
      out: 'relay_not_authorized',
    },
    { code: 'join_failed', message: 'key log rejected', status: 400, out: 'join_failed' },
    { code: 'invalid_url', message: 'bad url', status: 400, out: 'join_failed' },
  ];

  for (const row of cases) {
    test(`${row.code} → HTTP ${row.status} ${row.out}`, async () => {
      const res = await joinErrorResponse(row.code, row.message);
      expect(res.status).toBe(row.status);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(row.out);
      expect(body.error.message).toBe(row.message);
    });
  }
});
