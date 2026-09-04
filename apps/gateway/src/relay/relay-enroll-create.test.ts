import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import { type RelayHarness, bootRelayHarness } from './relay-test-harness';
import { RELAY_ENROLL_CREATE_LIMIT, RELAY_MAX_UNUSED_ENROLLMENTS } from './types';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(): Promise<RelayHarness> {
  harness = await bootRelayHarness();
  return harness;
}

function enrollCreateBody(
  relay: RelayHarness,
  node: {
    enroll: { publicKey: Uint8Array };
    authorizationBytes: Uint8Array;
    authorizationSig: Uint8Array;
  },
  id: string,
  extra?: Record<string, unknown>
): string {
  return JSON.stringify({
    id,
    enroll_pk: encodeBase64url(node.enroll.publicKey),
    authorization: encodeBase64url(node.authorizationBytes),
    authorization_sig: encodeBase64url(node.authorizationSig),
    exp: relay.now() + 300_000,
    ...extra,
  });
}

describe('POST /api/relay/tenants/:id/enrollments', () => {
  test('accepts a well-formed enrollment and is idempotent for the same payload', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const joiner = tenant.addNode();
    const body = enrollCreateBody(relay, joiner, 'enr-1');
    const first = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments`,
      tenant.token,
      { method: 'POST', body }
    );
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true });
    const stored = relay.runtime.tenants.getEnrollmentById('enr-1');
    expect(stored?.tenantId).toBe(tenant.id);
    expect(stored?.enrollPk).toEqual(joiner.enroll.publicKey);

    const again = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments`,
      tenant.token,
      { method: 'POST', body }
    );
    expect(again.status).toBe(201);
    expect(relay.runtime.tenants.countUnusedEnrollments(tenant.id, relay.now())).toBe(1);
  });

  test('same id with a different payload is 409 RELAY_ENROLLMENT_CONFLICT', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const first = tenant.addNode();
    const second = tenant.addNode();
    const created = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments`,
      tenant.token,
      { method: 'POST', body: enrollCreateBody(relay, first, 'enr-dup') }
    );
    expect(created.status).toBe(201);
    const conflict = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments`,
      tenant.token,
      { method: 'POST', body: enrollCreateBody(relay, second, 'enr-dup') }
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_ENROLLMENT_CONFLICT'
    );
  });

  test('rejects a missing or wrong tenant token', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const joiner = tenant.addNode();
    const body = enrollCreateBody(relay, joiner, 'enr-auth');
    const noToken = await relay.fetch(`/api/relay/tenants/${tenant.id}/enrollments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(noToken.status).toBe(401);
    expect(((await noToken.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_UNAUTHORIZED'
    );
    const wrong = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments`,
      'not-the-token',
      { method: 'POST', body }
    );
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_TOKEN_INVALID'
    );
  });

  test('unused enrollment quota is per-tenant', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    for (let i = 0; i < RELAY_MAX_UNUSED_ENROLLMENTS; i++) {
      relay.runtime.tenants.createEnrollment({
        id: `seed-${i}`,
        tenantId: tenant.id,
        enrollPk: randomBytes(32),
        authorizationBytes: new Uint8Array(8),
        authorizationSig: new Uint8Array(64),
        expiresAt: relay.now() + 600_000,
        now: relay.now(),
      });
    }
    const joiner = tenant.addNode();
    const res = await relay.tenantFetch(
      `/api/relay/tenants/${tenant.id}/enrollments`,
      tenant.token,
      { method: 'POST', body: enrollCreateBody(relay, joiner, 'over-quota') }
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ENROLLMENT_QUOTA');
  });

  test('create rate limit is 16 per 60s', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    let limited = 0;
    for (let i = 0; i < RELAY_ENROLL_CREATE_LIMIT + 2; i++) {
      const joiner = tenant.addNode();
      const res = await relay.tenantFetch(
        `/api/relay/tenants/${tenant.id}/enrollments`,
        tenant.token,
        { method: 'POST', body: enrollCreateBody(relay, joiner, `rate-${i}`) }
      );
      if (res.status === 429) {
        limited += 1;
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          'ENROLLMENT_RATE_LIMITED'
        );
      }
    }
    expect(limited).toBe(2);
  });
});
