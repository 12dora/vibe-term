import { afterEach, describe, expect, test } from 'bun:test';
import { RELAY_TOKEN_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { type RelayHarness, bootRelayHarness } from './relay-test-harness';
import { enrollRelayRoot } from './relay-test-tenant';
import { RELAY_ENROLL_FAILURE_LIMIT } from './types';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function rotate(
  relay: RelayHarness,
  body: Record<string, unknown>,
  token?: string
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set(RELAY_TOKEN_HEADER.name, token);
  return relay.fetch('/api/relay/password/rotate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/relay/password/rotate', () => {
  test('no-password relay refuses tenant rotate with 409 relay_password_unset', async () => {
    harness = await bootRelayHarness();
    const tenant = await harness.createTenant();
    const res = await rotate(
      harness,
      { tenantId: tenant.id, current: '', next: 'new-password', mode: 'keep' },
      tenant.token
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('relay_password_unset');
    expect(body.error.message).toBe(
      'the relay has no access password; the operator sets the first one'
    );
    expect(harness.runtime.configStore.read()?.passwordHash).toBeNull();
  });

  test('wrong current is 401 relay_password_invalid', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    const res = await rotate(
      harness,
      { tenantId: tenant.id, current: 'wrong-password', next: 'new-password', mode: 'keep' },
      tenant.token
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'relay_password_invalid'
    );
  });

  test('next shorter than 8 is 400 relay_password_too_short', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    const res = await rotate(
      harness,
      { tenantId: tenant.id, current: 'correct-password', next: 'short', mode: 'keep' },
      tenant.token
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'relay_password_too_short'
    );
  });

  test('keep mode leaves minTokenEpoch and live uplinks', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    const live = await tenant.connect(tenant.addNode());
    await live.inbox.takeOf('auth.ok');
    const res = await rotate(
      harness,
      { tenantId: tenant.id, current: 'correct-password', next: 'rotated-pw', mode: 'keep' },
      tenant.token
    );
    expect(res.status).toBe(200);
    expect(harness.runtime.configStore.read()?.minTokenEpoch).toBe(0);
    expect(harness.runtime.registry.listTenant(tenant.id)).toHaveLength(1);
  });

  test('kick with offline admitted members is 409; tenant force cannot bypass', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    const live = await tenant.connect(tenant.addNode());
    await live.inbox.takeOf('auth.ok');
    live.close();
    const denied = await rotate(
      harness,
      { tenantId: tenant.id, current: 'correct-password', next: 'rotated-pw', mode: 'kick' },
      tenant.token
    );
    expect(denied.status).toBe(409);
    const deniedBody = (await denied.json()) as {
      error: { code: string; online: number; admitted: number };
    };
    expect(deniedBody.error.code).toBe('relay_members_offline');
    expect(deniedBody.error.online).toBe(0);
    expect(deniedBody.error.admitted).toBe(1);
    const forced = await rotate(
      harness,
      {
        tenantId: tenant.id,
        current: 'correct-password',
        next: 'rotated-pw',
        mode: 'kick',
        force: true,
      },
      tenant.token
    );
    expect(forced.status).toBe(409);
    expect(((await forced.json()) as { error: { code: string } }).error.code).toBe(
      'relay_members_offline'
    );
  });

  test('missing token is 401; token/tenant mismatch is 401', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    const other = await harness.createTenant({ password: 'correct-password' });
    expect(
      (
        await rotate(harness, {
          tenantId: tenant.id,
          current: 'correct-password',
          next: 'new-password',
        })
      ).status
    ).toBe(401);
    const mismatch = await rotate(
      harness,
      { tenantId: tenant.id, current: 'correct-password', next: 'new-password' },
      other.token
    );
    expect(mismatch.status).toBe(401);
  });

  test('rate-limits wrong current per source like enroll', async () => {
    harness = await bootRelayHarness({
      password: 'correct-password',
      clientIp: () => '203.0.113.9',
    });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    for (let n = 0; n < RELAY_ENROLL_FAILURE_LIMIT; n += 1) {
      const res = await rotate(
        harness,
        { tenantId: tenant.id, current: 'nope-nope', next: 'new-password' },
        tenant.token
      );
      expect(res.status).toBe(401);
    }
    const limited = await rotate(
      harness,
      { tenantId: tenant.id, current: 'correct-password', next: 'new-password' },
      tenant.token
    );
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_RATE_LIMITED'
    );
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  test('next null, empty or missing is 400 and never clears the relay password', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const tenant = await harness.createTenant({ password: 'correct-password' });
    const before = harness.runtime.configStore.read();
    expect(before?.passwordHash).toBeTruthy();
    for (const next of [{ next: null }, { next: '' }, {}]) {
      const res = await rotate(
        harness,
        { tenantId: tenant.id, current: 'correct-password', mode: 'keep', ...next },
        tenant.token
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'RELAY_INVALID_BODY'
      );
    }
    expect(harness.runtime.configStore.read()).toEqual(before);
  });

  test('kick revokes only the calling tenant and leaves other tenants untouched', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const a = await harness.createTenant({ password: 'correct-password' });
    const b = await harness.createTenant({ password: 'correct-password' });
    const aLive = await a.connect(a.addNode());
    await aLive.inbox.takeOf('auth.ok');
    const bLive = await b.connect(b.addNode());
    await bLive.inbox.takeOf('auth.ok');
    const bGone = await b.connect(b.addNode());
    await bGone.inbox.takeOf('auth.ok');
    bGone.close();
    const reissued = await enrollRelayRoot(harness, b.root, { password: 'correct-password' });
    expect(reissued.token).toBeTruthy();
    const bBefore = harness.runtime.tenants.get(b.id);
    expect(bBefore?.previousTokens?.length).toBeGreaterThan(0);
    const epochBefore = harness.runtime.configStore.read()?.passwordEpoch ?? 0;

    const res = await rotate(
      harness,
      { tenantId: a.id, current: 'correct-password', next: 'rotated-pw', mode: 'kick' },
      a.token
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passwordEpoch: number }).passwordEpoch).toBe(epochBefore + 1);
    const config = harness.runtime.configStore.read();
    expect(config?.minTokenEpoch).toBe(0);
    expect(config?.passwordEpoch).toBe(epochBefore + 1);

    const kicked = await aLive.inbox.takeOf('relay.kicked');
    expect(kicked.t === 'relay.kicked' && kicked.reason).toBe('password_rotated');
    expect(harness.runtime.tenants.get(a.id)?.kicked).toBe(true);
    expect(harness.runtime.tenants.get(a.id)?.previousTokens ?? []).toEqual([]);
    const aDenied = await rotate(
      harness,
      { tenantId: a.id, current: 'rotated-pw', next: 'another-pw', mode: 'keep' },
      a.token
    );
    expect(aDenied.status).toBe(401);

    await Bun.sleep(10);
    expect(bLive.inbox.drain().some((msg) => msg.t === 'relay.kicked')).toBe(false);
    expect(harness.runtime.registry.listTenant(b.id)).toHaveLength(1);
    const bAfter = harness.runtime.tenants.get(b.id);
    expect(bAfter?.kicked).toBe(false);
    expect(bAfter?.tokenHash).toBe(bBefore?.tokenHash ?? '');
    expect(bAfter?.tokenEpoch).toBe(bBefore?.tokenEpoch ?? -1);
    expect(bAfter?.previousTokens).toEqual(bBefore?.previousTokens);
    const bOld = await b.connect(b.addNode());
    await bOld.inbox.takeOf('auth.ok');
    const bNew = await b.connect(b.addNode(), { token: reissued.token ?? '' });
    await bNew.inbox.takeOf('auth.ok');

    const recovered = await enrollRelayRoot(harness, a.root, { password: 'rotated-pw' });
    expect(recovered.token).toBeTruthy();
    expect(harness.runtime.tenants.get(a.id)?.kicked).toBe(false);
  });

  test('kick guard counts only the calling tenant members', async () => {
    harness = await bootRelayHarness({ password: 'correct-password' });
    const a = await harness.createTenant({ password: 'correct-password' });
    const b = await harness.createTenant({ password: 'correct-password' });
    const aLive = await a.connect(a.addNode());
    await aLive.inbox.takeOf('auth.ok');
    const aGone = await a.connect(a.addNode());
    await aGone.inbox.takeOf('auth.ok');
    aGone.close();
    for (let n = 0; n < 2; n += 1) {
      const bGone = await b.connect(b.addNode());
      await bGone.inbox.takeOf('auth.ok');
      bGone.close();
    }
    const before = harness.runtime.configStore.read();
    const denied = await rotate(
      harness,
      { tenantId: a.id, current: 'correct-password', next: 'rotated-pw', mode: 'kick' },
      a.token
    );
    expect(denied.status).toBe(409);
    const body = (await denied.json()) as {
      error: { code: string; online: number; admitted: number };
    };
    expect(body.error.code).toBe('relay_members_offline');
    expect(body.error.online).toBe(1);
    expect(body.error.admitted).toBe(2);
    expect(harness.runtime.configStore.read()).toEqual(before);
    expect(harness.runtime.tenants.get(a.id)?.kicked).toBe(false);
  });
});
