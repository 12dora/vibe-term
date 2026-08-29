import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { decryptWithContext, encrypt } from '../crypto';
import { tlsConfig } from '../db/schema';
import {
  type AcmeChallengeType,
  type AcmeStatus,
  DEFAULT_TLS_BIND_HOST,
  DEFAULT_TLS_PORT,
  TLS_CONFIG_ENTITY_ID,
  TLS_CONFIG_ROW_ID,
  TLS_CONFIG_SCOPE,
  type TlsConfigPatch,
  type TlsConfigPublic,
  type TlsMode,
  type TlsPrivateMaterial,
} from './types';

const SECRET_FIELDS = {
  caKeyPem: 'ca_key',
  keyPem: 'key',
  acmeCfToken: 'acme_cf_token',
  acmeAccountKey: 'acme_account_key',
} as const;

type SecretField = (typeof SECRET_FIELDS)[keyof typeof SECRET_FIELDS];

function isTlsMode(value: string): value is TlsMode {
  return value === 'none' || value === 'external' || value === 'selfsigned' || value === 'acme';
}

function isAcmeChallenge(value: string | null): value is AcmeChallengeType {
  return value === 'http-01' || value === 'dns-01';
}

function isAcmeStatus(value: string): value is AcmeStatus {
  return value === 'idle' || value === 'pending' || value === 'ok' || value === 'error';
}

function emptyPublic(now = 0): TlsConfigPublic {
  return {
    id: TLS_CONFIG_ROW_ID,
    mode: 'none',
    tlsPort: DEFAULT_TLS_PORT,
    bindHost: DEFAULT_TLS_BIND_HOST,
    sans: [],
    caCertPem: null,
    certPem: null,
    certNotBefore: null,
    certNotAfter: null,
    acmeEmail: null,
    acmeDomain: null,
    acmeChallenge: null,
    acmeStaging: false,
    acmeAccountUrl: null,
    acmeAccountDirectory: null,
    acmeStatus: 'idle',
    acmeLastError: null,
    acmeLastAttemptAt: null,
    acmeNextRenewAt: null,
    hasCloudflareToken: false,
    hasCaKey: false,
    hasLeafKey: false,
    hasAccountKey: false,
    updatedAt: now,
  };
}

function parseSans(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed;
      }
    } catch {
      return [];
    }
  }
  return [];
}

export class TlsConfigStore {
  constructor(private readonly db: AuthDb) {}

  async get(): Promise<TlsConfigPublic> {
    const row = this.db.select().from(tlsConfig).where(eq(tlsConfig.id, TLS_CONFIG_ROW_ID)).get();
    if (!row) {
      return emptyPublic();
    }
    return {
      id: TLS_CONFIG_ROW_ID,
      mode: isTlsMode(row.mode) ? row.mode : 'none',
      tlsPort: row.tlsPort,
      bindHost: row.bindHost,
      sans: parseSans(row.sans),
      caCertPem: row.caCertPem ?? null,
      certPem: row.certPem ?? null,
      certNotBefore: row.certNotBefore ?? null,
      certNotAfter: row.certNotAfter ?? null,
      acmeEmail: row.acmeEmail ?? null,
      acmeDomain: row.acmeDomain ?? null,
      acmeChallenge: isAcmeChallenge(row.acmeChallenge) ? row.acmeChallenge : null,
      acmeStaging: Boolean(row.acmeStaging),
      acmeAccountUrl: row.acmeAccountUrl ?? null,
      acmeAccountDirectory: row.acmeAccountDirectory ?? null,
      acmeStatus: isAcmeStatus(row.acmeStatus) ? row.acmeStatus : 'idle',
      acmeLastError: row.acmeLastError ?? null,
      acmeLastAttemptAt: row.acmeLastAttemptAt ?? null,
      acmeNextRenewAt: row.acmeNextRenewAt ?? null,
      hasCloudflareToken: Boolean(row.acmeCfTokenEnc),
      hasCaKey: Boolean(row.caKeyEnc),
      hasLeafKey: Boolean(row.keyEnc),
      hasAccountKey: Boolean(row.acmeAccountKeyEnc),
      updatedAt: row.updatedAt,
    };
  }

  async getPrivateMaterial(): Promise<TlsPrivateMaterial> {
    const row = this.db.select().from(tlsConfig).where(eq(tlsConfig.id, TLS_CONFIG_ROW_ID)).get();
    if (!row) {
      return { caKeyPem: null, keyPem: null, acmeCfToken: null, acmeAccountKey: null };
    }
    return {
      caKeyPem: await decryptField(row.caKeyEnc, SECRET_FIELDS.caKeyPem),
      keyPem: await decryptField(row.keyEnc, SECRET_FIELDS.keyPem),
      acmeCfToken: await decryptField(row.acmeCfTokenEnc, SECRET_FIELDS.acmeCfToken),
      acmeAccountKey: await decryptField(row.acmeAccountKeyEnc, SECRET_FIELDS.acmeAccountKey),
    };
  }

