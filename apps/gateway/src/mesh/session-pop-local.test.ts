import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  generateEd25519KeyPair,
  popTargetFromUrl,
  signEd25519,
  signPop,
} from '@vibeterm/shared/auth';
import { POP_HEADER, SET_NAV_TICKET_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { issueNavTicket } from '../auth/nav-ticket';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { users } from '../db/schema';
import { bootMesh, call, challengeAndLogin } from './auth-routes.test';
import { authenticateExecUpgrade } from './exec-ws-guard';
import { MESH_VIA_SELF } from './mesh-deps';
import {
  type SessionMiddlewareDeps,
  authenticateRequest,
  consumeSetSessionForBrowser,
  requireSession,
} from './session-middleware';
import { authenticateApiRequest } from './token-guard';
import { type TokenFixture, bootTokenFixture } from './token-test-support';

const pair = generateEd25519KeyPair();
const signer = (message: Uint8Array) => signEd25519(pair.secretKey, message);

type Fixture = {
  deps: SessionMiddlewareDeps;
  store: NodeSessionStore;
  popSid: string;
  legacySid: string;
  close: () => void;
};

function seed(userId: string, db: ReturnType<typeof createMigratedAuthDb>['db']): void {
  db.insert(users)
    .values({
      id: userId,
      username: `user-${userId}`,
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

function boot(): Fixture {
  const { db, close } = createMigratedAuthDb();
  seed('user-1', db);
  const store = new NodeSessionStore(db);
  const base = {
    userId: 'user-1',
    viaNodeId: MESH_VIA_SELF,
    sessPublicKey: pair.publicKey,
    delegationMethod: 'root' as const,
    now: Date.now(),
  };
  const popSid = store.issue({ ...base, popRequired: true }).sid;
  const legacySid = store.issue(base).sid;
  const deps = { roles: { node: true, relay: false }, nodeSessionStore: store };
  return { deps, store, popSid, legacySid, close };
}

async function signed(method: string, url: string, init: RequestInit & { sid: string }) {
  const proof = await signPop(signer, popTargetFromUrl(method, url));
  const headers = new Headers(init.headers);
  headers.set(POP_HEADER, proof);
  headers.append('cookie', `vibeterm_s_self=${init.sid}`);
  return { proof, req: new Request(url, { ...init, method, headers }) };
}

function plain(method: string, url: string, sid: string, extra: Record<string, string> = {}) {
  return new Request(url, { method, headers: { cookie: `vibeterm_s_self=${sid}`, ...extra } });
}

async function codeOf(res: Response | null): Promise<string | null> {
  if (!res) return null;
  return ((await res.json()) as { code?: string }).code ?? null;
}

let fx: Fixture;
beforeEach(() => {
  fx = boot();
});
afterEach(() => fx.close());

describe('local HTTP enforcement', () => {
  test('GET needs a header proof or a nav ticket; missing → POP_REQUIRED', async () => {
    const url = 'http://localhost/api/files?path=a';
    const missing = authenticateApiRequest(plain('GET', url, fx.popSid), fx.deps);
    expect(missing?.status).toBe(401);
    expect(await codeOf(missing)).toBe('POP_REQUIRED');
    const { req } = await signed('GET', url, { sid: fx.popSid });
    expect(authenticateApiRequest(req, fx.deps)).toBeNull();
    const again = new Request(req.url, { headers: req.headers });
    expect(authenticateApiRequest(again, fx.deps)).toBeNull();
  });

  test('nav ticket: valid passes, expired or issued for another sid fails', async () => {
    const url = 'http://localhost/api/files/raw?path=a.png';
    const key = fx.store.navKey();
    const cookieWith = (ticket: string) =>
      plain('GET', url, fx.popSid, {
        cookie: `vibeterm_s_self=${fx.popSid}; vibeterm_n_self=${ticket}`,
      });
    expect(
      authenticateApiRequest(cookieWith(issueNavTicket(key, fx.popSid, Date.now()).ticket), fx.deps)
    ).toBeNull();
    const expired = issueNavTicket(key, fx.popSid, Date.now() - 11 * 60_000).ticket;
    expect(await codeOf(authenticateApiRequest(cookieWith(expired), fx.deps))).toBe('POP_INVALID');
    const other = issueNavTicket(key, fx.legacySid, Date.now()).ticket;
    expect(await codeOf(authenticateApiRequest(cookieWith(other), fx.deps))).toBe('POP_INVALID');
  });

  test('POST proof is single-use; the same request object may be checked twice', async () => {
    const url = 'http://localhost/api/devices';
    const { req } = await signed('POST', url, { sid: fx.popSid });
    expect(authenticateApiRequest(req, fx.deps)).toBeNull();
    expect(authenticateRequest(req, fx.deps).ok).toBe(true);
    const replay = new Request(url, { method: 'POST', headers: req.headers });
    expect(await codeOf(authenticateApiRequest(replay, fx.deps))).toBe('POP_INVALID');
    const unsigned = await requireSession(
      fx.deps,
      () => new Response('ok')
    )(plain('POST', url, fx.popSid));
    expect(unsigned.status).toBe(401);
    expect(await codeOf(unsigned)).toBe('POP_REQUIRED');
  });

  test('a proof signed for /n/self/... matches the rewritten local path', async () => {
    const proof = await signPop(signer, popTargetFromUrl('DELETE', '/n/self/api/devices/1'));
    const req = plain('DELETE', 'http://localhost/api/devices/1', fx.popSid, {
      [POP_HEADER]: proof,
    });
    expect(authenticateApiRequest(req, fx.deps)).toBeNull();
  });

  test('sessions issued without pop keep working without any proof', () => {
    expect(
      authenticateApiRequest(plain('POST', 'http://localhost/api/x', fx.legacySid), fx.deps)
    ).toBeNull();
    expect(
      authenticateRequest(plain('GET', 'http://localhost/api/x', fx.legacySid), fx.deps).ok
    ).toBe(true);
  });
});

describe('token principal is unaffected', () => {
  let tokens: TokenFixture;
  beforeEach(() => {
    tokens = bootTokenFixture();
  });
  afterEach(() => tokens.close());

  test('a session failing PoP falls back to a valid bearer token', () => {
    const { secret } = tokens.mint(['exec']);
    const req = plain('POST', 'http://localhost/api/exec', fx.popSid, {
      authorization: `Bearer ${secret}`,
    });
    expect(authenticateApiRequest(req, fx.deps)).toBeNull();
    const tokenOnly = new Request('http://localhost/api/exec', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(authenticateApiRequest(tokenOnly, fx.deps)).toBeNull();
  });
});

describe('WebSocket upgrades', () => {
  const upgrade = { upgrade: 'websocket' };

  test('gateway /ws proves once with the pop query (target without pop)', async () => {
    const proof = await signPop(signer, popTargetFromUrl('GET', '/n/self/ws?cid=c1'));
    const ok = plain('GET', `http://localhost/n/self/ws?cid=c1&pop=${proof}`, fx.popSid, upgrade);
    expect(authenticateRequest(ok, fx.deps).ok).toBe(true);
    const missing = authenticateRequest(
      plain('GET', 'http://localhost/ws?cid=c1', fx.popSid, upgrade),
      fx.deps
    );
    expect(missing).toEqual({ ok: false, pop: 'POP_REQUIRED' });
    const wrong = plain('GET', `http://localhost/ws?cid=c2&pop=${proof}`, fx.popSid, upgrade);
    expect(authenticateRequest(wrong, fx.deps)).toEqual({ ok: false, pop: 'POP_INVALID' });
  });

  test('exec WS accepts the header proof (CLI) and rejects a missing one', async () => {
    const url = 'http://localhost/api/exec/ws';
    const proof = await signPop(signer, popTargetFromUrl('GET', url));
    const ok = authenticateExecUpgrade(
      plain('GET', url, fx.popSid, { ...upgrade, [POP_HEADER]: proof }),
      fx.deps
    );
    expect(ok instanceof Response).toBe(false);
    const missing = authenticateExecUpgrade(plain('GET', url, fx.popSid, upgrade), fx.deps);
    expect(missing instanceof Response && missing.status).toBe(401);
    expect(await codeOf(missing as Response)).toBe('POP_REQUIRED');
  });
});

describe('local nav cookie conversion', () => {
  test('x-vibeterm-set-nav becomes vibeterm_n_self and never reaches the browser', () => {
    const req = new Request('https://localhost/api/auth/nav', { method: 'POST' });
    const issued = consumeSetSessionForBrowser(
      req,
      new Response('{}', { headers: { [SET_NAV_TICKET_HEADER]: 'abc;600' } })
    );
    expect(issued.headers.get(SET_NAV_TICKET_HEADER)).toBeNull();
    expect(issued.headers.get('set-cookie')).toBe(
      'vibeterm_n_self=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure'
    );
    const cleared = consumeSetSessionForBrowser(
      new Request('http://localhost/api/auth/logout', { method: 'POST' }),
      new Response('{}', { headers: { [SET_NAV_TICKET_HEADER]: ';0' } })
    );
    expect(cleared.headers.get('set-cookie')).toBe(
      'vibeterm_n_self=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    );
  });
});

describe('auth routes', () => {
  test('login with pop: true marks the session; nav endpoint needs the proof', async () => {
    const mesh = await bootMesh();
    try {
      const sess = generateEd25519KeyPair();
      const popLogin = await challengeAndLogin(mesh.runtime, mesh.boot, { sess, pop: true });
      const legacyLogin = await challengeAndLogin(mesh.runtime, mesh.boot);
      const verify = (sid: string) =>
        mesh.nodeSessionStore.verify(sid, { viaNodeId: MESH_VIA_SELF, now: Date.now() });
      const popRow = verify(popLogin.sid);
      expect(popRow.ok && popRow.session.popRequired).toBe(true);
      const legacyRow = verify(legacyLogin.sid);
      expect(legacyRow.ok && legacyRow.session.popRequired).toBe(false);

      const url = 'http://localhost/api/auth/nav';
      const cookie = `vibeterm_s_self=${popLogin.sid}`;
      const denied = await call(mesh.runtime, url, { method: 'POST', headers: { cookie } });
      expect(denied.status).toBe(401);
      expect(await codeOf(denied)).toBe('POP_REQUIRED');

      const proof = await signPop(
        (m) => signEd25519(sess.secretKey, m),
        popTargetFromUrl('POST', url)
      );
      const res = await call(mesh.runtime, url, {
        method: 'POST',
        headers: { cookie, [POP_HEADER]: proof },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get(SET_NAV_TICKET_HEADER)).toBeNull();
      const setCookie = res.headers.get('set-cookie') ?? '';
      const ticket = /vibeterm_n_self=([^;]+); Path=\/; HttpOnly; SameSite=Lax; Max-Age=600/.exec(
        setCookie
      )?.[1];
      expect(ticket).toBeTruthy();
      const body = (await res.json()) as { expires_at: number };
      expect(body.expires_at).toBeGreaterThan(Date.now());

      const viaTicket = new Request('http://localhost/api/devices', {
        headers: { cookie: `${cookie}; vibeterm_n_self=${ticket}` },
      });
      const deps = { roles: { node: true, relay: false }, nodeSessionStore: mesh.nodeSessionStore };
      expect(authenticateRequest(viaTicket, deps).ok).toBe(true);

      const logout = await call(mesh.runtime, 'http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          cookie,
          [POP_HEADER]: await signPop(
            (m) => signEd25519(sess.secretKey, m),
            popTargetFromUrl('POST', 'http://localhost/api/auth/logout')
          ),
        },
      });
      expect(logout.status).toBe(200);
      expect(logout.headers.get('set-cookie')).toContain('vibeterm_n_self=; Path=/');
    } finally {
      mesh.close();
    }
  });
});
