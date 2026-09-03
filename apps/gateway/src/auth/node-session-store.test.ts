import { describe, expect, test } from 'bun:test';
import { bytesEqual } from '../bytes';
import { users } from '../db/schema';
import {
  type IssueNodeSessionInput,
  NODE_SESSION_HARD_TTL_MS,
  NODE_SESSION_TTL_MS,
  NodeSessionStore,
} from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import type { AuthDb } from './types';

const HOUR_MS = 60 * 60 * 1000;
const SESS_PK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CRED_A = Uint8Array.from({ length: 16 }, (_, i) => i + 10);
const CRED_B = Uint8Array.from({ length: 16 }, (_, i) => i + 40);

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

function storeWithUser(userId = 'user-1'): {
  store: NodeSessionStore;
  close: () => void;
} {
  const { db, close } = createMigratedAuthDb();
  seedUser(db, userId);
  return { store: new NodeSessionStore(db), close };
}

describe('NodeSessionStore', () => {
  test('issue returns opaque sid and 18h / 7d expiry', () => {
    const { store, close } = storeWithUser();
    try {
      const issued = store.issue({
        userId: 'user-1',
        viaNodeId: 'entry-a',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 1_000,
      });
      expect(Buffer.from(issued.sid, 'base64url').byteLength).toBe(32);
      expect(issued.expiresAt).toBe(1_000 + NODE_SESSION_TTL_MS);
      expect(issued.hardExpiresAt).toBe(1_000 + NODE_SESSION_HARD_TTL_MS);

      const verified = store.verify(issued.sid, { viaNodeId: 'entry-a', now: 1_000 });
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.session.userId).toBe('user-1');
        expect(verified.session.viaNodeId).toBe('entry-a');
        expect(bytesEqual(verified.session.sessPublicKey, SESS_PK)).toBe(true);
        expect(verified.renewedExpiresAt).toBeUndefined();
      }
    } finally {
      close();
    }
  });

  test('verify rejects unknown, via_mismatch, expired, and revoked sids', () => {
    const { store, close } = storeWithUser();
    try {
      expect(store.verify('not-a-sid', { viaNodeId: 'entry-a', now: 0 })).toEqual({
        ok: false,
        reason: 'unknown',
      });

      const issued = store.issue({
        userId: 'user-1',
        viaNodeId: 'entry-a',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });
      expect(store.verify(issued.sid, { viaNodeId: 'entry-b', now: 0 })).toEqual({
        ok: false,
        reason: 'via_mismatch',
      });
      expect(store.verify(issued.sid, { viaNodeId: 'entry-a', now: NODE_SESSION_TTL_MS })).toEqual({
        ok: false,
        reason: 'expired',
      });

      const live = store.issue({
        userId: 'user-1',
        viaNodeId: 'entry-a',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });
      store.revoke(live.sid, 10);
      expect(store.verify(live.sid, { viaNodeId: 'entry-a', now: 20 })).toEqual({
        ok: false,
        reason: 'revoked',
      });
    } finally {
      close();
    }
  });

  test('sliding renewal happens only after remaining lifetime drops below half TTL', () => {
    const { store, close } = storeWithUser();
    try {
      const issued = store.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: SESS_PK,
        delegationMethod: 'passkey',
        credentialId: CRED_A,
        now: 0,
      });
      const beforeHalf = store.verify(issued.sid, {
        viaNodeId: 'self',
        now: NODE_SESSION_TTL_MS / 2,
      });
      expect(beforeHalf.ok).toBe(true);
      if (beforeHalf.ok) {
        expect(beforeHalf.renewedExpiresAt).toBeUndefined();
        expect(beforeHalf.session.expiresAt).toBe(NODE_SESSION_TTL_MS);
      }

      const pastHalf = store.verify(issued.sid, {
        viaNodeId: 'self',
        now: NODE_SESSION_TTL_MS / 2 + 1,
      });
      expect(pastHalf.ok).toBe(true);
      if (!pastHalf.ok) {
        throw new Error('expected renew');
      }
      if (pastHalf.renewedExpiresAt === undefined) {
        throw new Error('expected renewedExpiresAt');
      }
      expect(pastHalf.renewedExpiresAt).toBe(NODE_SESSION_TTL_MS / 2 + 1 + NODE_SESSION_TTL_MS);

      const shortlyAfter = store.verify(issued.sid, {
        viaNodeId: 'self',
        now: NODE_SESSION_TTL_MS / 2 + 30_000,
      });
      expect(shortlyAfter.ok).toBe(true);
      if (shortlyAfter.ok) {
        expect(shortlyAfter.renewedExpiresAt).toBeUndefined();
        expect(shortlyAfter.session.expiresAt).toBe(pastHalf.renewedExpiresAt);
      }
    } finally {
      close();
    }
  });

  test('renewal cannot exceed hardExpiresAt; hourly use still dies at 7d', () => {
    const { store, close } = storeWithUser();
    try {
      const issued = store.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });
      let lastOkAt = 0;
      for (let t = HOUR_MS; t < NODE_SESSION_HARD_TTL_MS; t += HOUR_MS) {
        const result = store.verify(issued.sid, { viaNodeId: 'self', now: t });
        expect(result.ok).toBe(true);
        if (result.ok && result.renewedExpiresAt !== undefined) {
          expect(result.renewedExpiresAt).toBeLessThanOrEqual(issued.hardExpiresAt);
        }
        lastOkAt = t;
      }
      expect(lastOkAt).toBeLessThan(NODE_SESSION_HARD_TTL_MS);
      expect(
        store.verify(issued.sid, { viaNodeId: 'self', now: NODE_SESSION_HARD_TTL_MS })
      ).toEqual({ ok: false, reason: 'expired' });
    } finally {
      close();
    }
  });

  test('clamped to hardExpiresAt does not rewrite or reissue cookie on every request', () => {
    const { store, close } = storeWithUser();
    try {
      const issued = store.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });
      for (let t = HOUR_MS; t < NODE_SESSION_HARD_TTL_MS - 8 * HOUR_MS; t += HOUR_MS) {
        const walked = store.verify(issued.sid, { viaNodeId: 'self', now: t });
        expect(walked.ok).toBe(true);
      }

      const nearHard = NODE_SESSION_HARD_TTL_MS - 8 * HOUR_MS;
      const first = store.verify(issued.sid, { viaNodeId: 'self', now: nearHard });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('expected live session');
      expect(first.session.expiresAt).toBe(issued.hardExpiresAt);

      const second = store.verify(issued.sid, { viaNodeId: 'self', now: nearHard + 1 });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected live session');
      expect(second.renewedExpiresAt).toBeUndefined();
      expect(second.session.expiresAt).toBe(issued.hardExpiresAt);
      expect(second.session.renewedAt).toBe(first.session.renewedAt);

      const third = store.verify(issued.sid, { viaNodeId: 'self', now: nearHard + 60_000 });
      expect(third.ok).toBe(true);
      if (!third.ok) throw new Error('expected live session');
      expect(third.renewedExpiresAt).toBeUndefined();
      expect(third.session.renewedAt).toBe(first.session.renewedAt);
    } finally {
      close();
    }
  });

  test('revokeAllForUser / revokeByCredential / revokeVia only touch matching rows', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      seedUser(db, 'user-1');
      seedUser(db, 'user-2');
      const store = new NodeSessionStore(db);
      const a = store.issue({
        userId: 'user-1',
        viaNodeId: 'entry-a',
        sessPublicKey: SESS_PK,
        delegationMethod: 'passkey',
        credentialId: CRED_A,
        now: 0,
      });
      const b = store.issue({
        userId: 'user-1',
        viaNodeId: 'entry-b',
        sessPublicKey: SESS_PK,
        delegationMethod: 'passkey',
        credentialId: CRED_B,
        now: 0,
      });
      const c = store.issue({
        userId: 'user-2',
        viaNodeId: 'entry-a',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });

      store.revokeByCredential(CRED_A, 5);
      expect(store.verify(a.sid, { viaNodeId: 'entry-a', now: 10 }).ok).toBe(false);
      expect(store.verify(b.sid, { viaNodeId: 'entry-b', now: 10 }).ok).toBe(true);

      store.revokeVia('entry-b', 15);
      expect(store.verify(b.sid, { viaNodeId: 'entry-b', now: 20 })).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect(store.verify(c.sid, { viaNodeId: 'entry-a', now: 20 }).ok).toBe(true);

      store.revokeAllForUser('user-2', 25);
      expect(store.verify(c.sid, { viaNodeId: 'entry-a', now: 30 })).toEqual({
        ok: false,
        reason: 'revoked',
      });
    } finally {
      close();
    }
  });

  test('issue requires credentialId for passkey and allows root without it', () => {
    const { store, close } = storeWithUser();
    try {
      const root = store.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });
      const rootOk = store.verify(root.sid, { viaNodeId: 'self', now: 0 });
      expect(rootOk.ok).toBe(true);
      if (rootOk.ok) {
        expect(rootOk.session.delegationMethod).toBe('root');
        expect(rootOk.session.credentialId).toBeNull();
      }

      const passkey = store.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: SESS_PK,
        delegationMethod: 'passkey',
        credentialId: CRED_A,
        now: 0,
      });
      const passkeyOk = store.verify(passkey.sid, { viaNodeId: 'self', now: 0 });
      expect(passkeyOk.ok).toBe(true);
      if (passkeyOk.ok) {
        expect(passkeyOk.session.delegationMethod).toBe('passkey');
        expect(passkeyOk.session.credentialId).not.toBeNull();
        expect(bytesEqual(passkeyOk.session.credentialId ?? new Uint8Array(), CRED_A)).toBe(true);
      }

      expect(() =>
        store.issue({
          userId: 'user-1',
          viaNodeId: 'self',
          sessPublicKey: SESS_PK,
          delegationMethod: 'passkey',
          now: 0,
        } as IssueNodeSessionInput)
      ).toThrow();
    } finally {
      close();
    }
  });

  test('sweepExpired removes sessions past expiresAt', () => {
    const { store, close } = storeWithUser();
    try {
      const issued = store.issue({
        userId: 'user-1',
        viaNodeId: 'self',
        sessPublicKey: SESS_PK,
        delegationMethod: 'root',
        now: 0,
      });
      expect(store.sweepExpired(NODE_SESSION_TTL_MS)).toBe(1);
      expect(store.verify(issued.sid, { viaNodeId: 'self', now: NODE_SESSION_TTL_MS - 1 })).toEqual(
        {
          ok: false,
          reason: 'unknown',
        }
      );
    } finally {
      close();
    }
  });
});
