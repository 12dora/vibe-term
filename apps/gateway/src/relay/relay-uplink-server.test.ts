import { afterEach, describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { type RelayHarness, bootRelayHarness } from './relay-test-harness';
import { RELAY_PREAUTH_GLOBAL, RELAY_PREAUTH_PER_IP } from './relay-uplink-server';

const SAME_IP = '203.0.113.10';
const OTHER_IP = '198.51.100.8';

let harness: RelayHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function boot(): Promise<RelayHarness> {
  harness = await bootRelayHarness();
  return harness;
}

function holdUnauthed(relay: RelayHarness, ip: string) {
  const [nodeLink, relayLink] = createInMemoryLinkPair();
  relay.runtime.uplink.accept(relayLink, { observedIpv4: ip });
  return { nodeLink, relayLink };
}

describe('relay uplink pre-auth limits', () => {
  test('pre-auth caps', () => {
    expect(RELAY_PREAUTH_PER_IP).toBe(16);
    expect(RELAY_PREAUTH_GLOBAL).toBe(256);
  });

  test('one unauthenticated uplink beyond the per-IP cap is closed', async () => {
    const relay = await boot();
    const held = Array.from({ length: RELAY_PREAUTH_PER_IP }, () => holdUnauthed(relay, SAME_IP));
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP);
    const extra = holdUnauthed(relay, SAME_IP);
    expect((await extra.relayLink.closed).reason).toBe('too-many-preauth');
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP);
    const other = holdUnauthed(relay, OTHER_IP);
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP + 1);
    extra.nodeLink.close();
    other.nodeLink.close();
    for (const row of held) row.nodeLink.close();
  });

  test('closing an unauthenticated uplink frees the per-IP slot', async () => {
    const relay = await boot();
    const held = Array.from({ length: RELAY_PREAUTH_PER_IP }, () => holdUnauthed(relay, SAME_IP));
    held[0]?.relayLink.close();
    await held[0]?.relayLink.closed;
    const next = holdUnauthed(relay, SAME_IP);
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP);
    next.nodeLink.close();
    for (const row of held) row.nodeLink.close();
  });

  test('authenticated uplink releases the pre-auth slot', async () => {
    const relay = await boot();
    const tenant = await relay.createTenant();
    const client = await tenant.connect(tenant.addNode(), { clientIp: SAME_IP });
    await client.inbox.takeOf('auth.ok');
    const held = Array.from({ length: RELAY_PREAUTH_PER_IP }, () => holdUnauthed(relay, SAME_IP));
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP + 1);
    const extra = holdUnauthed(relay, SAME_IP);
    expect((await extra.relayLink.closed).reason).toBe('too-many-preauth');
    extra.nodeLink.close();
    for (const row of held) row.nodeLink.close();
    client.close();
  });

  test('accept({ preauthReserved: true }) does not take a second slot', async () => {
    const relay = await boot();
    expect(relay.runtime.uplink.reservePreauth(SAME_IP)).toBe(true);
    const [nodeLink, relayLink] = createInMemoryLinkPair();
    relay.runtime.uplink.accept(relayLink, {
      observedIpv4: SAME_IP,
      preauthReserved: true,
    });
    const held = Array.from({ length: RELAY_PREAUTH_PER_IP - 1 }, () =>
      holdUnauthed(relay, SAME_IP)
    );
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP);
    const extra = holdUnauthed(relay, SAME_IP);
    expect((await extra.relayLink.closed).reason).toBe('too-many-preauth');
    extra.nodeLink.close();
    nodeLink.close();
    for (const row of held) row.nodeLink.close();
  });

  test('reservePreauth refuses beyond the per-IP cap and releasePreauthReservation frees it', async () => {
    const relay = await boot();
    const uplink = relay.runtime.uplink;
    for (let i = 0; i < RELAY_PREAUTH_PER_IP; i++)
      expect(uplink.reservePreauth(SAME_IP)).toBe(true);
    expect(uplink.reservePreauth(SAME_IP)).toBe(false);
    uplink.releasePreauthReservation(SAME_IP);
    expect(uplink.reservePreauth(SAME_IP)).toBe(true);
  });

  test('an uplink without a client key is held against the global cap only', async () => {
    const relay = await boot();
    const held = Array.from({ length: RELAY_PREAUTH_PER_IP + 2 }, () => {
      const [nodeLink, relayLink] = createInMemoryLinkPair();
      relay.runtime.uplink.accept(relayLink, {});
      return { nodeLink, relayLink };
    });
    expect(relay.runtime.uplink.openSocketCount()).toBe(RELAY_PREAUTH_PER_IP + 2);
    for (const row of held) row.nodeLink.close();
  });
});
