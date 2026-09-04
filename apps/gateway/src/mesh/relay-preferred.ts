import { canonicalHubUrl } from '@tmex/shared/auth';
import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { gatewayKv } from '../db/schema';

function sameRelayUrl(a: string, b: string): boolean {
  try {
    return canonicalHubUrl(a) === canonicalHubUrl(b);
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}

export const RELAY_PREFERRED_URL_KEY = 'relay.preferredUrl';

export function readPreferredRelayUrl(db: AuthDb): string | null {
  try {
    const row = db.select().from(gatewayKv).where(eq(gatewayKv.key, RELAY_PREFERRED_URL_KEY)).get();
    const value = row?.value?.trim() ?? '';
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writePreferredRelayUrl(db: AuthDb, url: string): void {
  const now = new Date().toISOString();
  db.insert(gatewayKv)
    .values({ key: RELAY_PREFERRED_URL_KEY, value: url, updatedAt: now })
    .onConflictDoUpdate({
      target: gatewayKv.key,
      set: { value: url, updatedAt: now },
    })
    .run();
}

/** 把首选中继排到最前，其余保持原优先级顺序。未知首选则原样返回。 */
export function orderRelaysByPreferred<T extends { url: string }>(
  rows: readonly T[],
  preferred: string | null | undefined
): T[] {
  if (!preferred) return [...rows];
  const idx = rows.findIndex((row) => sameRelayUrl(row.url, preferred));
  if (idx <= 0) return [...rows];
  const chosen = rows[idx];
  if (!chosen) return [...rows];
  return [chosen, ...rows.filter((_, i) => i !== idx)];
}
