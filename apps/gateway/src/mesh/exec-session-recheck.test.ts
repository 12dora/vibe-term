import { afterEach, describe, expect, test } from 'bun:test';
import { EcKind } from '@vibeterm/shared/exec-channel';
import { NODE_SESSION_TTL_MS, NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { users } from '../db/schema';
import { execCredentialValid } from '../exec/channel/credential-check';
import { resetExecRegistryForTests } from '../exec/channel/registry';
import { connect, flush, makeEnv, openSession, openSpec } from '../exec/channel/test-harness';
import { verifyExecCredential } from './exec-credential';
import {
  closeExecSessionsWithInvalidNodeSession,
  startExecSessionRecheck,
} from './exec-session-recheck';
import { waitUntil } from './test-support';

const SESS_PK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

afterEach(() => resetExecRegistryForTests());

function boot() {
  const { db, close } = createMigratedAuthDb();
  seedUser(db);
  const store = new NodeSessionStore(db);
  const issue = (viaNodeId: string) =>
    store.issue({
      userId: 'user-1',
      viaNodeId,
      sessPublicKey: SESS_PK,
      delegationMethod: 'root',
      now: 1_000,
    }).sid;
  return { store, issue, close };
}

function seedUser(db: AuthDb): void {
  db.insert(users)
    .values({
      id: 'user-1',
      username: 'user-user-1',
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

describe('exec session recheck', () => {
  test('a revoked local session ends only the exec sessions bound to it', async () => {
    const { store, issue, close } = boot();
    try {
      const env = makeEnv();
      const dead = issue('self');
      const live = issue('self');
      const a = await openSession(
        env,
        {},
        { uid: 'user-1', tokenId: null, session: { sid: dead, viaNodeId: 'self' } }
      );
      const b = await openSession(
        env,
        {},
        { uid: 'user-1', tokenId: null, session: { sid: live, viaNodeId: 'self' } }
      );
      const standalone = await openSession(env, {}, { uid: null, tokenId: null });
      closeExecSessionsWithInvalidNodeSession(store, 2_000);
      expect([a.proc.killCount, b.proc.killCount, standalone.proc.killCount]).toEqual([0, 0, 0]);
      store.revoke(dead, 1_500);
      closeExecSessionsWithInvalidNodeSession(store, 2_000);
      expect(a.proc.killCount).toBe(1);
      expect(a.client.transport.closed?.code).toBe(4401);
      expect([b.proc.killCount, standalone.proc.killCount]).toEqual([0, 0]);
    } finally {
      close();
    }
  });

  test('a mesh-target session is rechecked against the peer that issued it', async () => {
    const { store, issue, close } = boot();
    try {
      const env = makeEnv();
      const sid = issue('entry-a');
      const verified = verifyExecCredential(sid, {
        peerNodeId: 'entry-a',
        sessionStore: store,
        now: () => 2_000,
      });
      if (!verified.ok) throw new Error('credential rejected');
      const target = await openSession(
        env,
        {},
        { uid: verified.uid, tokenId: null, session: verified.session ?? null }
      );
      closeExecSessionsWithInvalidNodeSession(store, 2_000);
      expect(target.proc.killCount).toBe(0);
      store.revoke(sid, 2_500);
      closeExecSessionsWithInvalidNodeSession(store, 3_000);
      expect(target.proc.killCount).toBe(1);
      expect(target.client.transport.closed?.code).toBe(4401);
    } finally {
      close();
    }
  });

  test('the periodic recheck terminates an exec session whose session expired', async () => {
    const { store, issue, close } = boot();
    let stop: (() => void) | null = null;
    try {
      const env = makeEnv();
      const sid = issue('self');
      const exec = await openSession(
        env,
        {},
        { uid: 'user-1', tokenId: null, session: { sid, viaNodeId: 'self' } }
      );
      let now = 2_000;
      stop = startExecSessionRecheck(store, { intervalMs: 5, now: () => now });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(exec.proc.killCount).toBe(0);
      now = 1_000 + NODE_SESSION_TTL_MS + 1;
      await waitUntil(() => exec.proc.killCount === 1);
      expect(exec.client.transport.closed?.code).toBe(4401);
    } finally {
      stop?.();
      close();
    }
  });

  test('a revoked session ends its pre-HELLO connection and cannot open afterwards', async () => {
    const { store, issue, close } = boot();
    const stop = startExecSessionRecheck(store, { intervalMs: 60_000, now: () => 2_000 });
    try {
      const env = makeEnv();
      env.deps.credentialValid = execCredentialValid;
      const dead = issue('self');
      const waiting = connect(env, {
        uid: 'user-1',
        tokenId: null,
        session: { sid: dead, viaNodeId: 'self' },
      });
      store.revoke(dead, 1_500);
      closeExecSessionsWithInvalidNodeSession(store, 2_000);
      expect(waiting.transport.closed?.code).toBe(4401);
      const sneaky = connect(env, {
        uid: 'user-1',
        tokenId: null,
        session: { sid: dead, viaNodeId: 'self' },
      });
      sneaky.send(EcKind.HELLO, { v: 1, op: 'open', spec: openSpec() });
      await flush();
      expect(sneaky.transport.closed?.code).toBe(4401);
      expect(env.procs.length).toBe(0);
    } finally {
      stop();
      close();
    }
  });

  test('a failing session store does not end exec sessions', async () => {
    const env = makeEnv();
    const exec = await openSession(
      env,
      {},
      { uid: 'user-1', tokenId: null, session: { sid: 's', viaNodeId: 'self' } }
    );
    closeExecSessionsWithInvalidNodeSession({
      verify: () => {
        throw new Error('db down');
      },
    });
    expect(exec.proc.killCount).toBe(0);
  });
});
