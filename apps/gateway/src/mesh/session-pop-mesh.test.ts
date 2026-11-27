import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  generateEd25519KeyPair,
  popTargetFromUrl,
  signEd25519,
  signPop,
} from '@vibeterm/shared/auth';
import {
  NAV_TICKET_HEADER,
  POP_HEADER,
  SET_NAV_TICKET_HEADER,
} from '@vibeterm/shared/http/mesh-headers';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { issueNavTicket } from '../auth/nav-ticket';
import { NodeSessionStore } from '../auth/node-session-store';
import {
  POP_ENTRY_PROVEN_HEADER,
  PopNonceCache,
  WsPopResume,
  enforceRequestPop,
  popLoginAllowed,
  streamUpgradeEvidence,
} from '../auth/session-pop';
import { createMigratedAuthDb } from '../auth/test-db';
import { users } from '../db/schema';
import { verifyExecCredential } from './exec-credential';
import { execForwardCloseFor } from './exec-forward-pump';
import { applyAuthPolicy } from './forwarder-auth-policy';
import {
  copyUpstreamHeaders,
  filterRequestHeaders,
  stampForwardedAuthHeaders,
  stampedAuthorizedHeaders,
} from './forwarder-headers';
import { upgradePopOf } from './forwarder-ws-upgrade';
import { authorizeHttpStream, verifyStreamAuth } from './stream-auth';
import { acceptHttpStream, openHttpStream, openWsStream } from './stream-targets';

const ENTRY = 'entry-a';
const TARGET = 'cd'.repeat(16);
const pair = generateEd25519KeyPair();
const signer = (message: Uint8Array) => signEd25519(pair.secretKey, message);

type Fixture = { store: NodeSessionStore; popSid: string; legacySid: string; close: () => void };

