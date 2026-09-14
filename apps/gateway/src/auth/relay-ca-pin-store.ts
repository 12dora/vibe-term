import { canonicalPublicUrl } from '@vibeterm/shared/auth';
import { eq } from 'drizzle-orm';
import { relayCaPins } from '../db/schema';
import type { AuthDb } from './types';

export type RelayCaPinRecord = {
  url: string;
  caPem: string;
  fingerprint: string;
  createdAt: number;
};

export type PutRelayCaPinInput = {
  url: string;
  caPem: string;
  fingerprint: string;
  createdAt?: number;
};

function toRecord(row: {
  relayUrl: string;
  caPem: string;
  fingerprint: string;
  createdAt: number;
}): RelayCaPinRecord {
  return {
    url: row.relayUrl,
    caPem: row.caPem,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

function tryCanonicalUrl(url: string): string | null {
  try {
    return canonicalPublicUrl(url);
  } catch {
    return null;
  }
}

/** 自签中继的 CA 钉扎：`relay join --ca-fingerprint` 写入，uplink 拨号与健康探测按 URL 读取。 */
export class RelayCaPinStore {
  constructor(private readonly db: AuthDb) {}

  get(url: string): RelayCaPinRecord | null {
    const key = tryCanonicalUrl(url);
    if (!key) return null;
    const row = this.db.select().from(relayCaPins).where(eq(relayCaPins.relayUrl, key)).get();
    if (row) return toRecord(row);
    for (const candidate of this.db.select().from(relayCaPins).all()) {
      if (tryCanonicalUrl(candidate.relayUrl) === key) return toRecord(candidate);
    }
    return null;
  }

  put(input: PutRelayCaPinInput): RelayCaPinRecord {
    const url = canonicalPublicUrl(input.url);
    const createdAt = input.createdAt ?? Date.now();
    this.db
      .insert(relayCaPins)
      .values({ relayUrl: url, caPem: input.caPem, fingerprint: input.fingerprint, createdAt })
      .onConflictDoUpdate({
        target: relayCaPins.relayUrl,
        set: { caPem: input.caPem, fingerprint: input.fingerprint, createdAt },
      })
      .run();
    for (const candidate of this.db.select().from(relayCaPins).all()) {
      if (candidate.relayUrl === url) continue;
      if (tryCanonicalUrl(candidate.relayUrl) === url) {
        this.db.delete(relayCaPins).where(eq(relayCaPins.relayUrl, candidate.relayUrl)).run();
      }
    }
    return { url, caPem: input.caPem, fingerprint: input.fingerprint, createdAt };
  }

  delete(url: string): void {
    const key = tryCanonicalUrl(url);
    if (!key) return;
    for (const candidate of this.db.select().from(relayCaPins).all()) {
      if (candidate.relayUrl === key || tryCanonicalUrl(candidate.relayUrl) === key) {
        this.db.delete(relayCaPins).where(eq(relayCaPins.relayUrl, candidate.relayUrl)).run();
      }
    }
  }

  clear(): void {
    this.db.delete(relayCaPins).run();
  }
}
