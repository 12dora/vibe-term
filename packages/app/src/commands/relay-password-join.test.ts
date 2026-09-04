import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  deriveSeed,
  encodeBase64url,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { kdfParamsToWire, sealRelayPack } from '../../../shared/src/relay';
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

  test('maps a missing pack / unknown tenant into relay_tenant_unknown', async () => {
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
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'relay_tenant_unknown' });
  });

  test('rejects an invalid relay url', async () => {
    const auth = await openAuth();
    await expect(
      performRelayPasswordJoin(
        { relayUrl: 'not-a-url', tenantId: TENANT_ID, password: PASSWORD },
        { auth }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'invalid_url' });
  });

  test('zeros pack secrets when a failure is injected after unpack', async () => {
    const auth = await openAuth();
    const kdf = {
      salt: new Uint8Array(16).fill(3),
      memory_kib: 8,
      iterations: 1,
      parallelism: 1,
    };
    const seed = await deriveSeed(PASSWORD, kdf);
    const root = rootKeyFromSeed(seed);
    const logKey = randomBytes(32);
    const token = randomBytes(32);
    const sealed = await sealRelayPack({
      rootSeed: root.seed,
      tenantId: TENANT_ID,
      rootPublicKey: root.publicKey,
      rootEpoch: 0,
      plaintext: {
        log_key: new Uint8Array(logKey),
        token: new Uint8Array(token),
        head_seq: 1n,
        head_hash: randomBytes(32),
        issued_at: 1n,
      },
    });
    const fetcher: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/kdf')) {
        return Response.json({ kdf_params: kdfParamsToWire(kdf), root_epoch: 0 });
      }
      if (url.includes('/enroll')) {
        return Response.json({
          sealed_pack: encodeBase64url(sealed),
          kdf_params: kdfParamsToWire(kdf),
          root_epoch: 0,
        });
      }
      return new Response('nope', { status: 404 });
    };
    let captured: { log_key: Uint8Array; token: Uint8Array; seed: Uint8Array } | undefined;
    await expect(
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
        {
          auth,
          fetcher,
          afterUnpack: (pack) => {
            captured = {
              log_key: pack.pack.log_key,
              token: pack.pack.token,
              seed: pack.rootKey.seed,
            };
            throw new Error('injected after unpack');
          },
        }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'join_failed' });
    expect(captured).toBeDefined();
    expect(captured?.log_key.every((byte) => byte === 0)).toBe(true);
    expect(captured?.token.every((byte) => byte === 0)).toBe(true);
    expect(captured?.seed.every((byte) => byte === 0)).toBe(true);
    expect(auth.userStore.listUsers()).toHaveLength(0);
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
