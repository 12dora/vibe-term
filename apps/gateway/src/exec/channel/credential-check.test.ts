import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NodeSessionStore } from '../../auth/node-session-store';
import { createMigratedAuthDb } from '../../auth/test-db';
import { users } from '../../db/schema';
import { type TokenFixture, bootTokenFixture } from '../../mesh/token-test-support';
import { bindExecSessionVerifier, execCredentialValid } from './credential-check';

let fixture: TokenFixture;
beforeEach(() => {
  fixture = bootTokenFixture();
});
afterEach(() => fixture.close());

function bootSessions() {
  const { db, close } = createMigratedAuthDb();
  db.insert(users)
    .values({
      id: 'user-1',
      username: 'user-1-name',
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
  const store = new NodeSessionStore(db);
  const sid = store.issue({
    userId: 'user-1',
    viaNodeId: 'self',
    sessPublicKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    delegationMethod: 'root',
    now: 1_000,
  }).sid;
  return { store, sid, close };
}

describe('execCredentialValid', () => {
  test('standalone and plain session-less auth are valid', () => {
    expect(execCredentialValid({ uid: null, tokenId: null })).toBe(true);
    expect(execCredentialValid({ uid: 'u', tokenId: null, session: null })).toBe(true);
  });

  test('a token is valid until revoked or expired', () => {
    const token = fixture.mint(['exec'], 1);
    const auth = { uid: 'tok-user', tokenId: token.id };
    expect(execCredentialValid(auth)).toBe(true);
    fixture.service.revoke('tok-user', token.id);
    expect(execCredentialValid(auth)).toBe(false);
    const short = fixture.mint(['exec'], 1);
    fixture.setNow(1_800_000_000_000 + 2 * 86_400_000);
    expect(execCredentialValid({ uid: 'tok-user', tokenId: short.id })).toBe(false);
    expect(execCredentialValid({ uid: 'tok-user', tokenId: 'vanished' })).toBe(false);
  });

  test('a node session is verified through the bound store and fails closed when unbound', () => {
    const { store, sid, close } = bootSessions();
    const auth = { uid: 'user-1', tokenId: null, session: { sid, viaNodeId: 'self' } };
    try {
      bindExecSessionVerifier(store)();
      expect(execCredentialValid(auth)).toBe(false);
      const unbind = bindExecSessionVerifier(store, () => 2_000);
      expect(execCredentialValid(auth)).toBe(true);
      expect(execCredentialValid({ ...auth, session: { sid, viaNodeId: 'other' } })).toBe(false);
      store.revoke(sid, 1_500);
      expect(execCredentialValid(auth)).toBe(false);
      unbind();
    } finally {
      close();
    }
  });

  test('a throwing store counts as invalid; a stale unbind keeps the newer binding', () => {
    const boom = {
      verify: () => {
        throw new Error('db down');
      },
    };
    const ok = { verify: () => ({ ok: true }) };
    const auth = { uid: 'u', tokenId: null, session: { sid: 's', viaNodeId: 'self' } };
    const unbindOld = bindExecSessionVerifier(boom as never);
    expect(execCredentialValid(auth)).toBe(false);
    const unbindNew = bindExecSessionVerifier(ok as never);
    unbindOld();
    expect(execCredentialValid(auth)).toBe(true);
    unbindNew();
    expect(execCredentialValid(auth)).toBe(false);
  });
});
