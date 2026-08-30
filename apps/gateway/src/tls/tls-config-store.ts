import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { decryptWithContext, encrypt } from '../crypto';
import { tlsConfig } from '../db/schema';
import {
  DEFAULT_TLS_BIND_HOST,
  DEFAULT_TLS_PORT,
  TLS_CONFIG_ENTITY_ID,
  TLS_CONFIG_ROW_ID,
  TLS_CONFIG_SCOPE,
  type TlsConfigPatch,
  type TlsConfigPublic,
  type TlsPrivateMaterial,
} from './types';

const SECRET_SPECS = [
  ['caKeyPem', 'caKeyEnc', 'ca_key'],
  ['keyPem', 'keyEnc', 'key'],
  ['acmeCfToken', 'acmeCfTokenEnc', 'acme_cf_token'],
  ['acmeAccountKey', 'acmeAccountKeyEnc', 'acme_account_key'],
] as const;

const MERGE_KEYS = ['mode', 'tlsPort', 'bindHost', 'sans', 'acmeStaging', 'acmeStatus'] as const;
const NULLABLE_KEYS = [
  'caCertPem',
  'certPem',
  'certNotBefore',
  'certNotAfter',
  'acmeEmail',
  'acmeDomain',
  'acmeChallenge',
  'acmeAccountUrl',
  'acmeAccountDirectory',
  'acmeLastError',
  'acmeLastAttemptAt',
  'acmeNextRenewAt',
] as const;

function oneOf<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[]
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
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
    if (!row) return emptyPublic();
    return {
      id: TLS_CONFIG_ROW_ID,
      mode: oneOf(row.mode, ['none', 'external', 'selfsigned', 'acme'] as const) ?? 'none',
      tlsPort: row.tlsPort,
      bindHost: row.bindHost,
      sans: parseSans(row.sans),
      caCertPem: row.caCertPem ?? null,
      certPem: row.certPem ?? null,
      certNotBefore: row.certNotBefore ?? null,
      certNotAfter: row.certNotAfter ?? null,
      acmeEmail: row.acmeEmail ?? null,
      acmeDomain: row.acmeDomain ?? null,
      acmeChallenge: oneOf(row.acmeChallenge, ['http-01', 'dns-01'] as const) ?? null,
      acmeStaging: Boolean(row.acmeStaging),
      acmeAccountUrl: row.acmeAccountUrl ?? null,
      acmeAccountDirectory: row.acmeAccountDirectory ?? null,
      acmeStatus: oneOf(row.acmeStatus, ['idle', 'pending', 'ok', 'error'] as const) ?? 'idle',
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
    return Object.fromEntries(
      await Promise.all(
        SECRET_SPECS.map(async ([key, enc, field]) => [key, await decryptField(row[enc], field)])
      )
    ) as TlsPrivateMaterial;
  }

  async upsert(partial: TlsConfigPatch): Promise<TlsConfigPublic> {
    const current = await this.get();
    const secrets = await this.getPrivateMaterial();
    const nextSecrets = Object.fromEntries(
      SECRET_SPECS.map(([key]) => [key, key in partial ? (partial[key] ?? null) : secrets[key]])
    ) as TlsPrivateMaterial;
    const enc = Object.fromEntries(
      await Promise.all(
        SECRET_SPECS.map(async ([key, encKey]) => [encKey, await encryptField(nextSecrets[key])])
      )
    );
    const values = {
      id: TLS_CONFIG_ROW_ID,
      updatedAt: partial.updatedAt ?? Date.now(),
      ...Object.fromEntries(MERGE_KEYS.map((key) => [key, partial[key] ?? current[key]])),
      ...Object.fromEntries(
        NULLABLE_KEYS.map((key) => [key, key in partial ? (partial[key] ?? null) : current[key]])
      ),
      ...enc,
    };
    const { id: _id, ...set } = values;
    this.db
      .insert(tlsConfig)
      .values(values as typeof tlsConfig.$inferInsert)
      .onConflictDoUpdate({ target: tlsConfig.id, set })
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
  field: (typeof SECRET_SPECS)[number][2]
): Promise<string | null> {
  if (!ciphertext) return null;
  return decryptWithContext(ciphertext, {
    scope: TLS_CONFIG_SCOPE,
    entityId: TLS_CONFIG_ENTITY_ID,
    field,
  });
}
