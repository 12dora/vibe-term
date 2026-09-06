import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { MeshRelayStore } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import {
  deriveSeed,
  encodeBase64url,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { kdfParamsFromWire, kdfParamsToWire, sealRelayPack } from '../../../shared/src/relay';
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
      VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
      VIBETERM_ROLES: 'node',
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

/** 中继侧的最小假象：健康探针 + `/kdf` + `mode:'join'` 的密封包。 */
async function packFixture(
  kdfRaw: { salt: Uint8Array; memory_kib: number; iterations: number; parallelism: number } | null
): Promise<{ fetcher: FetchLike; token: Uint8Array; logKey: Uint8Array }> {
  const kdf = kdfRaw ?? {
    salt: new Uint8Array(16).fill(3),
    memory_kib: 8,
    iterations: 1,
    parallelism: 1,
  };
  const root = rootKeyFromSeed(await deriveSeed(PASSWORD, kdf));
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
    if (url.endsWith('/api/relay/health')) return Response.json({ ok: true });
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
  return { fetcher, token, logKey };
}

describe('performRelayPasswordJoin', () => {
  test('地址没写端口时探候选端口，探不到按 relay_unreachable 报', async () => {
    const auth = await openAuth();
    const fetcher: FetchLike = async () => new Response('nope', { status: 404 });
    await expect(
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
        { auth, fetcher, timeoutMs: 100 }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'relay_unreachable' });
  });

  test('显式 :443 只确认一次，不因归一化抹掉端口而遍历候选', async () => {
    const auth = await openAuth();
    const seen: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = new URL(String(input));
      seen.push(`${url.port || '443'}${url.pathname}`);
      return new Response('nope', { status: 404 });
    };
    await expect(
      performRelayPasswordJoin(
        { relayUrl: `${RELAY_URL}:443`, tenantId: TENANT_ID, password: PASSWORD },
        { auth, fetcher, timeoutMs: 100 }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError' });
    expect(seen.some((item) => item.startsWith('443/api/relay/health'))).toBe(false);
    expect(seen.every((item) => item.startsWith('443/'))).toBe(true);
  });

  test('探到候选端口后按带端口的地址继续接入', async () => {
    const auth = await openAuth();
    const seen: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = new URL(String(input));
      seen.push(`${url.port}${url.pathname}`);
      if (url.port === '13443' && url.pathname === '/api/relay/health') {
        return Response.json({ ok: true });
      }
      return new Response('nope', { status: 404 });
    };
    await expect(
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
        { auth, fetcher, timeoutMs: 100 }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError' });
    expect(seen.some((item) => item.startsWith('13443/api/relay/tenants/'))).toBe(true);
  });

  test('本机是别的 mesh 账户时拒绝覆盖', async () => {
    const auth = await openAuth('ivy');
    const fixture = await packFixture({
      salt: new Uint8Array(16).fill(9),
      memory_kib: 8,
      iterations: 1,
      parallelism: 1,
    });
    await expect(
      performRelayPasswordJoin(
        { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
        { auth, fetcher: fixture.fetcher }
      )
    ).rejects.toMatchObject({ name: 'RelayPasswordJoinError', code: 'local_user_exists' });
    const stored = await new MeshRelayStore(auth.db).getRelay(RELAY_URL);
    expect(stored).toBeNull();
  });

  test('同一账户：只换发中继令牌，不重建本机用户', async () => {
    const auth = await openAuth('ivy');
    const user = auth.userStore.listUsers()[0];
    if (!user) throw new Error('missing local user');
    const fixture = await packFixture(kdfParamsFromWire(JSON.parse(user.kdfParamsJson)) ?? null);
    const relayStore = new MeshRelayStore(auth.db);
    await relayStore.replaceRelays(
      [
        {
          url: RELAY_URL,
          tenantId: TENANT_ID,
          token: new Uint8Array(32).fill(1),
          priority: 0,
        },
      ],
      1
    );
    relayStore.markKicked(RELAY_URL, true, 'password_rotated');

    const result = await performRelayPasswordJoin(
      { relayUrl: RELAY_URL, tenantId: TENANT_ID, password: PASSWORD },
      { auth, fetcher: fixture.fetcher }
    );
    expect(result).toMatchObject({ userId: user.id, tenantId: TENANT_ID, rekeyed: true });
    const stored = await relayStore.getRelay(RELAY_URL);
    expect(stored?.token).toEqual(fixture.token);
    expect(stored?.kicked).toBe(false);
    expect(await relayStore.getSecret('log', 0)).toEqual(fixture.logKey);
    expect(auth.userStore.listUsers()).toHaveLength(1);
  });

  test('maps a missing pack / unknown tenant into relay_tenant_unknown', async () => {
    const auth = await openAuth();
    const fetcher: FetchLike = async (input) => {
      if (String(input).endsWith('/api/relay/health')) return Response.json({ ok: true });
      return new Response(
        JSON.stringify({ error: { code: 'RELAY_TENANT_NOT_FOUND', message: 'missing' } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }
      );
    };
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
      if (url.endsWith('/api/relay/health')) {
        return Response.json({ ok: true });
      }
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
