import { describe, expect, test } from 'bun:test';
import { resolveTurnExternalIp, usableTurnIpv4 } from './relay-turn-resolve';

describe('usableTurnIpv4', () => {
  test('rejects fake-IP 198.18/15 and non-IPv4', () => {
    expect(usableTurnIpv4('203.0.113.9')).toBe('203.0.113.9');
    expect(usableTurnIpv4('198.18.0.1')).toBeNull();
    expect(usableTurnIpv4('198.19.1.2')).toBeNull();
    expect(usableTurnIpv4('2001:db8::1')).toBeNull();
    expect(usableTurnIpv4('relay.example')).toBeNull();
  });
});

describe('resolveTurnExternalIp order', () => {
  test('uses override, then DNS, then STUN mapped IPv4', async () => {
    const override = await resolveTurnExternalIp({
      overrideIp: '203.0.113.1',
      advertisedHost: 'relay.example',
      resolveHost: async () => '203.0.113.2',
      probeStun: async () => ({ ok: true, mappedAddress: '203.0.113.3:9' }),
    });
    expect(override).toEqual({ ip: '203.0.113.1', via: 'override', error: null });

    const dns = await resolveTurnExternalIp({
      overrideIp: '198.18.0.1',
      advertisedHost: 'relay.example',
      resolveHost: async () => '203.0.113.2',
      probeStun: async () => ({ ok: true, mappedAddress: '203.0.113.3:9' }),
    });
    expect(dns).toEqual({ ip: '203.0.113.2', via: 'dns', error: null });

    const stun = await resolveTurnExternalIp({
      overrideIp: null,
      advertisedHost: 'relay.example',
      resolveHost: async () => '198.18.1.1',
      probeStun: async () => ({ ok: true, mappedAddress: '198.51.100.7:40000' }),
    });
    expect(stun).toEqual({ ip: '198.51.100.7', via: 'stun', error: null });
  });

  test('errors when every source is unusable', async () => {
    const result = await resolveTurnExternalIp({
      overrideIp: null,
      advertisedHost: 'relay.example',
      resolveHost: async () => null,
      probeStun: async () => ({ ok: false }),
      stunServers: ['stun:example:3478'],
    });
    expect(result.ip).toBeNull();
    expect(result.via).toBeNull();
    expect(result.error).toContain('unable to resolve TURN external IPv4');
  });
});
