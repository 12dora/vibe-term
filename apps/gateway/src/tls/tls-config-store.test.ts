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
        'acme_account_directory',
        'acme_dns_provider',
        'acme_dns_secret_enc',
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
      expect(row.acmeAccountDirectory).toBeNull();
      expect(row.acmeDnsProvider).toBeNull();
      expect(row.hasDnsCredentials).toBe(false);
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
        acmeDnsSecret: null,
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
      expect(saved.hasDnsCredentials).toBe(true);
      expect(saved.acmeDnsProvider).toBe('cloudflare');
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
      expect(material.acmeDnsSecret).toBe('{"token":"cf-token-secret"}');
    } finally {
      close();
    }
  });

  test('legacy acme_cf_token_enc is presented as cloudflare when new columns are empty', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      await store.upsert({ acmeCfToken: 'legacy-token' });
      sqlite
        .query(
          'UPDATE tls_config SET acme_dns_provider = NULL, acme_dns_secret_enc = NULL WHERE id = 1'
        )
        .run();
      const row = await store.get();
      expect(row.acmeDnsProvider).toBe('cloudflare');
      expect(row.hasCloudflareToken).toBe(true);
      expect(row.hasDnsCredentials).toBe(true);
      const material = await store.getPrivateMaterial();
      expect(material.acmeCfToken).toBe('legacy-token');
      expect(material.acmeDnsSecret).toBeNull();
    } finally {
      close();
    }
  });

  test('stores dnspod JSON secret without writing the legacy cf token column', async () => {
    const { db, sqlite, close } = createMigratedAuthDb();
    try {
      const store = new TlsConfigStore(db);
      const saved = await store.upsert({
        mode: 'acme',
        acmeDnsProvider: 'dnspod',
        acmeDnsSecret: JSON.stringify({ id: '42', token: 'dnspod-secret' }),
      });
      expect(saved.acmeDnsProvider).toBe('dnspod');
      expect(saved.hasDnsCredentials).toBe(true);
      expect(saved.hasCloudflareToken).toBe(false);
      const raw = sqlite
        .query('SELECT acme_cf_token_enc, acme_dns_secret_enc FROM tls_config WHERE id = 1')
        .get() as { acme_cf_token_enc: string | null; acme_dns_secret_enc: string };
      expect(raw.acme_cf_token_enc).toBeNull();
      expect(raw.acme_dns_secret_enc).not.toBe('{"id":"42","token":"dnspod-secret"}');
      const material = await store.getPrivateMaterial();
      expect(material.acmeDnsSecret).toBe('{"id":"42","token":"dnspod-secret"}');
      expect(material.acmeCfToken).toBeNull();
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

      const withDirectory = await store.upsert({
        acmeAccountUrl: 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/1',
        acmeAccountDirectory: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      });
      expect(withDirectory.acmeAccountUrl).toBe(
        'https://acme-staging-v02.api.letsencrypt.org/acme/acct/1'
      );
      expect(withDirectory.acmeAccountDirectory).toBe(
        'https://acme-staging-v02.api.letsencrypt.org/directory'
      );
      const clearedUrl = await store.upsert({ acmeAccountUrl: null });
      expect(clearedUrl.acmeAccountUrl).toBeNull();
      expect(clearedUrl.acmeAccountDirectory).toBe(
        'https://acme-staging-v02.api.letsencrypt.org/directory'
      );
      expect(clearedUrl.hasAccountKey).toBe(false);
      const material = await store.getPrivateMaterial();
      expect(material.acmeCfToken).toBe('keep-me');
      expect(material.acmeAccountKey).toBeNull();
    } finally {
      close();
    }
  });
});
