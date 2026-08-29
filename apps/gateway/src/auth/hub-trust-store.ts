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
  return hubUrl.replace(/\/+$/, '');
}

export class HubTrustStore {
  constructor(private readonly db: AuthDb) {}

  get(hubUrl: string): HubTrustRecord | null {
    const key = normalizeHubTrustUrl(hubUrl);
    if (!key) return null;
    const row = this.db.select().from(hubTrust).where(eq(hubTrust.hubUrl, key)).get();
    if (!row) return null;
    return {
      hubUrl: row.hubUrl,
      caPem: row.caPem,
      fingerprint: row.fingerprint,
      createdAt: row.createdAt,
    };
  }

  put(input: PutHubTrustInput): HubTrustRecord {
    const hubUrl = normalizeHubTrustUrl(input.hubUrl);
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
    return { hubUrl, caPem: input.caPem, fingerprint: input.fingerprint, createdAt };
  }

  delete(hubUrl: string): void {
    const key = normalizeHubTrustUrl(hubUrl);
    if (!key) return;
    this.db.delete(hubTrust).where(eq(hubTrust.hubUrl, key)).run();
  }
}
