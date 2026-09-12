import { encodeBase64url, randomBytes } from '@vibeterm/shared/auth';
import { eq } from 'drizzle-orm';
import type { AuthDb } from '../auth/types';
import { gatewayKv, nodeIdentity } from '../db/schema';
import { TURN_CREDENTIAL_KV_KEY } from './relay-turn-config';

export type TurnLongTermCredential = {
  username: string;
  credential: string;
};

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readKv(db: AuthDb, key: string): string | null {
  return db.select().from(gatewayKv).where(eq(gatewayKv.key, key)).get()?.value ?? null;
}

function writeKv(db: AuthDb, key: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(gatewayKv)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: gatewayKv.key, set: { value, updatedAt: now } })
    .run();
}

export function readRelayNodeIdPrefix(db: AuthDb): string | null {
  const row = db
    .select({ nodeId: nodeIdentity.nodeId })
    .from(nodeIdentity)
    .where(eq(nodeIdentity.id, 1))
    .get();
  const id = row?.nodeId?.trim().toLowerCase();
  if (!id || id.length < 8) return null;
  return id.slice(0, 8);
}

function parseStored(raw: string): TurnLongTermCredential | null {
  try {
    const parsed = JSON.parse(raw) as { username?: unknown; credential?: unknown };
    if (typeof parsed.username !== 'string' || !parsed.username.startsWith('vt-')) return null;
    if (typeof parsed.credential !== 'string' || parsed.credential.length === 0) return null;
    return { username: parsed.username, credential: parsed.credential };
  } catch {
    return null;
  }
}

export function mintTurnUsername(nodeIdPrefix: string | null, entropy = randomBytes): string {
  const suffix =
    nodeIdPrefix && /^[0-9a-f]{8}$/.test(nodeIdPrefix) ? nodeIdPrefix : hexOf(entropy(4));
  return `vt-${suffix}`;
}

export function loadOrCreateTurnCredentials(
  db: AuthDb,
  opts?: { entropy?: (n: number) => Uint8Array }
): TurnLongTermCredential {
  const existing = readKv(db, TURN_CREDENTIAL_KV_KEY);
  if (existing) {
    const parsed = parseStored(existing);
    if (parsed) return parsed;
  }
  const entropy = opts?.entropy ?? randomBytes;
  const minted: TurnLongTermCredential = {
    username: mintTurnUsername(readRelayNodeIdPrefix(db), entropy),
    credential: encodeBase64url(entropy(32)),
  };
  writeKv(db, TURN_CREDENTIAL_KV_KEY, JSON.stringify(minted));
  return minted;
}
