import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import { MeshRelayStore } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import {
  encodePasskeyAssertionSig,
  makeVerifyPasskeyAssertion,
  verifyRegistration,
} from '../../../../apps/gateway/src/auth/passkey';
import { createEs256Authenticator } from '../../../../apps/gateway/src/auth/passkey-test-fixtures';
import {
  UserKeyService,
  kdfParamsFromJson,
} from '../../../../apps/gateway/src/auth/user-key-service';
import {
  buildKeyLogRecord,
  createEnrollment,
  decodeCertificate,
  encodeAddPasskeyPayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeMetaKeyPayload,
  hexToBytes,
  randomBytes,
  sha256,
} from '../../../shared/src/auth';
import {
  type RelayJoinTokenEntry,
  encodeRelayJoinToken,
  encodeRelayKeyLogPlaintext,
  generateTenantKey,
  sealEnvelope,
} from '../../../shared/src/relay';
import { parseArgs } from '../lib/args';
import type { FetchLike } from '../lib/fetch-like';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { deriveRootKey } from '../lib/password';
import { readRelayUplink } from '../lib/relay-store';
import { createCa, spkiFingerprint } from '../tls/cert-authority';
import { runHubJoin, runHubUserAdd } from './hub';
import {
  RELAY_ENROLLMENT_LOOKUP_MISSING,
  orderRelayEntries,
  relayJoinRoleName,
  runRelayJoin,
} from './relay-join';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const PASSWORD = 'relay-join-password';
const RELAY_A = 'https://relay-a.example';
const RELAY_B = 'https://relay-b.example';
const TENANT_A = 'ab'.repeat(16);
const TENANT_B = 'cd'.repeat(16);
const TOKEN_A = new Uint8Array(32).fill(0xa1);
const TOKEN_B = new Uint8Array(32).fill(0xb2);
const ENTRY_A: RelayJoinTokenEntry = { url: RELAY_A, tenantId: TENANT_A, token: TOKEN_A };
const ENTRY_B: RelayJoinTokenEntry = { url: RELAY_B, tenantId: TENANT_B, token: TOKEN_B };
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function openAuth(username?: string, roles = 'node'): Promise<LocalAuthContext> {
  const auth = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: { TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '', TMEX_ROLES: roles },
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

type KeyLogRow = { seq: number; bytes: Uint8Array; sig: Uint8Array };

type Tenant = {
  auth: LocalAuthContext;
  userId: string;
  rootKey: Awaited<ReturnType<typeof deriveRootKey>>;
  enrollSk: Uint8Array;
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  logKey: Uint8Array;
  keyLog: KeyLogRow[];
  rootPublicKey: Uint8Array;
  keyLogHeadHash: Uint8Array;
  entries: RelayJoinTokenEntry[];
};

function readKeyLog(auth: LocalAuthContext, userId: string): KeyLogRow[] {
  return auth.keyLogStore
    .list(userId)
    .map((row) => ({ seq: row.seq, bytes: row.bytes, sig: row.sig }));
}

/** 建一个真租户：genesis + 自承认，再签一张 enrollment，供 r3 串使用。 */
async function makeTenant(entries: RelayJoinTokenEntry[]): Promise<Tenant> {
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
  return {
    auth,
    userId: user.id,
    rootKey,
    enrollSk: enrollment.enrollSk,
    enrollPk: enrollment.enrollPk,
    authorizationBytes: enrollment.authorizationBytes,
    authorizationSig: enrollment.authorizationSig,
    logKey: generateTenantKey(),
    keyLog: readKeyLog(auth, user.id),
    rootPublicKey: user.rootPublicKey,
    keyLogHeadHash: user.keyLogHeadHash,
    entries,
  };
}

function joinTokenFor(tenant: Tenant, caFingerprint?: string): string {
  return encodeRelayJoinToken({
    enrollSk: tenant.enrollSk,
    rootPublicKey: tenant.rootPublicKey,
    keyLogHeadHash: tenant.keyLogHeadHash,
    logKey: tenant.logKey,
    relays: tenant.entries,
    ...(caFingerprint ? { caFingerprint } : {}),
  });
}

/** 加一条根签名的 `meta-key`：join 码生成之后租户继续记账的正常情形。 */
async function appendRootMetaKey(tenant: Tenant, epoch: number): Promise<void> {
  const applied = await tenant.auth.userKeys.signAndApply(tenant.userId, tenant.rootKey, {
    type: 'meta-key',
    payload: encodeMetaKeyPayload({ epoch, entries: [] }),
  });
  if (!applied.ok) throw new Error(`meta-key append failed: ${applied.error}`);
  tenant.keyLog = readKeyLog(tenant.auth, tenant.userId);
}

/** 先 `add-passkey`（根签名），再用这把 passkey 签一条 `meta-key`。 */
async function appendPasskeySignedMetaKey(tenant: Tenant): Promise<void> {
  const origin = 'https://tmex.example';
  const rpId = 'tmex.example';
  const authenticator = await createEs256Authenticator();
  const registration = await authenticator.register({
    challenge: new Uint8Array(32).fill(3),
    rpId,
    origin,
    counter: 0,
  });
  const payload = await verifyRegistration({
    response: registration,
    expectedChallenge: encodeBase64url(new Uint8Array(32).fill(3)),
    origin,
    rpId,
  });
  if (!payload) throw new Error('registration failed');
  const added = await tenant.auth.userKeys.signAndApply(tenant.userId, tenant.rootKey, {
    type: 'add-passkey',
    payload: encodeAddPasskeyPayload(payload),
  });
  if (!added.ok) throw new Error(`add-passkey failed: ${added.error}`);

  const state = tenant.auth.userKeys.currentState(tenant.userId);
  const record = buildKeyLogRecord(state.head, state.rootEpoch, {
    uid: tenant.userId,
    type: 'meta-key',
    payload: encodeMetaKeyPayload({ epoch: 1, entries: [] }),
    signer: 'passkey',
    credential_id: payload.credential_id,
  });
  const bytes = encodeKeyLogRecord(record);
  const assertion = await authenticator.assert({
    challenge: sha256(bytes),
    rpId,
    origin,
    counter: 1,
  });
  const service = new UserKeyService({
    db: tenant.auth.db,
    userStore: tenant.auth.userStore,
    keyLogStore: tenant.auth.keyLogStore,
    nodeSessionStore: tenant.auth.nodeSessionStore,
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(tenant.auth.userStore),
  });
  const applied = await service.apply(tenant.userId, {
    bytes,
    sig: encodePasskeyAssertionSig(assertion),
  });
  if (!applied.ok) throw new Error(`passkey meta-key failed: ${applied.error}`);
  tenant.keyLog = readKeyLog(tenant.auth, tenant.userId);
}

type RelayOptions = {
  lookupStatus?: number;
  redeemStatus?: number;
  failFirstRelay?: boolean;
  keyLogOverride?: KeyLogRow[];
  /** 永不返回的中继：用来验证请求超时后会 failover。 */
  hangOrigins?: string[];
  /** redeem 回一个超大响应体。 */
  oversizeRedeem?: boolean;
  caPemByOrigin?: Record<string, string>;
  /** 这些 origin 的 enrollment lookup 回 404：应换下一台。 */
  unknownEnrollmentOrigins?: string[];
};

type RelayCall = {
  origin: string;
  path: string;
  method: string;
  token: string | null;
  tls: unknown;
};

function fakeRelay(tenant: Tenant, options: RelayOptions = {}) {
  const calls: RelayCall[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({
      origin: url.origin,
      path: url.pathname,
      method: init?.method ?? 'GET',
      token: headers.get('x-tmex-relay-token'),
      tls: (init as { tls?: unknown } | undefined)?.tls,
    });
    if (options.hangOrigins?.includes(url.origin)) {
      return await new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      });
    }
    if (url.pathname === '/api/tls/ca.crt') {
      const pem = options.caPemByOrigin?.[url.origin];
      if (!pem) return new Response('no ca', { status: 404 });
      return new Response(pem, { status: 200 });
    }
    if (options.failFirstRelay && url.origin === RELAY_A) {
      throw new TypeError('Unable to connect');
    }
    // 每台中继只认自己签发的租户令牌。
    const entry = tenant.entries.find((item) => item.url === url.origin);
    if (!entry || headers.get('x-tmex-relay-token') !== encodeBase64url(entry.token)) {
      return new Response(JSON.stringify({ error: { code: 'RELAY_TOKEN_INVALID' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!url.pathname.startsWith(`/api/relay/tenants/${entry.tenantId}/`)) {
      return new Response(JSON.stringify({ error: { code: 'RELAY_TENANT_UNKNOWN' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/enrollments/redeem')) {
      if (options.redeemStatus) {
        return new Response(JSON.stringify({ error: { code: 'RELAY_ENROLLMENT_USED' } }), {
          status: options.redeemStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (options.oversizeRedeem) {
        return new Response(`{"pad":"${'x'.repeat(20 * 1024 * 1024)}"}`, {
          status: 200,
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
          tenant_id: entry.tenantId,
          relays: [url.origin],
          rtc: { stun: [], turn: null },
          key_log: keyLog,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname.includes('/enrollments/')) {
      if (options.unknownEnrollmentOrigins?.includes(url.origin)) {
        return new Response(JSON.stringify({ error: { code: 'RELAY_ENROLLMENT_UNKNOWN' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
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
  };
  return { calls, fetcher };
}

describe('orderRelayEntries', () => {
  const decoded = { relays: [ENTRY_A, ENTRY_B] } as never;

  test('keeps the token order when no url is given', () => {
    expect(orderRelayEntries(decoded, '').map((entry) => entry.url)).toEqual([RELAY_A, RELAY_B]);
  });

  test('moves the requested relay to the front, credentials included', () => {
    const ordered = orderRelayEntries(decoded, `${RELAY_B}/`);
    expect(ordered.map((entry) => entry.url)).toEqual([RELAY_B, RELAY_A]);
    expect(ordered[0].tenantId).toBe(TENANT_B);
    expect(ordered[0].token).toEqual(TOKEN_B);
  });

  test('refuses a url that is not in the token', () => {
    expect(() => orderRelayEntries(decoded, 'https://other.example')).toThrow('not listed');
  });
});

describe('relayJoinRoleName', () => {
  test('keeps the relay role and turns the hub role off', () => {
    expect(relayJoinRoleName('relay,node')).toBe('relay,node');
    expect(relayJoinRoleName('relay')).toBe('relay,node');
    expect(relayJoinRoleName('hub,node')).toBe('node');
    expect(relayJoinRoleName('node')).toBe('node');
    expect(relayJoinRoleName(undefined)).toBe('node');
    expect(relayJoinRoleName('garbage')).toBe('node');
  });
});

describe('hub join with an r3 token', () => {
  test('redeems, verifies the chain and switches the node to the relay uplink', async () => {
    const tenant = await makeTenant([ENTRY_A]);
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

    expect(result.tenantId).toBe(TENANT_A);
    expect(result.relayUrl).toBe(RELAY_A);
    expect(result.userId).toBe(tenant.userId);
    expect(result.admitted).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1].path).toBe(`/api/relay/tenants/${TENANT_A}/enrollments/redeem`);

    const committed = joiner.userStore.getById(tenant.userId);
    expect(committed?.rootPublicKey).toEqual(tenant.rootPublicKey);
    expect(joiner.keyLogStore.list(tenant.userId)).toHaveLength(tenant.keyLog.length);

    const uplink = readRelayUplink(joiner);
    expect(uplink.kind).toBe('relay');
    expect(uplink.name).toBe('laptop');
    expect(uplink.relays).toEqual([
      { url: RELAY_A, tenantId: TENANT_A, priority: 0, kicked: false },
    ]);

    const store = new MeshRelayStore(joiner.db);
    expect(await store.getSecret('log', 0)).toEqual(tenant.logKey);
    const stored = await store.getRelay(RELAY_A);
    expect(stored?.token).toEqual(TOKEN_A);
    expect(logs[0]).toContain('joined relay');
  });

  test('the node identity keeps no hub url and carries the joined certificate', async () => {
    const tenant = await makeTenant([ENTRY_A]);
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

  test('falls over to the next relay with that relay own credentials', async () => {
    const tenant = await makeTenant([ENTRY_A, ENTRY_B]);
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, { failFirstRelay: true });
    const result = await runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    expect(result.relayUrl).toBe(RELAY_B);
    expect(result.tenantId).toBe(TENANT_B);
    expect(calls[0].origin).toBe(RELAY_A);
    const onB = calls.filter((call) => call.origin === RELAY_B);
    expect(onB).toHaveLength(2);
    for (const call of onB) {
      expect(call.token).toBe(encodeBase64url(TOKEN_B));
      expect(call.path.startsWith(`/api/relay/tenants/${TENANT_B}/`)).toBe(true);
    }
    const store = new MeshRelayStore(joiner.db);
    expect((await store.getRelay(RELAY_A))?.token).toEqual(TOKEN_A);
    expect((await store.getRelay(RELAY_B))?.token).toEqual(TOKEN_B);
    expect(readRelayUplink(joiner).relays.map((row) => row.url)).toEqual([RELAY_A, RELAY_B]);
  });

  test('a request that never answers times out and fails over', async () => {
    const tenant = await makeTenant([ENTRY_A, ENTRY_B]);
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, { hangOrigins: [RELAY_A] });
    const result = await runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
      relayTimeoutMs: 25,
    });
    expect(result.relayUrl).toBe(RELAY_B);
    expect(calls[0].origin).toBe(RELAY_A);
  });

  test('an oversized redeem body is refused', async () => {
    const tenant = await makeTenant([ENTRY_A]);
    const joiner = await openAuth();
    const { fetcher } = fakeRelay(tenant, { oversizeRedeem: true });
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
        auth: joiner,
        fetcher,
        skipRestart: true,
      })
    ).rejects.toThrow('exceeds');
    expect(readRelayUplink(joiner).kind).toBe('hub');
  });

  test('lookup 404 RELAY_ENROLLMENT_UNKNOWN on the first relay continues to the next', async () => {
    const tenant = await makeTenant([ENTRY_A, ENTRY_B]);
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, { unknownEnrollmentOrigins: [RELAY_A] });
    const result = await runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    expect(result.relayUrl).toBe(RELAY_B);
    expect(result.tenantId).toBe(TENANT_B);
    expect(calls.some((call) => call.origin === RELAY_A)).toBe(true);
    expect(
      calls.some((call) => call.origin === RELAY_B && call.path.endsWith('/enrollments/redeem'))
    ).toBe(true);
  });

  test('a relay without the enrollment lookup route names the missing route', async () => {
    const tenant = await makeTenant([ENTRY_A]);
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
    const tenant = await makeTenant([ENTRY_A, ENTRY_B]);
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

  test('a key log missing the anchor record is rejected', async () => {
    const tenant = await makeTenant([ENTRY_A]);
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

  test('records appended after the join code was created are accepted', async () => {
    const tenant = await makeTenant([ENTRY_A]);
    const token = joinTokenFor(tenant);
    await appendRootMetaKey(tenant, 1);
    await appendRootMetaKey(tenant, 2);
    const joiner = await openAuth();
    const { fetcher } = fakeRelay(tenant);
    const result = await runRelayJoin(parseArgs(['hub', 'join']), '', token, {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    expect(result.userId).toBe(tenant.userId);
    expect(joiner.keyLogStore.list(tenant.userId)).toHaveLength(tenant.keyLog.length);
  });

  test('a chain carrying a passkey-signed record replays instead of unknown_signer', async () => {
    const tenant = await makeTenant([ENTRY_A]);
    const token = joinTokenFor(tenant);
    await appendPasskeySignedMetaKey(tenant);
    expect(tenant.keyLog.length).toBeGreaterThan(3);
    const joiner = await openAuth();
    const { fetcher } = fakeRelay(tenant);
    const result = await runRelayJoin(parseArgs(['hub', 'join']), '', token, {
      auth: joiner,
      fetcher,
      skipRestart: true,
      log: () => undefined,
    });
    expect(result.userId).toBe(tenant.userId);
    expect(joiner.keyLogStore.list(tenant.userId)).toHaveLength(tenant.keyLog.length);
  });

  test('a blob sealed with a different K_log cannot be opened', async () => {
    const tenant = await makeTenant([ENTRY_A]);
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
        }) as FetchLike,
        skipRestart: true,
      })
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('r3 join with a pinned CA', () => {
  test('a self-signed relay whose CA matches the fingerprint is trusted and pinned', async () => {
    const ca = await createCa({ name: 'relay-ca' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const tenant = await makeTenant([ENTRY_A]);
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, {
      caPemByOrigin: { [RELAY_A]: ca.certPem },
    });
    const result = await runRelayJoin(
      parseArgs(['hub', 'join']),
      '',
      joinTokenFor(tenant, fingerprint),
      { auth: joiner, fetcher, skipRestart: true, log: () => undefined }
    );
    expect(result.relayUrl).toBe(RELAY_A);
    // CA 必须在任何带令牌的请求之前取回。
    expect(calls[0].path).toBe('/api/tls/ca.crt');
    expect(calls[0].tls).toEqual({ rejectUnauthorized: false });
    expect(calls[0].token).toBeNull();
    for (const call of calls.slice(1)) {
      expect(call.tls).toEqual({ ca: [ca.certPem] });
    }
    const trusted = new HubTrustStore(joiner.db).get(RELAY_A);
    expect(trusted?.fingerprint).toBe(fingerprint);
    expect(await spkiFingerprint(trusted?.caPem ?? '')).toBe(fingerprint);
  });

  test('a CA that does not match the fingerprint is refused before the token is sent', async () => {
    const attacker = await createCa({ name: 'attacker' });
    const real = await createCa({ name: 'relay-ca' });
    const fingerprint = await spkiFingerprint(real.certPem);
    const tenant = await makeTenant([ENTRY_A]);
    const joiner = await openAuth();
    const { calls, fetcher } = fakeRelay(tenant, {
      caPemByOrigin: { [RELAY_A]: attacker.certPem },
    });
    await expect(
      runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant, fingerprint), {
        auth: joiner,
        fetcher,
        skipRestart: true,
      })
    ).rejects.toThrow('fingerprint');
    expect(calls.map((call) => call.path)).toEqual(['/api/tls/ca.crt']);
    expect(new HubTrustStore(joiner.db).get(RELAY_A)).toBeNull();
    expect(readRelayUplink(joiner).kind).toBe('hub');
  });
});

describe('r3 join and the local roles', () => {
  test('a relay,node host keeps its relay role', async () => {
    const previous = process.env.TMEX_ROLES;
    const tenant = await makeTenant([ENTRY_A]);
    const joiner = await openAuth(undefined, 'relay,node');
    const { fetcher } = fakeRelay(tenant);
    try {
      await runRelayJoin(parseArgs(['hub', 'join']), '', joinTokenFor(tenant), {
        auth: joiner,
        fetcher,
        skipRestart: true,
        log: () => undefined,
      });
      expect(process.env.TMEX_ROLES).toBe('relay,node');
    } finally {
      if (previous === undefined) process.env.TMEX_ROLES = undefined;
      else process.env.TMEX_ROLES = previous;
    }
  });
});

describe('hub join dispatch', () => {
  test('an r3 token reaches the relay path without needing a url or TMEX_HUB_URL', async () => {
    const tenant = await makeTenant([ENTRY_A]);
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
