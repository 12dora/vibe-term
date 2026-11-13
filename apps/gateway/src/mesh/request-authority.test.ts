import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { meshRelays } from '../db/schema';
import { canonicalOrigin } from './auth-passkey-origin';
import { defaultEntryOrigins } from './auth-passkey-origin-entry';
import { ownMdnsName } from './domain-access-policy';
import { authorityAllowed, requestAuthority, serverEntryOrigins } from './request-authority';

const JOINED_RELAY = 'https://relay.example.com';

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  getDb().delete(meshRelays).run();
});

describe('authorityAllowed', () => {
  const configured = () => ['vt.example.com', 'alt.example.com:8443'];

  test('IP literals, localhost names and the own mDNS name are local', () => {
    for (const host of [
      '127.0.0.1:9883',
      '[::1]:9883',
      '192.168.1.20',
      'localhost',
      'a.localhost',
    ]) {
      expect(authorityAllowed(host, configured)).toBe(true);
    }
    expect(authorityAllowed(`${ownMdnsName()}:9883`, configured)).toBe(true);
  });

  test('other .local names and unknown domains are not', () => {
    expect(authorityAllowed('other-box.local:9883', configured)).toBe(false);
    expect(authorityAllowed('attacker.example', configured)).toBe(false);
    expect(authorityAllowed('', configured)).toBe(false);
  });

  test('configured hosts match by hostname or exact host:port', () => {
    expect(authorityAllowed('vt.example.com:9443', configured)).toBe(true);
    expect(authorityAllowed('alt.example.com:8443', configured)).toBe(true);
    expect(authorityAllowed('alt.example.com', configured)).toBe(false);
  });
});

describe('requestAuthority', () => {
  test('prefers the raw Host header and falls back to the URL', () => {
    expect(requestAuthority(new Request('http://localhost:9883/x'))).toBe('localhost:9883');
    const withHost = new Request('http://localhost:9883/x', {
      headers: { host: 'attacker.example:9883' },
    });
    expect(requestAuthority(withHost)).toBe('attacker.example:9883');
  });
});

describe('serverEntryOrigins', () => {
  test('joined relays are passkey origins but not entry origins of this instance', () => {
    getDb()
      .insert(meshRelays)
      .values({
        url: JOINED_RELAY,
        tenantId: 'aa'.repeat(16),
        tokenEnc: 'x',
        priority: 0,
        updatedAt: 1,
      })
      .run();
    const canon = (list: Array<string | null>) => list.map((o) => canonicalOrigin(o));
    expect(canon(defaultEntryOrigins())).toContain(canonicalOrigin(JOINED_RELAY));
    expect(canon(serverEntryOrigins())).not.toContain(canonicalOrigin(JOINED_RELAY));
  });
});