function boot(): Fixture {
  const { db, close } = createMigratedAuthDb();
  db.insert(users)
    .values({
      id: 'user-1',
      username: 'user-1',
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
  const base = {
    userId: 'user-1',
    viaNodeId: ENTRY,
    sessPublicKey: pair.publicKey,
    delegationMethod: 'root' as const,
    now: Date.now(),
  };
  return {
    store,
    popSid: store.issue({ ...base, popRequired: true }).sid,
    legacySid: store.issue(base).sid,
    close,
  };
}

let fx: Fixture;
beforeEach(() => {
  fx = boot();
});
afterEach(() => fx.close());

/** 目标节点 B：真实会话表 + 计数的 dispatch。 */
function targetLink(): { link: LinkSession; dispatched: Request[] } {
  const [a, b] = createInMemoryLinkPair();
  const dispatched: Request[] = [];
  b.onStream((stream) => {
    void acceptHttpStream(stream, {
      peerNodeId: ENTRY,
      sessionStore: fx.store,
      dispatchHttp: async (req) => {
        dispatched.push(req);
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      },
    });
  });
  return { link: a, dispatched };
}

/** 入口 A 对浏览器请求做的头处理（与 forwarder.forwardHttp 相同的三步）。 */
function entryHeaders(req: Request): Record<string, string> {
  const headers = filterRequestHeaders(req);
  stampForwardedAuthHeaders(headers, req, new URL(req.url).pathname, null, TARGET);
  return headers;
}

async function forward(
  link: LinkSession,
  method: string,
  path: string,
  query: string,
  headers: Record<string, string>,
  auth: string
) {
  const res = await openHttpStream(link, {
    method,
    path,
    query,
    headers,
    origin: 'http://localhost',
    auth,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('mesh inbound HTTP (target node)', () => {
  test('a proof signed by the browser for /n/<B>/... and forwarded by the entry is accepted', async () => {
    const { link, dispatched } = targetLink();
    const browserUrl = `http://entry.example.com/n/${TARGET}/api/files?path=a`;
    const proof = await signPop(signer, popTargetFromUrl('POST', browserUrl));
    const req = new Request(browserUrl, { method: 'POST', headers: { [POP_HEADER]: proof } });
    const headers = entryHeaders(req);
    expect(headers[POP_HEADER]).toBe(proof);
    const ok = await forward(link, 'POST', '/api/files', '?path=a', headers, fx.popSid);
    expect(ok.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    const replay = await forward(link, 'POST', '/api/files', '?path=a', headers, fx.popSid);
    expect(replay).toEqual({ status: 401, body: { code: 'POP_INVALID', error: 'POP_INVALID' } });
    expect(dispatched).toHaveLength(1);
  });

  test('without a proof → 401 POP_REQUIRED and nothing is dispatched', async () => {
    const { link, dispatched } = targetLink();
    const res = await forward(link, 'GET', '/api/devices', '', {}, fx.popSid);
    expect(res).toEqual({ status: 401, body: { code: 'POP_REQUIRED', error: 'POP_REQUIRED' } });
    expect(dispatched).toHaveLength(0);
  });

  test('GET replays (entry failover) pass; nav tickets come from the entry cookie only', async () => {
    const { link, dispatched } = targetLink();
    const proof = await signPop(signer, popTargetFromUrl('GET', '/api/devices'));
    for (let i = 0; i < 2; i += 1) {
      expect(
        (await forward(link, 'GET', '/api/devices', '', { [POP_HEADER]: proof }, fx.popSid)).status
      ).toBe(200);
    }
    const ticket = issueNavTicket(fx.store.navKey(), fx.popSid, Date.now()).ticket;
    const viaCookie = new Request(`http://entry.example.com/n/${TARGET}/api/files/raw`, {
      headers: { cookie: `vibeterm_n_${TARGET}=${ticket}`, [NAV_TICKET_HEADER]: 'forged' },
    });
    const headers = entryHeaders(viaCookie);
    expect(headers[NAV_TICKET_HEADER]).toBe(ticket);
    expect((await forward(link, 'GET', '/api/files/raw', '', headers, fx.popSid)).status).toBe(200);
    const forged = entryHeaders(
      new Request('http://entry.example.com/x', { headers: { [NAV_TICKET_HEADER]: ticket } })
    );
    expect(forged[NAV_TICKET_HEADER]).toBeUndefined();
    expect(dispatched).toHaveLength(3);
  });

  test('legacy sessions without pop are unaffected', async () => {
    const { link } = targetLink();
    expect((await forward(link, 'POST', '/api/x', '', {}, fx.legacySid)).status).toBe(200);
  });

  test('public auth / share-access paths degrade to anonymous instead of failing', () => {
    const headers: Record<string, string> = {};
    expect(
      authorizeHttpStream(
        fx.popSid,
        'GET',
        '/api/auth/mode',
        { ...streamCtx(), pop: { evidence: null } },
        headers
      )
    ).toEqual({ ok: true, uid: null });
    expect(
      authorizeHttpStream(
        fx.popSid,
        'GET',
        '/api/share-access/s1',
        { ...streamCtx(), pop: { evidence: null } },
        headers
      )
    ).toEqual({ ok: true, uid: null });
  });

  test('server-initiated calls carry the entry marker only after the entry verified PoP', async () => {
    const { link, dispatched } = targetLink();
    const url = 'http://localhost/api/system/upgrade/remote';
    const unproven = new Request(url, { method: 'POST' });
    const plain = stampedAuthorizedHeaders(unproven, { [POP_ENTRY_PROVEN_HEADER]: '1' }, fx.popSid);
    expect(plain[POP_ENTRY_PROVEN_HEADER]).toBeUndefined();
    expect((await forward(link, 'POST', '/api/system/upgrade', '', plain, fx.popSid)).status).toBe(
      401
    );

    const proof = await signPop(signer, popTargetFromUrl('POST', url));
    const proven = new Request(url, { method: 'POST', headers: { [POP_HEADER]: proof } });
    const session = { sid: 'entry-sid', popRequired: true, sessPublicKey: pair.publicKey };
    expect(
      enforceRequestPop(proven, session, {
        now: Date.now(),
        navKey: () => new Uint8Array(32),
        nonces: new PopNonceCache(),
      })
    ).toBeNull();
    const vouched = stampedAuthorizedHeaders(proven, {}, fx.popSid);
    expect(vouched[POP_ENTRY_PROVEN_HEADER]).toBe(
      Buffer.from(pair.publicKey).toString('base64url')
    );
    expect(
      stampedAuthorizedHeaders(proven, {}, 'tok:vtk_x')[POP_ENTRY_PROVEN_HEADER]
    ).toBeUndefined();
    expect(
      (await forward(link, 'POST', '/api/system/upgrade', '', vouched, fx.popSid)).status
    ).toBe(200);
    expect(dispatched.at(-1)?.headers.get(POP_ENTRY_PROVEN_HEADER)).toBeNull();
  });

  test('a vouch from an entry session of another login does not unlock the target session', async () => {
    const { link, dispatched } = targetLink();
    const url = 'http://localhost/api/system/upgrade/remote';
    const attacker = generateEd25519KeyPair();
    const proof = await signPop(
      (m) => signEd25519(attacker.secretKey, m),
      popTargetFromUrl('POST', url)
    );
    const req = new Request(url, { method: 'POST', headers: { [POP_HEADER]: proof } });
    const own = { sid: 'attacker-sid', popRequired: true, sessPublicKey: attacker.publicKey };
    const d = { now: Date.now(), navKey: () => new Uint8Array(32), nonces: new PopNonceCache() };
    expect(enforceRequestPop(req, own, d)).toBeNull();
    const headers = stampedAuthorizedHeaders(req, {}, fx.popSid);
    expect(headers[POP_ENTRY_PROVEN_HEADER]).toBeTruthy();
    const res = await forward(link, 'POST', '/api/system/upgrade', '', headers, fx.popSid);
    expect(res).toEqual({ status: 401, body: { code: 'POP_REQUIRED', error: 'POP_REQUIRED' } });
    expect(dispatched).toHaveLength(0);
  });

  test('new entries mark every stream as PoP-forwarding; streams from old entries are not', async () => {
    const { link, dispatched } = targetLink();
    await forward(link, 'GET', '/api/auth/mode', '', {}, fx.legacySid);
    const fromNew = dispatched.at(-1);
    expect(fromNew && popLoginAllowed(fromNew, ENTRY, true)).toBe(true);
    const legacyOpen = { method: 'GET', path: '/api/auth/mode', origin: 'http://localhost' };
    const stream = await link.openStream(new TextEncoder().encode(JSON.stringify(legacyOpen)));
    await stream.end();
    for (let i = 0; i < 50 && dispatched.length < 2; i += 1) await Bun.sleep(5);
    const fromOld = dispatched.at(-1);
    expect(dispatched).toHaveLength(2);
    expect(fromOld && popLoginAllowed(fromOld, ENTRY, true)).toBe(false);
  });

  test('the browser cannot send the entry marker or nav headers through the entry', () => {
    const req = new Request('http://entry.example.com/x', {
      headers: {
        [POP_ENTRY_PROVEN_HEADER]: '1',
        [SET_NAV_TICKET_HEADER]: 'a;1',
        [POP_HEADER]: 'v1.kept',
      },
    });
    expect(filterRequestHeaders(req)).toEqual({ [POP_HEADER]: 'v1.kept' });
  });
});

function streamCtx() {
  return { peerNodeId: ENTRY, sessionStore: fx.store };
}

describe('mesh WS / exec streams', () => {
  test('the entry passes ?pop= (or the CLI header) and the query without pop', async () => {
    const url = new URL(`http://entry.example.com/n/${TARGET}/ws?cid=c1&pop=v1.q`);
    expect(upgradePopOf(new Request(url), url)).toEqual({ proof: 'v1.q', query: 'cid=c1' });
    const cli = new URL(`http://entry.example.com/n/${TARGET}/api/exec/ws`);
    expect(upgradePopOf(new Request(cli, { headers: { [POP_HEADER]: 'v1.h' } }), cli)).toEqual({
      proof: 'v1.h',
      query: '',
    });
    expect(upgradePopOf(new Request(cli), cli)).toBeUndefined();

    const [a, b] = createInMemoryLinkPair();
    const opened = new Promise<Uint8Array>((resolve) => b.onStream((s) => resolve(s.openPayload)));
    await openWsStream(a, fx.popSid, 'c1', undefined, { proof: 'v1.q', query: 'cid=c1' });
    expect(JSON.parse(new TextDecoder().decode(await opened))).toEqual({
      type: 'ws',
      auth: fx.popSid,
      cid: 'c1',
      pop: 'v1.q',
      popQuery: 'cid=c1',
      popForwarding: true,
      idleClose: true,
    });
  });

  test('target verifies the upgrade proof; missing → 4401 POP_REQUIRED; failover reuse within the window', async () => {
    const proof = await signPop(signer, popTargetFromUrl('GET', `/n/${TARGET}/ws?cid=c1`));
    const evidence = streamUpgradeEvidence('/ws', { pop: proof, popQuery: 'cid=c1' });
    const ok = verifyStreamAuth(fx.popSid, '/ws', streamCtx(), null, { evidence });
    expect(ok).toEqual({ ok: true, uid: 'user-1', popProof: proof });
    const missing = verifyStreamAuth(fx.popSid, '/ws', streamCtx(), null, {
      evidence: streamUpgradeEvidence('/ws', {}),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.pop).toBe('POP_REQUIRED');
      expect(missing.wsClose).toBeTruthy();
    }

    const later = { ...streamCtx(), now: () => Date.now() + 5 * 60_000 };
    const resume = new WsPopResume();
    const accept = (sid: string, p: string, q: string) => resume.accepts(sid, p, q, Date.now());
    expect(
      verifyStreamAuth(fx.popSid, '/ws', later, null, { evidence, acceptResumed: accept }).ok
    ).toBe(false);
    const release = resume.attach(fx.popSid, proof, 'cid=c2');
    expect(
      verifyStreamAuth(fx.popSid, '/ws', later, null, { evidence, acceptResumed: accept }).ok
    ).toBe(false);
    release();
    const sameCid = resume.attach(fx.popSid, proof, 'cid=c1');
    expect(
      verifyStreamAuth(fx.popSid, '/ws', later, null, { evidence, acceptResumed: accept }).ok
    ).toBe(true);
    sameCid();
    expect(verifyStreamAuth(fx.legacySid, '/ws', streamCtx(), null, { evidence: null })).toEqual({
      ok: true,
      uid: 'user-1',
    });
  });

  test('exec streams need the proof for pop sessions; the entry keeps the POP close reason', async () => {
    const proof = await signPop(signer, popTargetFromUrl('GET', '/api/exec/ws'));
    const ctx = { ...streamCtx(), pop: streamUpgradeEvidence('/api/exec/ws', { pop: proof }) };
    expect(verifyExecCredential(fx.popSid, ctx).ok).toBe(true);
    expect(verifyExecCredential(fx.popSid, streamCtx())).toEqual({
      ok: false,
      reason: 'POP_REQUIRED',
    });
    expect(verifyExecCredential(fx.legacySid, streamCtx()).ok).toBe(true);
    expect(execForwardCloseFor({ reason: 'rst', message: 'auth:POP_INVALID' })).toEqual({
      code: 4401,
      reason: 'POP_INVALID',
    });
    expect(execForwardCloseFor({ reason: 'rst', message: 'auth:expired' }).reason).toBe(
      'NODE_LOGIN_REQUIRED'
    );
  });
});

describe('entry response conversions', () => {
  const browserReq = () =>
    new Request(`https://entry.example.com/n/${TARGET}/api/auth/nav`, { method: 'POST' });

  test('x-vibeterm-set-nav becomes vibeterm_n_<B> and is stripped; ;0 clears', async () => {
    const upstream = new Response('{}', { headers: { [SET_NAV_TICKET_HEADER]: 'tkt;600' } });
    const headers = copyUpstreamHeaders(upstream, browserReq());
    expect(headers.get(SET_NAV_TICKET_HEADER)).toBeNull();
    await applyAuthPolicy(browserReq(), headers, upstream, TARGET);
    expect(headers.get('set-cookie')).toBe(
      `vibeterm_n_${TARGET}=tkt; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`
    );
    const cleared = new Headers();
    await applyAuthPolicy(
      browserReq(),
      cleared,
      new Response('{}', { headers: { [SET_NAV_TICKET_HEADER]: ';0' } }),
      TARGET
    );
    expect(cleared.get('set-cookie')).toContain(`vibeterm_n_${TARGET}=; Path=/`);
  });

  test('POP 401s pass through instead of becoming NODE_LOGIN_REQUIRED and keep the cookie', async () => {
    const req = new Request(`https://entry.example.com/n/${TARGET}/api/x`, {
      headers: { cookie: `vibeterm_s_${TARGET}=sid` },
    });
    const upstream = new Response(JSON.stringify({ code: 'POP_INVALID', error: 'POP_INVALID' }), {
      status: 401,
    });
    const res = await applyAuthPolicy(req, new Headers(), upstream, TARGET);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({
      code: 'POP_INVALID',
      error: 'POP_INVALID',
      nodeId: TARGET,
    });
    expect(res?.headers.get('set-cookie')).toBeNull();
  });
});
