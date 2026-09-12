import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RELAY_HOST_RTC_PORT_RANGE,
  DEFAULT_RTC_PORT_RANGE,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
} from '@vibeterm/shared/net';
import {
  advertisedTurnHost,
  decideTurnMode,
  describeTurnPortConflict,
  externalTurnFromConfig,
  formatTurnPortRange,
  ipv4FromMappedAddress,
  parsePortFromTurnUrl,
  turnFirewallHint,
  turnResolveHost,
} from './relay-turn-config';

describe('decideTurnMode', () => {
  test('external triple wins over a listen port', () => {
    expect(
      decideTurnMode({
        turnUrl: 'turn:ext.example:3478',
        turnUsername: 'u',
        turnCredential: 'p',
        turnPort: 3478,
      })
    ).toBe('external');
    expect(
      decideTurnMode({
        turn: { url: 'turn:ext.example:3478', username: 'u', credential: 'p' },
        turnPort: 3478,
      })
    ).toBe('external');
  });

  test('port 0/undefined is off; otherwise builtin', () => {
    expect(decideTurnMode({ turnPort: 0 })).toBe('off');
    expect(decideTurnMode({})).toBe('off');
    expect(decideTurnMode({ turnPort: DEFAULT_TURN_PORT })).toBe('builtin');
  });
});

describe('describeTurnPortConflict', () => {
  const range = { ...DEFAULT_TURN_RELAY_PORT_RANGE };

  test('detects overlap with peer port and rtc range', () => {
    expect(describeTurnPortConflict(DEFAULT_TURN_PORT, range, null, DEFAULT_TURN_PORT)).toContain(
      'VIBETERM_PEER_PORT'
    );
    expect(describeTurnPortConflict(DEFAULT_TURN_PORT, range, null, 40010)).toContain(
      'VIBETERM_PEER_PORT'
    );
    expect(
      describeTurnPortConflict(DEFAULT_TURN_PORT, range, { ...DEFAULT_RTC_PORT_RANGE }, 39001)
    ).toContain('VIBETERM_RTC_PORT_RANGE');
    expect(
      describeTurnPortConflict(DEFAULT_TURN_PORT, range, { begin: 40020, end: 40080 }, 39001)
    ).toContain('VIBETERM_RTC_PORT_RANGE');
  });

  test('returns null when ports are disjoint', () => {
    expect(
      describeTurnPortConflict(
        DEFAULT_TURN_PORT,
        range,
        { ...DEFAULT_RELAY_HOST_RTC_PORT_RANGE },
        39001
      )
    ).toBeNull();
  });
});

describe('advertisedTurnHost / helpers', () => {
  test('resolve host prefers TURN_HOST then public URL hostname', () => {
    expect(turnResolveHost('https://relay.example:8443', 'turn.example')).toBe('turn.example');
    expect(turnResolveHost('https://relay.example:8443', null)).toBe('relay.example');
  });

  test('advertised host prefers TURN_HOST then the resolved IPv4 literal', () => {
    expect(advertisedTurnHost('turn.example', '203.0.113.9')).toBe('turn.example');
    expect(advertisedTurnHost(null, '203.0.113.9')).toBe('203.0.113.9');
    expect(advertisedTurnHost('  ', '198.51.100.7')).toBe('198.51.100.7');
  });

  test('formats firewall hint and mapped IPv4', () => {
    expect(turnFirewallHint()).toContain(`UDP ${DEFAULT_TURN_PORT}`);
    expect(turnFirewallHint()).toContain('UDP 40001-40049');
    expect(formatTurnPortRange({ begin: 1, end: 2 })).toBe('1-2');
    expect(ipv4FromMappedAddress('203.0.113.9:40000')).toBe('203.0.113.9');
    expect(ipv4FromMappedAddress('[2001:db8::1]:9')).toBeNull();
    expect(parsePortFromTurnUrl('turn:relay.example:3478?transport=udp')).toBe(3478);
    expect(
      externalTurnFromConfig({
        turnUrl: 'turn:x:3478',
        turnUsername: 'u',
        turnCredential: 'p',
      })
    ).toEqual({ url: 'turn:x:3478', username: 'u', credential: 'p' });
  });
});
