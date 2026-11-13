import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes, rootKeyFromSeed } from '@vibeterm/shared/auth';
import { signRelayEnrollProof } from '@vibeterm/shared/relay';
import { RELAY_TEST_PUBLIC_URL, type RelayHarness, bootRelayHarness } from './relay-test-harness';
import { RELAY_DEFAULT_MAX_TENANTS } from './types';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function enroll(relay: RelayHarness, password?: string): Promise<Response> {
  const root = rootKeyFromSeed(randomBytes(32));
  const proof = signRelayEnrollProof(root, {
    relayHost: new URL(RELAY_TEST_PUBLIC_URL).host,
    ts: relay.now(),
  });
  return relay.fetch('/api/relay/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(password === undefined ? {} : { password }),
      root_public_key: encodeBase64url(root.publicKey),
      root_epoch: 0,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
}

describe('relay enroll password KDF gate', () => {
  test('同一来源已有一次口令校验在算时，新的请求立即 429，不排队', async () => {
    harness = await bootRelayHarness({ password: 'relay-pass-1', clientIp: () => '203.0.113.5' });
    const relay = harness;
    const held = relay.runtime.limiter.reserveKdf('203.0.113.5');
    if (!held.ok) throw new Error('expected a slot');
    const busy = await enroll(relay, 'wrong-1');
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).not.toBeNull();
    held.done(false);
    expect((await enroll(relay, 'wrong-2')).status).toBe(401);
    expect(relay.runtime.limiter.kdfInFlightCount).toBe(0);
    expect(relay.runtime.limiter.count('203.0.113.5')).toBe(2);
  });

  test('全中继并发上限占满时，别的来源也立即 429', async () => {
    harness = await bootRelayHarness({ password: 'relay-pass-1', clientIp: () => '203.0.113.7' });
    const relay = harness;
    const slots = [
      relay.runtime.limiter.reserveKdf('198.51.100.1'),
      relay.runtime.limiter.reserveKdf('198.51.100.2'),
    ];
    expect((await enroll(relay, 'relay-pass-1')).status).toBe(429);
    for (const slot of slots) if (slot.ok) slot.done(true);
    expect((await enroll(relay, 'relay-pass-1')).status).toBe(200);
  });

  test('口令正确时清掉预记的失败', async () => {
    harness = await bootRelayHarness({ password: 'relay-pass-1', clientIp: () => '203.0.113.6' });
    const relay = harness;
    expect((await enroll(relay, 'relay-pass-1')).status).toBe(200);
    expect(relay.runtime.limiter.count('203.0.113.6')).toBe(0);
  });
});

describe('relay tenant limit default', () => {
  test('未设置 max_tenants 时按默认上限拒绝新租户', async () => {
    harness = await bootRelayHarness({ config: { defaultMaxTenants: 2 } });
    const relay = harness;
    expect((await enroll(relay)).status).toBe(200);
    expect((await enroll(relay)).status).toBe(200);
    const full = await enroll(relay);
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe(
      'RELAY_QUOTA_TENANTS'
    );
  });

  test('内置默认上限是 50', () => {
    expect(RELAY_DEFAULT_MAX_TENANTS).toBe(50);
  });
});