  async upsert(partial: TlsConfigPatch): Promise<TlsConfigPublic> {
    const current = await this.get();
    const secrets = await this.getPrivateMaterial();
    const nextSecrets: TlsPrivateMaterial = {
      caKeyPem: 'caKeyPem' in partial ? (partial.caKeyPem ?? null) : secrets.caKeyPem,
      keyPem: 'keyPem' in partial ? (partial.keyPem ?? null) : secrets.keyPem,
      acmeCfToken: 'acmeCfToken' in partial ? (partial.acmeCfToken ?? null) : secrets.acmeCfToken,
      acmeAccountKey:
        'acmeAccountKey' in partial ? (partial.acmeAccountKey ?? null) : secrets.acmeAccountKey,
    };
    const [caKeyEnc, keyEnc, acmeCfTokenEnc, acmeAccountKeyEnc] = await Promise.all([
      encryptField(nextSecrets.caKeyPem),
      encryptField(nextSecrets.keyPem),
      encryptField(nextSecrets.acmeCfToken),
      encryptField(nextSecrets.acmeAccountKey),
    ]);
    const updatedAt = partial.updatedAt ?? Date.now();
    const values = {
      id: TLS_CONFIG_ROW_ID,
      mode: partial.mode ?? current.mode,
      tlsPort: partial.tlsPort ?? current.tlsPort,
      bindHost: partial.bindHost ?? current.bindHost,
      sans: partial.sans ?? current.sans,
      caCertPem: 'caCertPem' in partial ? (partial.caCertPem ?? null) : current.caCertPem,
      caKeyEnc,
      certPem: 'certPem' in partial ? (partial.certPem ?? null) : current.certPem,
      keyEnc,
      certNotBefore:
        'certNotBefore' in partial ? (partial.certNotBefore ?? null) : current.certNotBefore,
      certNotAfter:
        'certNotAfter' in partial ? (partial.certNotAfter ?? null) : current.certNotAfter,
      acmeEmail: 'acmeEmail' in partial ? (partial.acmeEmail ?? null) : current.acmeEmail,
      acmeDomain: 'acmeDomain' in partial ? (partial.acmeDomain ?? null) : current.acmeDomain,
      acmeChallenge:
        'acmeChallenge' in partial ? (partial.acmeChallenge ?? null) : current.acmeChallenge,
      acmeStaging: partial.acmeStaging ?? current.acmeStaging,
      acmeCfTokenEnc,
      acmeAccountKeyEnc,
      acmeAccountUrl:
        'acmeAccountUrl' in partial ? (partial.acmeAccountUrl ?? null) : current.acmeAccountUrl,
      acmeAccountDirectory:
        'acmeAccountDirectory' in partial
          ? (partial.acmeAccountDirectory ?? null)
          : current.acmeAccountDirectory,
      acmeStatus: partial.acmeStatus ?? current.acmeStatus,
      acmeLastError:
        'acmeLastError' in partial ? (partial.acmeLastError ?? null) : current.acmeLastError,
      acmeLastAttemptAt:
        'acmeLastAttemptAt' in partial
          ? (partial.acmeLastAttemptAt ?? null)
          : current.acmeLastAttemptAt,
      acmeNextRenewAt:
        'acmeNextRenewAt' in partial ? (partial.acmeNextRenewAt ?? null) : current.acmeNextRenewAt,
      updatedAt,
    };
    this.db
      .insert(tlsConfig)
      .values(values)
      .onConflictDoUpdate({
        target: tlsConfig.id,
        set: {
          mode: values.mode,
          tlsPort: values.tlsPort,
          bindHost: values.bindHost,
          sans: values.sans,
          caCertPem: values.caCertPem,
          caKeyEnc: values.caKeyEnc,
          certPem: values.certPem,
          keyEnc: values.keyEnc,
          certNotBefore: values.certNotBefore,
          certNotAfter: values.certNotAfter,
          acmeEmail: values.acmeEmail,
          acmeDomain: values.acmeDomain,
          acmeChallenge: values.acmeChallenge,
          acmeStaging: values.acmeStaging,
          acmeCfTokenEnc: values.acmeCfTokenEnc,
          acmeAccountKeyEnc: values.acmeAccountKeyEnc,
          acmeAccountUrl: values.acmeAccountUrl,
          acmeAccountDirectory: values.acmeAccountDirectory,
          acmeStatus: values.acmeStatus,
          acmeLastError: values.acmeLastError,
          acmeLastAttemptAt: values.acmeLastAttemptAt,
          acmeNextRenewAt: values.acmeNextRenewAt,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return this.get();
  }
}

async function encryptField(plaintext: string | null): Promise<string | null> {
  if (!plaintext) return null;
  return encrypt(plaintext);
}

async function decryptField(
  ciphertext: string | null | undefined,
  field: SecretField
): Promise<string | null> {
  if (!ciphertext) return null;
  return decryptWithContext(ciphertext, {
    scope: TLS_CONFIG_SCOPE,
    entityId: TLS_CONFIG_ENTITY_ID,
    field,
  });
}
