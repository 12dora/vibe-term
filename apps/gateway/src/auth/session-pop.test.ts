import { describe, expect, test } from 'bun:test';
import {
  generateEd25519KeyPair,
  popTargetFromUrl,
  signEd25519,
  signPop,
} from '@vibeterm/shared/auth';
import { POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { issueNavTicket } from './nav-ticket';
import {
  POP_INVALID,
  POP_NONCE_TTL_MS,
  POP_REQUIRED,
  type PopEvidence,
  PopNonceCache,
  type PopSession,
  WsPopResume,
  enforceRequestPop,
  evaluatePop,
  requestPopEvidence,
  requestPopProven,
} from './session-pop';

const NOW = 1_800_000_000_000;
const pair = generateEd25519KeyPair();
const signer = (message: Uint8Array) => signEd25519(pair.secretKey, message);
const navKey = new Uint8Array(32).fill(7);
const session: PopSession = { sid: 'sid-a', popRequired: true, sessPublicKey: pair.publicKey };

function evidence(method: string, url: string, extra: Partial<PopEvidence> = {}): PopEvidence {
  return {
    target: popTargetFromUrl(method, url),
    proof: null,
    nav: null,
    upgrade: false,
    ...extra,
  };
}

function deps(nonces = new PopNonceCache()) {
  return { now: NOW, navKey: () => navKey, nonces };
}

describe('evaluatePop policy', () => {
  test('sessions without pop_required are never asked for a proof', () => {
    const legacy = { ...session, popRequired: false };
    expect(evaluatePop(legacy, evidence('POST', '/api/x'), deps())).toBeNull();
    expect(evaluatePop(legacy, null, deps())).toBeNull();
  });

  test('unsafe methods need a header proof whose nonce is used once', async () => {
    const nonces = new PopNonceCache();
    const proof = await signPop(signer, popTargetFromUrl('POST', '/api/x?a=1'), NOW);
    const ev = evidence('POST', '/api/x?a=1', { proof });
    expect(evaluatePop(session, evidence('POST', '/api/x'), deps(nonces))).toBe(POP_REQUIRED);
    expect(evaluatePop(session, ev, deps(nonces))).toBeNull();
    expect(evaluatePop(session, ev, deps(nonces))).toBe(POP_INVALID);
    expect(
      evaluatePop(session, { ...ev, target: popTargetFromUrl('POST', '/api/y') }, deps())
    ).toBe(POP_INVALID);
  });

  test('a proof signed through an entry prefix verifies against the target path', async () => {
    const proof = await signPop(signer, popTargetFromUrl('PUT', `/n/${'b'.repeat(32)}/api/x`), NOW);
    expect(evaluatePop(session, evidence('PUT', '/api/x', { proof }), deps())).toBeNull();
  });

  test('GET accepts a replayed header proof or a nav ticket bound to the sid', async () => {
    const proof = await signPop(signer, popTargetFromUrl('GET', '/api/files'), NOW);
    const ev = evidence('GET', '/api/files', { proof });
    const nonces = new PopNonceCache();
    expect(evaluatePop(session, ev, deps(nonces))).toBeNull();
    expect(evaluatePop(session, ev, deps(nonces))).toBeNull();
    expect(evaluatePop(session, evidence('GET', '/api/files'), deps())).toBe(POP_REQUIRED);
    const own = issueNavTicket(navKey, session.sid, NOW).ticket;
    const other = issueNavTicket(navKey, 'sid-b', NOW).ticket;
    const expired = issueNavTicket(navKey, session.sid, NOW - 11 * 60 * 1000).ticket;
    expect(evaluatePop(session, evidence('GET', '/api/files', { nav: own }), deps())).toBeNull();
    expect(evaluatePop(session, evidence('HEAD', '/api/files', { nav: own }), deps())).toBeNull();
    expect(evaluatePop(session, evidence('GET', '/api/files', { nav: other }), deps())).toBe(
      POP_INVALID
    );
    expect(evaluatePop(session, evidence('GET', '/api/files', { nav: expired }), deps())).toBe(
      POP_INVALID
    );
    expect(evaluatePop(session, evidence('POST', '/api/files', { nav: own }), deps())).toBe(
      POP_REQUIRED
    );
  });

  test('stale proofs are rejected', async () => {
    const proof = await signPop(signer, popTargetFromUrl('GET', '/api/x'), NOW - 61_000);
    expect(evaluatePop(session, evidence('GET', '/api/x', { proof }), deps())).toBe(POP_INVALID);
  });

  test('upgrades sign GET + path + query without pop; resumed streams are accepted', async () => {
    const proof = await signPop(signer, popTargetFromUrl('GET', '/ws?cid=c1'), NOW - 120_000);
    const ev = evidence('GET', `/ws?cid=c1&pop=${proof}`, { proof, upgrade: true });
    expect(evaluatePop(session, ev, deps())).toBe(POP_INVALID);
    expect(evaluatePop(session, { ...ev, proof: null }, deps())).toBe(POP_REQUIRED);
    const resumed = {
      ...deps(),
      acceptResumed: (sid: string, p: string) => sid === 'sid-a' && p === proof,
    };
    expect(evaluatePop(session, ev, resumed)).toBeNull();
  });

  test('entry-proven inbound calls and OPTIONS skip the proof', () => {
    expect(
      evaluatePop(session, evidence('POST', '/api/x', { entryProven: true }), deps())
    ).toBeNull();
    expect(evaluatePop(session, evidence('OPTIONS', '/api/x'), deps())).toBeNull();
  });
});

describe('PopNonceCache', () => {
  test('expires after the TTL and stays bounded', () => {
    const cache = new PopNonceCache(POP_NONCE_TTL_MS, 3);
    expect(cache.claim('s', 'n1', 0)).toBe(true);
    expect(cache.claim('s', 'n1', 1)).toBe(false);
    expect(cache.claim('t', 'n1', 1)).toBe(true);
    expect(cache.claim('s', 'n1', POP_NONCE_TTL_MS + 1)).toBe(true);
    for (let i = 0; i < 10; i += 1) cache.claim('s', `x${i}`, POP_NONCE_TTL_MS + 2);
    expect(cache.size).toBe(3);
  });
});

describe('WsPopResume', () => {
  test('accepts a proof while its stream lives and for the grace window after', () => {
    let clock = 0;
    const resume = new WsPopResume(1_000, 10, () => clock);
    expect(resume.accepts('s', 'p', 0)).toBe(false);
    const release = resume.attach('s', 'p');
    clock = 50_000;
    expect(resume.accepts('s', 'p', clock)).toBe(true);
    release();
    release();
    expect(resume.accepts('s', 'p', clock + 999)).toBe(true);
    expect(resume.accepts('s', 'p', clock + 1_000)).toBe(false);
    expect(resume.accepts('other', 'p', clock)).toBe(false);
  });

  test('evicts idle entries first when full', () => {
    const resume = new WsPopResume(0, 2, () => 10);
    resume.attach('a', 'p')();
    resume.attach('b', 'p');
    resume.attach('c', 'p');
    expect(resume.size).toBe(2);
    expect(resume.accepts('b', 'p', 10)).toBe(true);
    expect(resume.accepts('c', 'p', 10)).toBe(true);
  });
});

describe('request evidence', () => {
  test('reads the header, the upgrade query and the self nav cookie', () => {
    const ws = new Request('http://localhost/n/self/ws?cid=1&pop=v1.a', {
      headers: { upgrade: 'websocket', cookie: 'vibeterm_n_self=tkt' },
    });
    expect(requestPopEvidence(ws)).toEqual({
      target: { method: 'GET', path: '/ws', query: 'cid=1' },
      proof: 'v1.a',
      nav: 'tkt',
      upgrade: true,
    });
    const post = new Request('http://localhost/api/x?pop=ignored', {
      method: 'POST',
      headers: { [POP_HEADER]: 'v1.h' },
    });
    expect(requestPopEvidence(post).proof).toBe('v1.h');
    expect(requestPopEvidence(new Request('http://localhost/api/x?pop=q')).proof).toBeNull();
  });

  test('a request is judged once per sid so a second guard does not see a replay', async () => {
    const url = 'http://localhost/api/x';
    const proof = await signPop(signer, popTargetFromUrl('POST', url), Date.now());
    const req = new Request(url, { method: 'POST', headers: { [POP_HEADER]: proof } });
    const d = { now: Date.now(), navKey: () => navKey, nonces: new PopNonceCache() };
    expect(enforceRequestPop(req, session, d)).toBeNull();
    expect(enforceRequestPop(req, session, d)).toBeNull();
    expect(requestPopProven(req)).toBe(true);
    const copy = new Request(url, { method: 'POST', headers: { [POP_HEADER]: proof } });
    expect(enforceRequestPop(copy, session, d)).toBe(POP_INVALID);
    expect(requestPopProven(copy)).toBe(false);
  });
});
