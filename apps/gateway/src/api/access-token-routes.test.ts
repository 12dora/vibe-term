import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ACCESS_TOKEN_ACTIVE_LIMIT } from '@vibeterm/shared';
import {
  AccessTokenService,
  bindAccessTokenService,
  markTokenPrincipal,
  verifyAccessToken,
} from '../auth/access-tokens';
import { recordsOr405 } from '../auth/login-records-routes';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { users } from '../db/schema';
import { MESH_VIA_SELF } from '../mesh/mesh-deps';
import { requestDispatchContext } from '../mesh/types';
import { handleApiRequest } from './index';

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

function call(
  method: string,
  path: string,
  opts: { uid?: string | null; body?: unknown; token?: boolean } = {}
): Response | Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  if ('uid' in opts) {
    requestDispatchContext.set(req, { uid: opts.uid ?? null, viaNodeId: MESH_VIA_SELF });
  }
  if (opts.token) markTokenPrincipal(req, { tokenId: 'tok', userId: opts.uid ?? 'u1' });
  return handleApiRequest(req);
}

const VALID = { name: 'ci runner', scopes: ['exec'], expiresInDays: 30 };

describe('access token routes', () => {
  let db: AuthDb;
  let close: () => void;

  beforeEach(() => {
    const opened = createMigratedAuthDb();
    db = opened.db;
    close = opened.close;
    seedUser(db, 'u1');
    seedUser(db, 'u2');
    bindAccessTokenService(new AccessTokenService(db));
  });

  afterEach(() => {
    bindAccessTokenService(null);
    close();
  });

  test('create returns 201 with token and one-time secret, list never repeats it', async () => {
    const res = await call('POST', '/api/auth/tokens', { uid: 'u1', body: VALID });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      token: { id: string; name: string; scopes: string[]; expiresAt: number | null };
      secret: string;
    };
    expect(created.secret).toMatch(/^vtk_/);
    expect(created.token.name).toBe('ci runner');
    expect(created.token.scopes).toEqual(['exec']);
    expect(created.token.expiresAt).toBeGreaterThan(Date.now());
    expect(verifyAccessToken(created.secret).ok).toBe(true);

    const listed = await call('GET', '/api/auth/tokens', { uid: 'u1' });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(created.secret);
    expect(JSON.parse(text)).toEqual({
      tokens: [{ ...created.token, lastUsedAt: expect.any(Number) }],
    });
  });

  test('expiresInDays may be null or omitted (never expires)', async () => {
    for (const body of [
      { name: 'a', scopes: ['files'], expiresInDays: null },
      { name: 'b', scopes: ['forward'] },
    ]) {
      const res = await call('POST', '/api/auth/tokens', { uid: 'u1', body });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { token: { expiresAt: unknown } }).token.expiresAt).toBeNull();
    }
  });

  test('rejects invalid bodies with 400 invalid_body', async () => {
    const bad: unknown[] = [
      {},
      { ...VALID, name: '' },
      { ...VALID, name: '   ' },
      { ...VALID, name: 'x'.repeat(65) },
      { ...VALID, name: 5 },
      { ...VALID, scopes: [] },
      { ...VALID, scopes: ['exec', 'exec'] },
      { ...VALID, scopes: ['root'] },
      { ...VALID, scopes: 'exec' },
      { ...VALID, expiresInDays: 0 },
      { ...VALID, expiresInDays: 3651 },
      { ...VALID, expiresInDays: 1.5 },
      { ...VALID, expiresInDays: '7' },
    ];
    for (const body of bad) {
      const res = await call('POST', '/api/auth/tokens', { uid: 'u1', body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('invalid_body');
    }
    const notJson = new Request('http://localhost/api/auth/tokens', {
      method: 'POST',
      body: 'nope',
    });
    requestDispatchContext.set(notJson, { uid: 'u1', viaNodeId: MESH_VIA_SELF });
    expect((await handleApiRequest(notJson)).status).toBe(400);
  });

  test('name is trimmed', async () => {
    const res = await call('POST', '/api/auth/tokens', {
      uid: 'u1',
      body: { ...VALID, name: '  laptop  ' },
    });
    expect(((await res.json()) as { token: { name: string } }).token.name).toBe('laptop');
  });

  test('51st active token returns 409 token_limit', async () => {
    for (let i = 0; i < ACCESS_TOKEN_ACTIVE_LIMIT; i += 1) {
      const res = await call('POST', '/api/auth/tokens', {
        uid: 'u1',
        body: { ...VALID, name: `t${i}` },
      });
      expect(res.status).toBe(201);
    }
    const over = await call('POST', '/api/auth/tokens', { uid: 'u1', body: VALID });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { code: string }).code).toBe('token_limit');
    const other = await call('POST', '/api/auth/tokens', { uid: 'u2', body: VALID });
    expect(other.status).toBe(201);
  });

  test('delete revokes with 204, then 404; other users cannot see or revoke', async () => {
    const created = (await (
      await call('POST', '/api/auth/tokens', { uid: 'u1', body: VALID })
    ).json()) as { token: { id: string }; secret: string };
    const id = created.token.id;

    expect((await call('DELETE', `/api/auth/tokens/${id}`, { uid: 'u2' })).status).toBe(404);
    const otherList = (await (await call('GET', '/api/auth/tokens', { uid: 'u2' })).json()) as {
      tokens: unknown[];
    };
    expect(otherList.tokens).toEqual([]);

    const res = await call('DELETE', `/api/auth/tokens/${id}`, { uid: 'u1' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(verifyAccessToken(created.secret)).toEqual({ ok: false, reason: 'revoked' });
    expect((await call('DELETE', `/api/auth/tokens/${id}`, { uid: 'u1' })).status).toBe(404);
    const list = (await (await call('GET', '/api/auth/tokens', { uid: 'u1' })).json()) as {
      tokens: unknown[];
    };
    expect(list.tokens).toEqual([]);
  });

  test('token principals get 403 TOKEN_SCOPE on every method', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/auth/tokens'],
      ['POST', '/api/auth/tokens', VALID],
      ['DELETE', '/api/auth/tokens/whatever'],
    ];
    for (const [method, path, body] of calls) {
      const res = await call(method, path, { uid: 'u1', token: true, body });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('TOKEN_SCOPE');
    }
  });

  test('requests without a user are 401', async () => {
    expect((await call('GET', '/api/auth/tokens')).status).toBe(401);
    expect((await call('GET', '/api/auth/tokens', { uid: null })).status).toBe(401);
    expect((await call('POST', '/api/auth/tokens', { uid: null, body: VALID })).status).toBe(401);
  });

  test('the mesh auth surface falls through for token paths and still 405s other /api/auth paths', async () => {
    const session = () => new Response('unexpected');
    const tokens = recordsOr405(new Request('http://localhost/api/auth/tokens'), session);
    expect(tokens).toBeNull();
    const one = recordsOr405(new Request('http://localhost/api/auth/tokens/x'), session);
    expect(one).toBeNull();
    const other = await recordsOr405(new Request('http://localhost/api/auth/nope'), session);
    expect(other?.status).toBe(405);
  });
});
