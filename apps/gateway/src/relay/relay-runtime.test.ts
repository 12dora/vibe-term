import { afterEach, describe, expect, test } from 'bun:test';
import { RELAY_TEST_PUBLIC_URL, type RelayHarness, bootRelayHarness } from './relay-test-harness';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('RelayRuntime.snapshotForLocalStatus', () => {
  test('returns publicUrl, password flag, tenant and node counts without secrets', async () => {
    harness = await bootRelayHarness({ password: 'admit-pass' });
    const empty = harness.runtime.snapshotForLocalStatus();
    expect(empty).toEqual({
      publicUrl: RELAY_TEST_PUBLIC_URL,
      hasPassword: true,
      tenantCount: 0,
      nodesOnline: 0,
      currentNodes: 0,
    });
    expect(JSON.stringify(empty)).not.toContain('admit-pass');

    const tenant = await harness.createTenant({ password: 'admit-pass' });
    const node = tenant.addNode();
    const client = await tenant.connect(node);
    await client.inbox.takeOf('auth.ok');

    const live = harness.runtime.snapshotForLocalStatus();
    expect(live.tenantCount).toBe(1);
    expect(live.nodesOnline).toBe(1);
    expect(live.currentNodes).toBe(1);
    expect(live.hasPassword).toBe(true);
    expect(live.publicUrl).toBe(RELAY_TEST_PUBLIC_URL);
  });
});
