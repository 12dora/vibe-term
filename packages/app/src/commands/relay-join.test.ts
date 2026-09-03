import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { MeshRelayStore } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  createEnrollment,
  decodeCertificate,
  encodeBase64url,
  hexToBytes,
  randomBytes,
} from '../../../shared/src/auth';
import { encodeRelayJoinToken, generateTenantKey, sealEnvelope } from '../../../shared/src/relay';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { deriveRootKey } from '../lib/password';
import { encodeRelayKeyLogPlaintext } from '../lib/relay-keylog';
import { readRelayUplink } from '../lib/relay-store';
import { runHubJoin, runHubUserAdd } from './hub';
import { RELAY_ENROLLMENT_LOOKUP_MISSING, orderRelayUrls, runRelayJoin } from './relay-join';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const PASSWORD = 'relay-join-password';
const RELAY_A = 'https://relay-a.example';
const RELAY_B = 'https://relay-b.example';
const TENANT_ID = 'ab'.repeat(16);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function openAuth(username?: string): Promise<LocalAuthContext> {
  const auth = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: { TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '', TMEX_ROLES: 'node' },
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

type Tenant = {
  token: string;
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  logKey: Uint8Array;
  keyLog: { seq: number; bytes: Uint8Array; sig: Uint8Array }[];
  userId: string;
  rootPublicKey: Uint8Array;
  keyLogHeadHash: Uint8Array;
};

/** 建一个真租户：genesis + 自承认，再签一张 enrollment，供 r3 串使用。 */
async function makeTenant(relayUrls: string[]): Promise<Tenant> {
  const auth = await openAuth('tina');
  const user = auth.userStore.getByUsername('tina');
  if (!user) throw new Error('missing tina');
  const rootKey = await deriveRootKey(PASSWORD, kdfParamsFromJson(user.kdfParamsJson));
  const enrollment = await createEnrollment(rootKey, {
    uid: user.id,
    rootEpoch: user.rootEpoch,
    now: Date.now(),
    ttlMs: 600_000,
  });
  const keyLog = auth.keyLogStore
    .list(user.id)
    .map((row) => ({ seq: row.seq, bytes: row.bytes, sig: row.sig }));
  return {
    token: encodeBase64url(randomBytes(32)),
    enrollPk: enrollment.enrollPk,
    authorizationBytes: enrollment.authorizationBytes,
    authorizationSig: enrollment.authorizationSig,
    logKey: generateTenantKey(),
    keyLog,
    userId: user.id,
    rootPublicKey: user.rootPublicKey,
    keyLogHeadHash: user.keyLogHeadHash,
    enrollSk: enrollment.enrollSk,
    relayUrls,
  } as Tenant & { enrollSk: Uint8Array; relayUrls: string[] };
}

function joinTokenFor(tenant: Tenant & { enrollSk: Uint8Array; relayUrls: string[] }): string {
  return encodeRelayJoinToken({
    enrollSk: tenant.enrollSk,
    rootPublicKey: tenant.rootPublicKey,
    keyLogHeadHash: tenant.keyLogHeadHash,
    logKey: tenant.logKey,
    tenantId: TENANT_ID,
    token: Uint8Array.from(
      Buffer.from(tenant.token.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    ),
    relayUrls: tenant.relayUrls,
  });
}

type RelayOptions = {
  lookupStatus?: number;
  redeemStatus?: number;
  failFirstRelay?: boolean;
  keyLogOverride?: { seq: number; bytes: Uint8Array; sig: Uint8Array }[];
};

function fakeRelay(tenant: Tenant, options: RelayOptions = {}) {
  const calls: { origin: string; path: string; method: string }[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ origin: url.origin, path: url.pathname, method: init?.method ?? 'GET' });
    if (options.failFirstRelay && url.origin === RELAY_A) {
      throw new TypeError('Unable to connect');
    }
    if (url.pathname.endsWith('/enrollments/redeem')) {
      if (options.redeemStatus) {
        return new Response(JSON.stringify({ error: { code: 'RELAY_ENROLLMENT_USED' } }), {
          status: options.redeemStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      const source = options.keyLogOverride ?? tenant.keyLog;
      const keyLog = await Promise.all(
        source.map(async (row) => ({
          seq: row.seq,
          blob: await sealEnvelope(
            tenant.logKey,
            'keylog',
            encodeRelayKeyLogPlaintext({ bytes: row.bytes, sig: row.sig })
          ),
        }))
      );
      return new Response(
        JSON.stringify({
          tenant_id: TENANT_ID,
          relays: [url.origin],
          rtc: { stun: [], turn: null },
          key_log: keyLog,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname.includes('/enrollments/')) {
      if (options.lookupStatus) {
        return new Response(JSON.stringify({ error: { code: 'RELAY_NOT_FOUND' } }), {
          status: options.lookupStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          authorization: encodeBase64url(tenant.authorizationBytes),
          authorization_sig: encodeBase64url(tenant.authorizationSig),
          exp: Date.now() + 600_000,
          used_at: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe('orderRelayUrls', () => {
  const decoded = { relayUrls: [RELAY_A, RELAY_B] } as never;

  test('keeps the token order when no url is given', () => {
    expect(orderRelayUrls(decoded, '')).toEqual([RELAY_A, RELAY_B]);
  });

  test('moves the requested relay to the front', () => {
    expect(orderRelayUrls(decoded, `${RELAY_B}/`)).toEqual([RELAY_B, RELAY_A]);
  });

  test('refuses a url that is not in the token', () => {
    expect(() => orderRelayUrls(decoded, 'https://other.example')).toThrow('not listed');
  });
});

describe('hub join with an r3 token', () => {
  test('redeems, verifies the chain and switches the node to the relay uplink', async () => {
    const tenant = (await makeTenant([RELAY_A])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const token = joinTokenFor(tenant);
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant);
    const logs: string[] = [];
    const result = await runRelayJoin(
      parseArgs(['hub', 'join', '--token', token, '--name', 'laptop']),
      '',
      token,
      { auth: joiner, fetcher, skipRestart: true, log: (line) => logs.push(line) }
    );

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.relayUrl).toBe(RELAY_A);
    expect(result.userId).toBe(tenant.userId);
    expect(result.admitted).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1].path).toBe(`/api/relay/tenants/${TENANT_ID}/enrollments/redeem`);

    const committed = joiner.userStore.getById(tenant.userId);
    expect(committed?.rootPublicKey).toEqual(tenant.rootPublicKey);
    expect(joiner.keyLogStore.list(tenant.userId)).toHaveLength(tenant.keyLog.length);

    const uplink = readRelayUplink(joiner);
    expect(uplink.kind).toBe('relay');
    expect(uplink.name).toBe('laptop');
    expect(uplink.relays).toEqual([
      { url: RELAY_A, tenantId: TENANT_ID, priority: 0, kicked: false },
    ]);

    const store = new MeshRelayStore(joiner.db);
    expect(await store.getSecret('log', 0)).toEqual(tenant.logKey);
    const stored = await store.getRelay(RELAY_A);
    expect(encodeBase64url(stored?.token ?? new Uint8Array())).toBe(tenant.token);
    expect(logs[0]).toContain('joined relay');
  });

  test('the node identity keeps no hub url and carries the joined certificate', async () => {
    const tenant = (await makeTenant([RELAY_A])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const { fetcher } = fakeRelay(tenant);
    await runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    const identity = await joiner.identityStore.load();
    expect(identity?.hubUrl).toBeNull();
    expect(identity?.userId).toBe(tenant.userId);
    const cert = JSON.parse(identity?.certificateJson ?? '{}') as { certificate?: string };
    const decoded = decodeCertificate(
      Uint8Array.from(
        Buffer.from((cert.certificate ?? '').replaceAll('-', '+').replaceAll('_', '/'), 'base64')
      )
    );
    expect(decoded.uid).toBe(tenant.userId);
    expect(Buffer.from(decoded.node_id).toString('hex')).toBe(
      Buffer.from(hexToBytes(identity?.nodeId ?? '')).toString('hex')
    );
  });

  test('falls over to the next relay in the token when the first is unreachable', async () => {
    const tenant = (await makeTenant([RELAY_A, RELAY_B])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, { failFirstRelay: true });
    const result = await runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    expect(result.relayUrl).toBe(RELAY_B);
    expect(calls[0].origin).toBe(RELAY_A);
    expect(calls.at(-1)?.origin).toBe(RELAY_B);
    expect(readRelayUplink(joiner).relays.map((row) => row.url)).toEqual([RELAY_A, RELAY_B]);
  });

  test('a relay without the enrollment lookup route names the missing route', async () => {
    const tenant = (await makeTenant([RELAY_A])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const { fetcher } = fakeRelay(tenant, { lookupStatus: 404 });
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
        auth: joiner,
        fetcher,
        skipRestart: true,
      })
    ).rejects.toThrow(RELAY_ENROLLMENT_LOOKUP_MISSING);
  });

  test('a redeem rejection is not retried and leaves the node on its old uplink', async () => {
    const tenant = (await makeTenant([RELAY_A, RELAY_B])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, { redeemStatus: 400 });
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
        auth: joiner,
        fetcher,
        skipRestart: true,
      })
    ).rejects.toThrow('RELAY_ENROLLMENT_USED');
    expect(calls.filter((call) => call.path.endsWith('/redeem'))).toHaveLength(1);
    expect(readRelayUplink(joiner).kind).toBe('hub');
  });

  test('a key log that does not match the token head hash is rejected', async () => {
    const tenant = (await makeTenant([RELAY_A])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const truncated = tenant.keyLog.slice(0, tenant.keyLog.length - 1);
    const { fetcher } = fakeRelay(tenant, { keyLogOverride: truncated });
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
        auth: joiner,
        fetcher,
        skipRestart: true,
      })
    ).rejects.toThrow('key log rejected');
    expect(readRelayUplink(joiner).kind).toBe('hub');
  });

  test('a blob sealed with a different K_log cannot be opened', async () => {
    const tenant = (await makeTenant([RELAY_A])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const wrongKeyTenant = { ...tenant, logKey: generateTenantKey() };
    const { fetcher } = fakeRelay(wrongKeyTenant);
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
        auth: joiner,
        fetcher,
        skipRestart: true,
      })
    ).rejects.toThrow('relay join failed');
  });

  test('a malformed r3 token is refused before any request', async () => {
    const joiner = await openAuth();
    let called = false;
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', 'r3.not-base64url!!', {
        auth: joiner,
        fetcher: (async () => {
          called = true;
          return new Response('{}');
        }) as unknown as typeof fetch,
        skipRestart: true,
      })
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('hub join dispatch', () => {
  test('an r3 token reaches the relay path without needing a url or TMEX_HUB_URL', async () => {
    const tenant = (await makeTenant([RELAY_A])) as Tenant & {
      enrollSk: Uint8Array;
      relayUrls: string[];
    };
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant);
    const token = joinTokenFor(tenant);
    const joined = await runHubJoin(parseArgs(['hub', 'join', '--token', token]), '', {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    expect(joined.hubUrl).toBe(RELAY_A);
    expect(joined.userId).toBe(tenant.userId);
    expect(calls.some((call) => call.path.endsWith('/redeem'))).toBe(true);
    expect(readRelayUplink(joiner).kind).toBe('relay');
  });

  test('a hub token still requires the url', async () => {
    const joiner = await openAuth();
    await expect(
      runHubJoin(parseArgs(['hub', 'join', '--token', 'AAAA']), '', { auth: joiner })
    ).rejects.toThrow('hub join requires <https-url>');
  });
});
