import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  decodeAuthorization,
  decodeBase64url,
  encodeBase64url,
  randomBytes,
  rootKeyFromSeed,
} from '@tmex/shared/auth';
import { sealRelayPack, signRelayEnrollProof } from '@tmex/shared/relay';
import { RELAY_TEST_PUBLIC_URL, type RelayHarness, bootRelayHarness } from './relay-test-harness';

const RELAY_HOST = new URL(RELAY_TEST_PUBLIC_URL).host;

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(opts?: Parameters<typeof bootRelayHarness>[0]): Promise<RelayHarness> {
  harness = await bootRelayHarness(opts);
  return harness;
}

function enrollBody(
  relay: RelayHarness,
  root: ReturnType<typeof rootKeyFromSeed>,
  extra?: Record<string, unknown>
): string {
  const proof = signRelayEnrollProof(root, { relayHost: RELAY_HOST, ts: relay.now() });
  return JSON.stringify({
    root_public_key: encodeBase64url(root.publicKey),
    root_epoch: 0,
    proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    ...extra,
  });
}

describe('relay health', () => {
  test('is unauthenticated and reports counts', async () => {
    const relay = await boot();
    const res = await relay.fetch('/api/relay/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.version).toBe('1.1.23');
    expect(body.tenants).toBe(0);
    expect(body.nodesOnline).toBe(0);
    expect(typeof body.uptimeMs).toBe('number');
  });

  test('rejects non-GET with 405', async () => {
    const relay = await boot();
    const res = await relay.fetch('/api/relay/health', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  test('unknown /api/relay routes are 404', async () => {
    const relay = await boot();
    const res = await relay.fetch('/api/relay/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'RELAY_NOT_FOUND', message: 'RELAY_NOT_FOUND' },
    });
  });
});

describe('relay enroll', () => {
  test('issues a tenant id and token without a password', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    expect(tenant.id).toMatch(/^[0-9a-f]{32}$/);
    expect(tenant.token.length).toBeGreaterThan(20);
    expect(tenant.passwordEpoch).toBe(0);
  });

  test('re-enrolling the same root key keeps the tenant id and rotates the token', async () => {
    const relay = await boot();
    const root = rootKeyFromSeed(randomBytes(32));
    const first = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enrollBody(relay, root),
    });
    const second = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enrollBody(relay, root),
    });
    const a = (await first.json()) as { tenant_id: string; token: string };
    const b = (await second.json()) as { tenant_id: string; token: string };
    expect(b.tenant_id).toBe(a.tenant_id);
    expect(b.token).not.toBe(a.token);
  });

  test('rejects a proof signed for another relay host', async () => {
    const relay = await boot();
    const root = rootKeyFromSeed(randomBytes(32));
    const proof = signRelayEnrollProof(root, { relayHost: 'evil.example', ts: relay.now() });
    const res = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root_public_key: encodeBase64url(root.publicKey),
        root_epoch: 0,
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RELAY_BAD_PROOF');
  });

  test('rejects a stale proof', async () => {
    const relay = await boot();
    const root = rootKeyFromSeed(randomBytes(32));
    const body = enrollBody(relay, root);
    relay.advance(10 * 60 * 1000);
    const res = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  test('requires and checks the relay password, and rate-limits failures', async () => {
    const relay = await boot({ password: 'let-me-in' });
    const root = rootKeyFromSeed(randomBytes(32));
    const missing = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enrollBody(relay, root),
    });
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_PASSWORD_REQUIRED'
    );
    for (let i = 0; i < 5; i++) {
      const wrong = await relay.fetch('/api/relay/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: enrollBody(relay, root, { password: 'nope' }),
      });
      expect(wrong.status).toBe(401);
    }
    const limited = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: enrollBody(relay, root, { password: 'let-me-in' }),
    });
    expect(limited.status).toBe(429);
  });

  test('accepts the correct password', async () => {
    const relay = await boot({ password: 'let-me-in' });
    const tenant = await relay.createTenant({ password: 'let-me-in' });
    expect(tenant.id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('rejects malformed bodies', async () => {
    const relay = await boot();
    const res = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_public_key: 'zz', root_epoch: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('relay redeem', () => {
  test('rejects a missing or wrong tenant token', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const noToken = await relay.fetch(`/api/relay/tenants/${tenant.id}/enrollments/redeem`, {
      method: 'POST',
      body: '{}',
    });
    expect(noToken.status).toBe(401);
    const wrongToken = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments/redeem`,
      'not-the-token',
      { method: 'POST', body: JSON.stringify({ certificate: encodeBase64url(node.certBytes) }) }
    );
    expect(wrongToken.status).toBe(401);
  });

  test('redeems an enrollment created over the uplink and returns the key log', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await tenant.connect(first);
    await client.inbox.takeOf('auth.ok');
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    const res = await tenant.redeem(second);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant_id: string;
      relays: string[];
      key_log: unknown[];
      rtc: { stun: string[] };
    };
    expect(body.tenant_id).toBe(tenant.id);
    expect(body.relays).toEqual([RELAY_TEST_PUBLIC_URL]);
    expect(body.rtc.stun).toEqual(['stun:stun.example:3478']);
    expect(body.key_log).toEqual([]);
    const pushed = await client.inbox.takeOf('enroll.redeemed');
    expect(pushed.t === 'enroll.redeemed' && pushed.node_id).toBe(second.nodeId);
  });

  test('HTTP redeem notifies quota for the tenant', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await tenant.connect(first);
    await client.inbox.takeOf('auth.ok');
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    const notifyQuota = spyOn(relay.runtime.uplink, 'notifyQuota');
    const res = await tenant.redeem(second);
    expect(res.status).toBe(200);
    expect(notifyQuota).toHaveBeenCalledTimes(1);
    expect(notifyQuota).toHaveBeenCalledWith(tenant.id);
    notifyQuota.mockRestore();
  });

  test('exposes the stored authorization by enroll_pk so the joining node learns the uid', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await tenant.connect(first);
    await client.inbox.takeOf('auth.ok');
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    const res = await tenant.lookupEnrollment(second);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization: string;
      authorization_sig: string;
      exp: number;
      used_at: number | null;
    };
    expect(decodeAuthorization(decodeBase64url(body.authorization)).uid).toBe(tenant.uid);
    expect(decodeBase64url(body.authorization_sig)).toHaveLength(64);
    expect(typeof body.exp).toBe('number');
    expect(body.used_at).toBeNull();
    expect((await tenant.redeem(second)).status).toBe(200);
    const after = (await (await tenant.lookupEnrollment(second)).json()) as {
      used_at: number | null;
    };
    expect(typeof after.used_at).toBe('number');
  });

  test('enrollment lookup needs the tenant token and 404s for unknown keys', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    expect((await tenant.lookupEnrollment(node, 'wrong-token')).status).toBe(401);
    const missing = await tenant.lookupEnrollment(node);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_NOT_FOUND'
    );
  });

  test('another tenant cannot read an enrollment it does not own', async () => {
    const relay = await boot();
    const a = await relay.createTenant();
    const b = await relay.createTenant();
    const owner = a.addNode();
    const client = await a.connect(owner);
    await client.inbox.takeOf('auth.ok');
    const pending = a.addNode();
    await a.createEnrollment(pending, client);
    const res = await relay.tenantFetch(
      `/api/relay/tenants/${b.id}/enrollments/${encodeURIComponent(
        encodeBase64url(pending.enroll.publicKey)
      )}`,
      b.token
    );
    expect(res.status).toBe(404);
  });

  test('refuses to redeem the same enrollment twice', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await tenant.connect(first);
    await client.inbox.takeOf('auth.ok');
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    expect((await tenant.redeem(second)).status).toBe(200);
    const again = await tenant.redeem(second);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_ENROLLMENT_USED'
    );
  });

  test('enforces the node-count quota at redeem', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const client = await tenant.connect(first);
    await client.inbox.takeOf('auth.ok');
    await relay.adminFetch(`/api/relay/tenants/${tenant.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quota: { maxNodes: 1, maxStreams: 4, bandwidthBytesPerSec: null },
      }),
    });
    const second = tenant.addNode();
    await tenant.createEnrollment(second, client);
    const res = await tenant.redeem(second);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_QUOTA_NODES'
    );
  });

  test('rejects an unknown enrollment', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const node = tenant.addNode();
    const res = await tenant.redeem(node);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_ENROLLMENT_UNKNOWN'
    );
  });

  test('never leaks another tenant enrollment', async () => {
    const relay = await boot();
    const a = await relay.createTenant();
    const b = await relay.createTenant();
    const nodeA = a.addNode();
    const clientA = await a.connect(nodeA);
    await clientA.inbox.takeOf('auth.ok');
    const pending = a.addNode();
    await a.createEnrollment(pending, clientA);
    const res = await relay.tenantFetch(`/api/relay/tenants/${b.id}/enrollments/redeem`, b.token, {
      method: 'POST',
      body: JSON.stringify({
        certificate: encodeBase64url(pending.certBytes),
        cert_sig: encodeBase64url(pending.certSig),
        pop: encodeBase64url(new Uint8Array(64)),
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_ENROLLMENT_UNKNOWN'
    );
  });
});

describe('relay password pack', () => {
  async function uploadPack(
    relay: RelayHarness,
    tenant: Awaited<ReturnType<RelayHarness['createTenant']>>,
    opts?: { rootEpoch?: number; headSeq?: number; seed?: Uint8Array }
  ) {
    const kdf = {
      salt: encodeBase64url(randomBytes(16)),
      memory_kib: 8,
      iterations: 1,
      parallelism: 1,
    };
    const sealed = await sealRelayPack({
      rootSeed: opts?.seed ?? tenant.root.seed,
      tenantId: tenant.id,
      rootPublicKey: tenant.root.publicKey,
      rootEpoch: opts?.rootEpoch ?? tenant.rootEpoch(),
      plaintext: {
        log_key: randomBytes(32),
        token: randomBytes(32),
        head_seq: BigInt(opts?.headSeq ?? 0),
        head_hash: randomBytes(32),
        issued_at: BigInt(relay.now()),
      },
    });
    return relay.tenantFetch(`/api/relay/tenants/${tenant.id}/pack`, tenant.token, {
      method: 'POST',
      body: JSON.stringify({
        sealed_pack: encodeBase64url(sealed),
        kdf_params: kdf,
        root_epoch: opts?.rootEpoch ?? tenant.rootEpoch(),
        head_seq: opts?.headSeq ?? 0,
      }),
    });
  }

  test('GET kdf is unauthenticated, 404 for unknown tenant, omits pack', async () => {
    const relay = await boot();
    const missing = await relay.fetch('/api/relay/tenants/ffffffffffffffffffffffffffffffff/kdf');
    expect(missing.status).toBe(404);
    const tenant = await relay.createTenant();
    const empty = await relay.fetch(`/api/relay/tenants/${tenant.id}/kdf`);
    expect(empty.status).toBe(404);
    const uploaded = await uploadPack(relay, tenant);
    expect(uploaded.status).toBe(200);
    const kdf = await relay.fetch(`/api/relay/tenants/${tenant.id}/kdf`);
    expect(kdf.status).toBe(200);
    const body = (await kdf.json()) as Record<string, unknown>;
    expect(body.kdf_params).toBeTruthy();
    expect(body.sealed_pack).toBeUndefined();
    expect(typeof body.root_epoch).toBe('number');
    const status = await relay.adminFetch('/api/relay/status');
    const payload = (await status.json()) as { tenants: Array<Record<string, unknown>> };
    expect(payload.tenants[0]?.sealed_pack).toBeUndefined();
    expect(payload.tenants[0]?.kdf_params).toBeUndefined();
    expect(payload.tenants[0]?.kdf_params_json).toBeUndefined();
  });

  test('enroll mode join returns pack and does not rotate the token', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    await uploadPack(relay, tenant);
    const tokenBefore = tenant.token;
    const hashBefore = relay.runtime.tenants.get(tenant.id)?.tokenHash;
    const proof = signRelayEnrollProof(tenant.root, { relayHost: RELAY_HOST, ts: relay.now() });
    const res = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'join',
        tenant_id: tenant.id,
        root_public_key: encodeBase64url(tenant.root.publicKey),
        root_epoch: tenant.rootEpoch(),
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant_id: string;
      sealed_pack: string;
      token?: string;
    };
    expect(body.tenant_id).toBe(tenant.id);
    expect(typeof body.sealed_pack).toBe('string');
    expect(body.token).toBeUndefined();
    expect(relay.runtime.tenants.get(tenant.id)?.tokenHash).toBeDefined();
    const rejoinProof = signRelayEnrollProof(tenant.root, {
      relayHost: RELAY_HOST,
      ts: relay.now(),
    });
    const again = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'join',
        tenant_id: tenant.id,
        root_public_key: encodeBase64url(tenant.root.publicKey),
        root_epoch: tenant.rootEpoch(),
        proof: { bytes: encodeBase64url(rejoinProof.bytes), sig: encodeBase64url(rejoinProof.sig) },
      }),
    });
    expect(again.status).toBe(200);
    expect(tokenBefore).toBe(tenant.token);
    expect(relay.runtime.tenants.get(tenant.id)?.tokenHash).toBe(hashBefore);
  });

  test('join with the wrong root proof is 401 and leaves the token alone', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    await uploadPack(relay, tenant);
    const hashBefore = relay.runtime.tenants.get(tenant.id)?.tokenHash;
    const stranger = rootKeyFromSeed(randomBytes(32));
    const proof = signRelayEnrollProof(stranger, { relayHost: RELAY_HOST, ts: relay.now() });
    const res = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'join',
        tenant_id: tenant.id,
        root_public_key: encodeBase64url(stranger.publicKey),
        root_epoch: tenant.rootEpoch(),
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      }),
    });
    expect(res.status).toBe(401);
    expect(relay.runtime.tenants.get(tenant.id)?.tokenHash).toBe(hashBefore);
  });

  test('join on a kicked tenant is 401 without reissue', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    await uploadPack(relay, tenant);
    relay.runtime.tenants.setKicked(tenant.id, true);
    const proof = signRelayEnrollProof(tenant.root, { relayHost: RELAY_HOST, ts: relay.now() });
    const res = await relay.fetch('/api/relay/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'join',
        tenant_id: tenant.id,
        root_public_key: encodeBase64url(tenant.root.publicKey),
        root_epoch: tenant.rootEpoch(),
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_TENANT_KICKED'
    );
  });

  test('pack upload rejects a head the relay does not have and a stale root_epoch', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const ahead = await uploadPack(relay, tenant, { headSeq: 9 });
    expect(ahead.status).toBe(409);
    expect(((await ahead.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_PACK_HEAD_AHEAD'
    );
    const ok = await uploadPack(relay, tenant);
    expect(ok.status).toBe(200);
    const stale = await uploadPack(relay, tenant, { rootEpoch: tenant.rootEpoch() + 1 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_PACK_EPOCH_MISMATCH'
    );
  });
});
