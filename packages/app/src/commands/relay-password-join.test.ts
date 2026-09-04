import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseArgs } from '../lib/args';
import type { FetchLike } from '../lib/fetch-like';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { performRelayPasswordJoin } from '../lib/relay-password-join';
import { runHubUserAdd } from './hub';
import { runRelayPasswordJoin } from './relay-password-join';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const PASSWORD = 'relay-password-join-pass';
const RELAY_URL = 'https://relay.example';
const TENANT_ID = 'ab'.repeat(16);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function openAuth(username?: string): Promise<LocalAuthContext> {
  const auth = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
      TMEX_ROLES: 'node',
    },
  });
  handles.push(auth);
  if (username) {
    await runHubUserAdd(parseArgs(['hub', 'user', 'add', username]), username, {
      auth,
      password: PASSWORD,
      log: () => undefined,
    });
  }
  return auth;
}

describe('performRelayPasswordJoin', () => {
  test('refuses to overwrite an existing mesh user', async () => {
    const auth = await openAuth('ivy');
    await expect(
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
        { auth }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'local_user_exists' });
  });

  test('maps a missing pack / unknown tenant into join_failed', async () => {
    const auth = await openAuth();
    const fetcher: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: { code: 'RELAY_TENANT_NOT_FOUND', message: 'missing' } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }
      );
    await expect(
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
        { auth, fetcher }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'join_failed' });
  });
});

describe('runRelayPasswordJoin', () => {
  test('requires --tenant', async () => {
    const auth = await openAuth();
    await expect(
      runRelayPasswordJoin(parseArgs(['relay', 'join', RELAY_URL]), {
        auth,
        password: PASSWORD,
        log: () => undefined,
      })
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });
});
