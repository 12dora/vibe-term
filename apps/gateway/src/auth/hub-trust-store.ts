import { canonicalHubUrl } from '@tmex/shared/auth';
import { eq } from 'drizzle-orm';
import { hubTrust } from '../db/schema';
import type { AuthDb } from './types';

export type HubTrustRecord = {
  hubUrl: string;
  caPem: string;
  fingerprint: string;
  createdAt: number;
};

export type PutHubTrustInput = {
  hubUrl: string;
  caPem: string;
  fingerprint: string;
  createdAt?: number;
};

export function normalizeHubTrustUrl(hubUrl: string): string {
  return canonicalHubUrl(hubUrl);
}

function toRecord(row: {
  hubUrl: string;
  caPem: string;
  fingerprint: string;
  createdAt: number;
}): HubTrustRecord {
  return {
    hubUrl: row.hubUrl,
    caPem: row.caPem,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

function tryCanonicalHubUrl(hubUrl: string): string | null {
  try {
    return canonicalHubUrl(hubUrl);
  } catch {
    return null;
  }
}

export class HubTrustStore {
  constructor(private readonly db: AuthDb) {}

  get(hubUrl: string): HubTrustRecord | null {
    const key = tryCanonicalHubUrl(hubUrl);
    if (!key) return null;
    const row = this.db.select().from(hubTrust).where(eq(hubTrust.hubUrl, key)).get();
    if (row) return toRecord(row);
    const rows = this.db.select().from(hubTrust).all();
    for (const candidate of rows) {
      const alias = tryCanonicalHubUrl(candidate.hubUrl);
      if (alias === key) return toRecord(candidate);
    }
    return null;
  }

  put(input: PutHubTrustInput): HubTrustRecord {
    const hubUrl = canonicalHubUrl(input.hubUrl);
    const createdAt = input.createdAt ?? Date.now();
    this.db
      .insert(hubTrust)
      .values({
        hubUrl,
        caPem: input.caPem,
        fingerprint: input.fingerprint,
        createdAt,
      })
      .onConflictDoUpdate({
        target: hubTrust.hubUrl,
        set: {
          caPem: input.caPem,
          fingerprint: input.fingerprint,
          createdAt,
        },
      })
      .run();
    const rows = this.db.select().from(hubTrust).all();
    for (const candidate of rows) {
      if (candidate.hubUrl === hubUrl) continue;
      if (tryCanonicalHubUrl(candidate.hubUrl) === hubUrl) {
        this.db.delete(hubTrust).where(eq(hubTrust.hubUrl, candidate.hubUrl)).run();
      }
    }
    return { hubUrl, caPem: input.caPem, fingerprint: input.fingerprint, createdAt };
  }

  delete(hubUrl: string): void {
    const key = tryCanonicalHubUrl(hubUrl);
    if (!key) return;
    const rows = this.db.select().from(hubTrust).all();
    for (const candidate of rows) {
      if (candidate.hubUrl === key || tryCanonicalHubUrl(candidate.hubUrl) === key) {
        this.db.delete(hubTrust).where(eq(hubTrust.hubUrl, candidate.hubUrl)).run();
      }
    }
  }
}
