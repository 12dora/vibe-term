import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { eq } from 'drizzle-orm';
import { createMigratedAuthDb } from '../auth/test-db';
import { gatewayKv, nodeIdentity } from '../db/schema';
import { TURN_CREDENTIAL_KV_KEY } from './relay-turn-config';
import { loadOrCreateTurnCredentials, mintTurnUsername } from './relay-turn-credentials';

const dbs: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('loadOrCreateTurnCredentials', () => {
  test('mints vt-<node-id prefix> and persists across calls', () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    handle.db
      .insert(nodeIdentity)
      .values({
        id: 1,
        nodeId: 'abcdef0123456789abcdef0123456789',
        privateKey: 'x',
        x25519PrivateKey: 'x',
        certificateJson: '{}',
        certSig: Buffer.from('x'),
      })
      .run();
    const first = loadOrCreateTurnCredentials(handle.db, {
      entropy: (n) => new Uint8Array(n).fill(7),
    });
    expect(first.username).toBe('vt-abcdef01');
    expect(first.credential).toBe(encodeBase64url(new Uint8Array(32).fill(7)));
    const second = loadOrCreateTurnCredentials(handle.db, {
      entropy: (n) => new Uint8Array(n).fill(9),
    });
    expect(second).toEqual(first);
    const row = handle.db
      .select()
      .from(gatewayKv)
      .where(eq(gatewayKv.key, TURN_CREDENTIAL_KV_KEY))
      .get();
    expect(row?.value).toContain('vt-abcdef01');
  });

  test('falls back to random hex when there is no node identity', () => {
    const handle = createMigratedAuthDb();
    dbs.push(handle);
    const minted = loadOrCreateTurnCredentials(handle.db, {
      entropy: (n) => new Uint8Array(n).fill(0xab),
    });
    expect(minted.username).toBe('vt-abababab');
  });

  test('mintTurnUsername uses random bytes when prefix is missing', () => {
    expect(mintTurnUsername(null, (n) => new Uint8Array(n).fill(0xcd))).toBe('vt-cdcdcdcd');
    expect(mintTurnUsername('nothex!!')).toMatch(/^vt-[0-9a-f]{8}$/);
  });
});
