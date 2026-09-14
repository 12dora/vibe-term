import { describe, expect, test } from 'bun:test';
import { RelayCaPinStore } from './relay-ca-pin-store';
import { createMigratedAuthDb } from './test-db';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const FP = 'ab'.repeat(32);

describe('RelayCaPinStore', () => {
  test('0057 creates relay_ca_pins table', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_ca_pins'")
        .get();
      expect(tables).not.toBeNull();
      const columns = sqlite.query('PRAGMA table_info(relay_ca_pins)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'relay_url',
        'ca_pem',
        'fingerprint',
        'created_at',
      ]);
    } finally {
      close();
    }
  });

  test('get/put/delete by relay URL, trailing slash normalized', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new RelayCaPinStore(db);
      expect(store.get('https://relay.example')).toBeNull();
      store.put({
        url: 'https://relay.example/',
        caPem: PEM,
        fingerprint: FP,
      });
      const row = store.get('https://relay.example');
      expect(row?.url).toBe('https://relay.example');
      expect(row?.caPem).toContain('BEGIN CERTIFICATE');
      expect(row?.fingerprint).toBe(FP);
      expect(row?.createdAt).toBeGreaterThan(0);

      store.put({
        url: 'https://relay.example',
        caPem: '-----BEGIN CERTIFICATE-----\nUPDATED\n-----END CERTIFICATE-----',
        fingerprint: 'cd'.repeat(32),
      });
      expect(store.get('https://relay.example/')?.fingerprint).toBe('cd'.repeat(32));
      expect(store.get('https://relay.example/')?.caPem).toContain('UPDATED');

      store.delete('https://relay.example/');
      expect(store.get('https://relay.example')).toBeNull();
    } finally {
      close();
    }
  });

  test('put/get/delete canonicalize host, default port, and trailing slash', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new RelayCaPinStore(db);
      store.put({
        url: 'HTTPS://Relay.Example:443/',
        caPem: PEM,
        fingerprint: FP,
      });
      expect(store.get('https://relay.example')?.url).toBe('https://relay.example');
      expect(store.get('https://RELAY.EXAMPLE:443/')?.fingerprint).toBe(FP);
      store.delete('HTTPS://relay.example:443');
      expect(store.get('https://relay.example/')).toBeNull();
    } finally {
      close();
    }
  });

  test('clear removes every pin', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new RelayCaPinStore(db);
      store.put({ url: 'https://a.example', caPem: PEM, fingerprint: FP });
      store.put({ url: 'https://b.example', caPem: PEM, fingerprint: 'cd'.repeat(32) });
      store.clear();
      expect(store.get('https://a.example')).toBeNull();
      expect(store.get('https://b.example')).toBeNull();
    } finally {
      close();
    }
  });
});
