import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ACCESS_TOKEN_ACTIVE_LIMIT, type CreateAccessTokenRequest } from '@vibeterm/shared';
import { eq } from 'drizzle-orm';
import { accessTokenEvents, accessTokens, users } from '../db/schema';
import {
  AccessTokenLimitError,
  AccessTokenService,
  bindAccessTokenService,
  createAccessToken,
  hashAccessTokenSecret,
  isTokenPrincipal,
  listAccessTokens,
  markTokenPrincipal,
  onAccessTokenRevoked,
  revokeAccessToken,
  verifyAccessToken,
} from './access-tokens';
import { createMigratedAuthDb } from './test-db';
import type { AuthDb } from './types';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

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

const REQ: CreateAccessTokenRequest = {
  name: 'ci',
  scopes: ['exec', 'files'],
  expiresInDays: null,
};

describe('access tokens', () => {
  let db: AuthDb;
  let close: () => void;
  let clock: number;
  let service: AccessTokenService;

  beforeEach(() => {
    const opened = createMigratedAuthDb();
    db = opened.db;
    close = opened.close;
    seedUser(db, 'u1');
    seedUser(db, 'u2');
    clock = 1_800_000_000_000;
    service = new AccessTokenService(db, { now: () => clock });
    bindAccessTokenService(service);
  });

  afterEach(() => {
    bindAccessTokenService(null);
    close();
  });

  function events(tokenId: string): string[] {
    return db
      .select()
      .from(accessTokenEvents)
      .where(eq(accessTokenEvents.tokenId, tokenId))
      .orderBy(accessTokenEvents.id)
      .all()
      .map((row) => row.event);
  }

  test('create returns a vtk_ secret and stores only its sha256', () => {
    const { token, secret } = createAccessToken('u1', REQ, '203.0.113.5');
    expect(secret).toMatch(/^vtk_[A-Za-z0-9_-]{43}$/);
    expect(token).toEqual({
      id: token.id,
      name: 'ci',
      scopes: ['exec', 'files'],
      createdAt: clock,
      expiresAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
    });
    const row = db.select().from(accessTokens).where(eq(accessTokens.id, token.id)).get();
    expect(row?.secretHash).toBe(hashAccessTokenSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(events(token.id)).toEqual(['created']);
  });

  test('expiresInDays becomes an absolute millisecond deadline', () => {
    const { token } = createAccessToken('u1', { ...REQ, expiresInDays: 7 });
    expect(token.expiresAt).toBe(clock + 7 * DAY_MS);
  });

  test('list is per user, excludes revoked, newest first', () => {
    const a = createAccessToken('u1', { ...REQ, name: 'a' }).token;
    clock += 1000;
    const b = createAccessToken('u1', { ...REQ, name: 'b' }).token;
    createAccessToken('u2', { ...REQ, name: 'other' });
    expect(listAccessTokens('u1').map((t) => t.name)).toEqual(['b', 'a']);
    expect(revokeAccessToken('u1', a.id)).toBe(true);
    expect(listAccessTokens('u1').map((t) => t.id)).toEqual([b.id]);
  });

  test('verify accepts a live secret and reports owner and scopes', () => {
    const { token, secret } = createAccessToken('u1', REQ);
    const result = verifyAccessToken(secret, { ip: '203.0.113.9', now: clock + 5 });
    expect(result).toEqual({
      ok: true,
      tokenId: token.id,
      userId: 'u1',
      scopes: ['exec', 'files'],
    });
    const dto = listAccessTokens('u1')[0];
    expect(dto?.lastUsedAt).toBe(clock + 5);
    expect(dto?.lastUsedIp).toBe('203.0.113.9');
  });

  test('verify rejects malformed, unknown, expired and revoked secrets', () => {
    expect(verifyAccessToken('nope')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyAccessToken('vtk_short')).toEqual({ ok: false, reason: 'malformed' });
    const unknown = `vtk_${'A'.repeat(43)}`;
    expect(verifyAccessToken(unknown)).toEqual({ ok: false, reason: 'unknown' });

    const short = createAccessToken('u1', { ...REQ, expiresInDays: 1 });
    expect(verifyAccessToken(short.secret, { now: clock + DAY_MS - 1 }).ok).toBe(true);
    expect(verifyAccessToken(short.secret, { now: clock + DAY_MS })).toEqual({
      ok: false,
      reason: 'expired',
    });

    const gone = createAccessToken('u1', REQ);
    revokeAccessToken('u1', gone.token.id);
    expect(verifyAccessToken(gone.secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  test('revoke is owner-scoped, idempotent-false, audited and notifies listeners', () => {
    const { token } = createAccessToken('u1', REQ);
    const seen: string[] = [];
    const off = onAccessTokenRevoked((id) => seen.push(id));
    expect(revokeAccessToken('u2', token.id)).toBe(false);
    expect(revokeAccessToken('u1', 'missing')).toBe(false);
    expect(seen).toEqual([]);
    expect(revokeAccessToken('u1', token.id, '203.0.113.7')).toBe(true);
    expect(revokeAccessToken('u1', token.id)).toBe(false);
    expect(seen).toEqual([token.id]);
    expect(events(token.id)).toEqual(['created', 'revoked']);
    off();
    const next = createAccessToken('u1', REQ).token;
    revokeAccessToken('u1', next.id);
    expect(seen).toEqual([token.id]);
  });

  test('a throwing revoke listener does not break revocation', () => {
    const { token } = createAccessToken('u1', REQ);
    const off = onAccessTokenRevoked(() => {
      throw new Error('boom');
    });
    expect(revokeAccessToken('u1', token.id)).toBe(true);
    off();
  });

  test('active limit counts live tokens only', () => {
    for (let i = 0; i < ACCESS_TOKEN_ACTIVE_LIMIT; i += 1) {
      createAccessToken('u1', { ...REQ, name: `t${i}` });
    }
    expect(() => createAccessToken('u1', REQ)).toThrow(AccessTokenLimitError);
    expect(() => createAccessToken('u2', REQ)).not.toThrow();
    const first = listAccessTokens('u1')[0];
    if (!first) throw new Error('expected a token');
    revokeAccessToken('u1', first.id);
    expect(() => createAccessToken('u1', REQ)).not.toThrow();
  });

  test('expired tokens do not count toward the active limit', () => {
    for (let i = 0; i < ACCESS_TOKEN_ACTIVE_LIMIT; i += 1) {
      createAccessToken('u1', { ...REQ, name: `t${i}`, expiresInDays: 1 });
    }
    clock += 2 * DAY_MS;
    expect(() => createAccessToken('u1', REQ)).not.toThrow();
  });

  test('used audit is throttled per token and ip for ten minutes', () => {
    const { token, secret } = createAccessToken('u1', REQ);
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 1 });
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 2 * MIN_MS });
    expect(events(token.id)).toEqual(['created', 'used']);
    verifyAccessToken(secret, { ip: '203.0.113.2', now: clock + 3 * MIN_MS });
    expect(events(token.id)).toEqual(['created', 'used', 'used']);
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 11 * MIN_MS });
    expect(events(token.id)).toEqual(['created', 'used', 'used', 'used']);
  });

  test('used audit throttle survives a restart', () => {
    const { token, secret } = createAccessToken('u1', REQ);
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 1 });
    const restarted = new AccessTokenService(db, { now: () => clock });
    bindAccessTokenService(restarted);
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + MIN_MS });
    expect(events(token.id)).toEqual(['created', 'used']);
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 11 * MIN_MS });
    expect(events(token.id)).toEqual(['created', 'used', 'used']);
  });

  test('last_used is written at most once a minute unless the ip changes', () => {
    const { secret } = createAccessToken('u1', REQ);
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 1 });
    verifyAccessToken(secret, { ip: '203.0.113.1', now: clock + 30_000 });
    expect(listAccessTokens('u1')[0]?.lastUsedAt).toBe(clock + 1);
    verifyAccessToken(secret, { ip: '203.0.113.2', now: clock + 40_000 });
    expect(listAccessTokens('u1')[0]).toMatchObject({
      lastUsedAt: clock + 40_000,
      lastUsedIp: '203.0.113.2',
    });
    verifyAccessToken(secret, { ip: '203.0.113.2', now: clock + 40_000 + MIN_MS });
    expect(listAccessTokens('u1')[0]?.lastUsedAt).toBe(clock + 40_000 + MIN_MS);
  });

  test('deleting the user cascades to their tokens', () => {
    const { secret } = createAccessToken('u1', REQ);
    db.delete(users).where(eq(users.id, 'u1')).run();
    expect(verifyAccessToken(secret)).toEqual({ ok: false, reason: 'unknown' });
  });

  test('token principal marker is per request', () => {
    const req = new Request('http://localhost/api/x');
    expect(isTokenPrincipal(req)).toBe(false);
    markTokenPrincipal(req, { tokenId: 't', userId: 'u1' });
    expect(isTokenPrincipal(req)).toBe(true);
    expect(isTokenPrincipal(new Request('http://localhost/api/x'))).toBe(false);
  });
});
