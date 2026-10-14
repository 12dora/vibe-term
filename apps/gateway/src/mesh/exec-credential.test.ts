import { describe, expect, test } from 'bun:test';
import { NODE_SESSION_TTL_MS, NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { users } from '../db/schema';
import { verifyExecCredential } from './exec-credential';
import { verifyStreamAuth } from './stream-auth';

const SESS_PK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function seedUser(db: AuthDb, id: string): void {
  db.insert(users)
    .values({
      id,
      username: `user-${id}`,
      rootPublicKey: Buffer.alloc(32, 1),
      rootEpoch: 0,
      kdfParamsJson: '{}',
      totpRecordSeq: null,
      keyLogHeadSeq: 0,
      keyLogHeadHash: Buffer.alloc(32, 2),
      createdAt: 0,
      updatedAt: 0,
    })
    .run();
}

function boot() {
  const { db, close } = createMigratedAuthDb();
  seedUser(db, 'user-1');
  const sessionStore = new NodeSessionStore(db);
  const { sid } = sessionStore.issue({
    userId: 'user-1',
    viaNodeId: 'entry-a',
    sessPublicKey: SESS_PK,
    delegationMethod: 'root',
    now: 1_000,
  });
  return { sessionStore, sid, close };
}

describe('verifyExecCredential', () => {
  test('a node-session sid issued for the peer resolves to its user, without a token id', () => {
    const { sessionStore, sid, close } = boot();
    try {
      const ctx = { peerNodeId: 'entry-a', sessionStore, now: () => 2_000 };
      expect(verifyExecCredential(sid, ctx)).toEqual({ ok: true, uid: 'user-1', tokenId: null });
    } finally {
      close();
    }
  });

  test('uses the same rules as verifyStreamAuth for sids', () => {
    const { sessionStore, sid, close } = boot();
    try {
      const cases = [
        { peerNodeId: 'entry-a', now: 2_000 },
        { peerNodeId: 'entry-b', now: 2_000 },
        { peerNodeId: 'entry-a', now: 1_000 + NODE_SESSION_TTL_MS + 1 },
      ];
      for (const input of cases) {
        const ctx = { peerNodeId: input.peerNodeId, sessionStore, now: () => input.now };
        const exec = verifyExecCredential(sid, ctx);
        const stream = verifyStreamAuth(sid, '/api/exec/ws', ctx);
        expect(exec.ok).toBe(stream.ok);
        if (!exec.ok && !stream.ok) expect(exec.reason).toBe(stream.reason);
      }
      expect(
        verifyExecCredential(sid, { peerNodeId: 'entry-b', sessionStore, now: () => 2_000 })
      ).toEqual({ ok: false, reason: 'via_mismatch' });
    } finally {
      close();
    }
  });

  test('rejects missing, empty, unknown and non-string credentials', () => {
    const { sessionStore, close } = boot();
    try {
      const ctx = { peerNodeId: 'entry-a', sessionStore, now: () => 2_000 };
      expect(verifyExecCredential(undefined, ctx)).toEqual({ ok: false, reason: 'missing auth' });
      expect(verifyExecCredential('', ctx)).toEqual({ ok: false, reason: 'missing auth' });
      expect(verifyExecCredential(42, ctx)).toEqual({ ok: false, reason: 'missing auth' });
      expect(verifyExecCredential('not-a-sid', ctx)).toEqual({ ok: false, reason: 'unknown' });
    } finally {
      close();
    }
  });

  test('share credentials never open an exec channel', () => {
    const { sessionStore, close } = boot();
    try {
      const result = verifyExecCredential('share:abc', {
        peerNodeId: 'entry-a',
        sessionStore,
        now: () => 2_000,
      });
      expect(result).toEqual({ ok: false, reason: 'share_forbidden' });
    } finally {
      close();
    }
  });

  test('tok: credentials are not supported yet', () => {
    const { sessionStore, close } = boot();
    try {
      const result = verifyExecCredential('tok:vtk_secret', {
        peerNodeId: 'entry-a',
        sessionStore,
        now: () => 2_000,
      });
      expect(result).toEqual({ ok: false, reason: 'unsupported' });
    } finally {
      close();
    }
  });
});
