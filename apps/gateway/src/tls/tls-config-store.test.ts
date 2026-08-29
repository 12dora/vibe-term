import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { decryptWithContext } from '../crypto';
import { TlsConfigStore } from './tls-config-store';
import { TLS_CONFIG_ENTITY_ID, TLS_CONFIG_SCOPE } from './types';

describe('TlsConfigStore', () => {
  test('0021 creates tls_config singleton table', () => {
    const { sqlite, close } = createMigratedAuthDb();
    try {
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tls_config'")
        .get();
      expect(tables).not.toBeNull();
      const columns = sqlite.query('PRAGMA table_info(tls_config)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'mode',
        'tls_port',
        'bind_host',
        'sans',
        'ca_cert_pem',
        'ca_key_enc',
        'cert_pem',
        'key_enc',
        'cert_not_before',
        'cert_not_after',
        'acme_email',
        'acme_domain',
        'acme_challenge',
        'acme_staging',
        'acme_cf_token_enc',
        'acme_account_key_enc',
        'acme_account_url',
        'acme_status',
        'acme_last_error',
        'acme_last_attempt_at',
        'acme_next_renew_at',
        'updated_at',
      ]);
    } finally {
      close();
    }
  });

  test('get returns defaults when the singleton row is missing', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const row = await store.get();
      expect(row.mode).toBe('none');
      expect(row.tlsPort).toBe(9443);
      expect(row.bindHost).toBe('0.0.0.0');
      expect(row.sans).toEqual([]);
      expect(row.caCertPem).toBeNull();
      expect(row.certPem).toBeNull();
      expect(row.acmeStatus).toBe('idle');
      expect(row.hasCloudflareToken).toBe(false);
      expect(row.hasCaKey).toBe(false);
      expect(row.hasLeafKey).toBe(false);
      expect(row.hasAccountKey).toBe(false);
      const material = await store.getPrivateMaterial();
      expect(material).toEqual({
        caKeyPem: null,
        keyPem: null,
        acmeCfToken: null,
        acmeAccountKey: null,
      });
    } finally {
      close();
    }
  });

  test('upsert encrypts secrets and get() never returns private material', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const saved = await store.upsert({
        mode: 'selfsigned',
        tlsPort: 9443,
        bindHost: '127.0.0.1',
        sans: ['localhost', '127.0.0.1'],
        caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
        caKeyPem: 'CA_PRIVATE_KEY',
        certPem: '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----',
        keyPem: 'LEAF_PRIVATE_KEY',
        acmeCfToken: 'cf-token-secret',
        acmeAccountKey: 'ACME_ACCOUNT_KEY',
        acmeStatus: 'idle',
      });

      expect(saved.mode).toBe('selfsigned');
      expect(saved.sans).toEqual(['localhost', '127.0.0.1']);
      expect(saved.caCertPem).toContain('BEGIN CERTIFICATE');
      expect(saved.certPem).toContain('BEGIN CERTIFICATE');
      expect(saved.hasCaKey).toBe(true);
      expect(saved.hasLeafKey).toBe(true);
      expect(saved.hasCloudflareToken).toBe(true);
      expect(saved.hasAccountKey).toBe(true);
      expect(JSON.stringify(saved)).not.toContain('CA_PRIVATE_KEY');
      expect(JSON.stringify(saved)).not.toContain('LEAF_PRIVATE_KEY');
      expect(JSON.stringify(saved)).not.toContain('cf-token-secret');
      expect(JSON.stringify(saved)).not.toContain('ACME_ACCOUNT_KEY');

      const raw = sqlite
        .query(
          'SELECT ca_key_enc, key_enc, acme_cf_token_enc, acme_account_key_enc FROM tls_config WHERE id = 1'
        )
        .get() as {
        ca_key_enc: string;
        key_enc: string;
        acme_cf_token_enc: string;
        acme_account_key_enc: string;
      };
      expect(raw.ca_key_enc).not.toBe('CA_PRIVATE_KEY');
      expect(raw.key_enc).not.toBe('LEAF_PRIVATE_KEY');
      expect(raw.acme_cf_token_enc).not.toBe('cf-token-secret');
      expect(raw.acme_account_key_enc).not.toBe('ACME_ACCOUNT_KEY');

      expect(
        await decryptWithContext(raw.ca_key_enc, {
          scope: TLS_CONFIG_SCOPE,
          entityId: TLS_CONFIG_ENTITY_ID,
          field: 'ca_key',
        })
      ).toBe('CA_PRIVATE_KEY');
      expect(
        await decryptWithContext(raw.key_enc, {
          scope: TLS_CONFIG_SCOPE,
          entityId: TLS_CONFIG_ENTITY_ID,
          field: 'key',
        })
      ).toBe('LEAF_PRIVATE_KEY');
      expect(
        await decryptWithContext(raw.acme_cf_token_enc, {
          scope: TLS_CONFIG_SCOPE,
          entityId: TLS_CONFIG_ENTITY_ID,
          field: 'acme_cf_token',
        })
      ).toBe('cf-token-secret');
      expect(
        await decryptWithContext(raw.acme_account_key_enc, {
          scope: TLS_CONFIG_SCOPE,
          entityId: TLS_CONFIG_ENTITY_ID,
          field: 'acme_account_key',
        })
      ).toBe('ACME_ACCOUNT_KEY');

      const material = await store.getPrivateMaterial();
      expect(material.caKeyPem).toBe('CA_PRIVATE_KEY');
      expect(material.keyPem).toBe('LEAF_PRIVATE_KEY');
      expect(material.acmeCfToken).toBe('cf-token-secret');
      expect(material.acmeAccountKey).toBe('ACME_ACCOUNT_KEY');
    } finally {
      close();
    }
  });

  test('upsert merges partial updates and can clear a secret with null', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      await store.upsert({
        mode: 'acme',
        acmeDomain: 'example.com',
        acmeEmail: 'ops@example.com',
        acmeChallenge: 'dns-01',
        acmeCfToken: 'keep-me',
        acmeAccountKey: 'acct',
      });
      const updated = await store.upsert({
        acmeStatus: 'pending',
        acmeAccountKey: null,
      });
      expect(updated.mode).toBe('acme');
      expect(updated.acmeDomain).toBe('example.com');
      expect(updated.acmeStatus).toBe('pending');
      expect(updated.hasCloudflareToken).toBe(true);
      expect(updated.hasAccountKey).toBe(false);
      const material = await store.getPrivateMaterial();
      expect(material.acmeCfToken).toBe('keep-me');
      expect(material.acmeAccountKey).toBeNull();
    } finally {
      close();
    }
  });
});
