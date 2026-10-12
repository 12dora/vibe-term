import { describe, expect, test } from 'bun:test';
import { t } from '../i18n';
import {
  alsoConfiguredLine,
  overlayRelayToken,
  relaysForTokenJoin,
  sameRelay,
} from './relay-store';

const TENANT_A = 'aa'.repeat(16);
const TENANT_B = 'bb'.repeat(16);
const OLD = new Uint8Array(32).fill(1);
const FRESH = new Uint8Array(32).fill(2);

describe('sameRelay', () => {
  test('compares the url exactly and the tenant case-insensitively', () => {
    const a = { url: 'https://a.example', tenantId: TENANT_A };
    expect(sameRelay(a, { ...a, tenantId: TENANT_A.toUpperCase() })).toBe(true);
    expect(sameRelay(a, { ...a, tenantId: TENANT_B })).toBe(false);
    expect(sameRelay(a, { ...a, url: 'https://b.example' })).toBe(false);
  });
});

describe('relaysForTokenJoin', () => {
  test('persists the set-relays table as is, in root-signed order', () => {
    const table = [
      { url: 'https://b.example', tenantId: TENANT_B, token: OLD, priority: 5 },
      { url: 'https://a.example', tenantId: TENANT_A, token: OLD, priority: 2 },
    ];
    const rows = relaysForTokenJoin(table, [
      { url: 'https://a.example', tenantId: TENANT_A, token: FRESH },
    ]);
    expect(rows).toEqual([table[1], table[0]]);
  });

  test('falls back to the r3 entries when the table is missing or empty', () => {
    const entries = [
      { url: 'https://a.example', tenantId: TENANT_A, token: FRESH },
      { url: 'https://b.example', tenantId: TENANT_B, token: FRESH },
    ];
    const expected = entries.map((entry, priority) => ({ ...entry, priority }));
    expect(relaysForTokenJoin(undefined, entries)).toEqual(expected);
    expect(relaysForTokenJoin([], entries)).toEqual(expected);
  });

  test('never emits two rows for one url', () => {
    const rows = relaysForTokenJoin(
      [
        { url: 'https://a.example', tenantId: TENANT_A, token: OLD, priority: 0 },
        { url: 'https://a.example', tenantId: TENANT_B, token: FRESH, priority: 1 },
      ],
      []
    );
    expect(rows.map((row) => [row.url, row.tenantId])).toEqual([['https://a.example', TENANT_A]]);
    const fallback = relaysForTokenJoin(undefined, [
      { url: 'https://a.example', tenantId: TENANT_A, token: OLD },
      { url: 'https://a.example', tenantId: TENANT_B, token: FRESH },
    ]);
    expect(fallback).toHaveLength(1);
  });
});

describe('overlayRelayToken', () => {
  test('keeps the table order and replaces the token of the joined relay only', () => {
    const rows = overlayRelayToken(
      [
        { url: 'https://b.example', tenantId: TENANT_B, token: OLD, priority: 5 },
        { url: 'https://a.example', tenantId: TENANT_A, token: OLD, priority: 2 },
      ],
      { url: 'https://a.example', tenantId: TENANT_A.toUpperCase(), token: FRESH }
    );
    expect(rows?.map((row) => [row.url, row.priority])).toEqual([
      ['https://a.example', 2],
      ['https://b.example', 5],
    ]);
    expect(rows?.[0]?.token).toBe(FRESH);
    expect(rows?.[1]?.token).toBe(OLD);
  });

  test('returns null when the joined relay is not listed, including a tenant mismatch', () => {
    const table = [{ url: 'https://a.example', tenantId: TENANT_A, token: OLD, priority: 0 }];
    expect(
      overlayRelayToken(table, { url: 'https://b.example', tenantId: TENANT_B, token: FRESH })
    ).toBeNull();
    expect(
      overlayRelayToken(table, { url: 'https://a.example', tenantId: TENANT_B, token: FRESH })
    ).toBeNull();
    expect(
      overlayRelayToken(undefined, { url: 'https://a.example', tenantId: TENANT_A, token: FRESH })
    ).toBeNull();
  });
});

describe('alsoConfiguredLine', () => {
  test('lists the relays other than the one used', () => {
    expect(
      alsoConfiguredLine('https://a.example', ['https://a.example', 'https://b.example'])
    ).toBe(t('relay.join.alsoConfigured', { urls: 'https://b.example' }));
  });

  test('is empty when only the used relay is configured', () => {
    expect(alsoConfiguredLine('https://a.example', ['https://a.example'])).toBeNull();
  });
});
