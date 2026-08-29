import { describe, expect, test } from 'bun:test';
import { HubTrustStore } from './hub-trust-store';
import { createMigratedAuthDb } from './test-db';

describe('HubTrustStore', () => {
  test('0022 creates hub_trust table', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hub_trust'")
        .get();
      expect(tables).not.toBeNull();
      const columns = sqlite.query('PRAGMA table_info(hub_trust)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'hub_url',
        'ca_pem',
        'fingerprint',
        'created_at',
      ]);
    } finally {
      close();
    }
  });

  test('get/put/delete by hub URL, trailing slash normalized', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new HubTrustStore(db);
      expect(store.get('https://hub.example')).toBeNull();
      store.put({
        hubUrl: 'https://hub.example/',
        caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        fingerprint: 'ab'.repeat(32),
      });
      const row = store.get('https://hub.example');
      expect(row?.hubUrl).toBe('https://hub.example');
      expect(row?.caPem).toContain('BEGIN CERTIFICATE');
      expect(row?.fingerprint).toBe('ab'.repeat(32));
      expect(row?.createdAt).toBeGreaterThan(0);

      store.put({
        hubUrl: 'https://hub.example',
        caPem: '-----BEGIN CERTIFICATE-----\nUPDATED\n-----END CERTIFICATE-----',
        fingerprint: 'cd'.repeat(32),
      });
      expect(store.get('https://hub.example/')?.fingerprint).toBe('cd'.repeat(32));
      expect(store.get('https://hub.example/')?.caPem).toContain('UPDATED');

      store.delete('https://hub.example/');
      expect(store.get('https://hub.example')).toBeNull();
    } finally {
      close();
    }
  });

  test('put/get/delete canonicalize host, default port, and trailing slash', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new HubTrustStore(db);
      store.put({
        hubUrl: 'HTTPS://Hub.Example:443/',
        caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        fingerprint: 'ab'.repeat(32),
      });
      expect(store.get('https://hub.example')?.hubUrl).toBe('https://hub.example');
      expect(store.get('https://HUB.EXAMPLE:443/')?.fingerprint).toBe('ab'.repeat(32));
      store.delete('HTTPS://hub.example:443');
      expect(store.get('https://hub.example/')).toBeNull();
    } finally {
      close();
    }
  });
});
