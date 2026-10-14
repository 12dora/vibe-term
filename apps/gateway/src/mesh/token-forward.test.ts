import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import { FakeLinkStream } from '../exec/channel/test-link-stream';
import { FakePeers, FakeStreams, bootMesh, challengeAndLogin } from './auth-routes.test';
import { decodeJsonBytes, encodeJsonBytes } from './ctl';
import { verifyExecCredential } from './exec-credential';
import { acceptExecStream } from './exec-stream-target';
import { authenticateExecUpgrade } from './exec-ws-guard';
import { forwardedAuthFor } from './forwarder-credential';
import {
  type ExecForwardSocketData,
  execForwardCredential,
  execForwardWebsocket,
} from './forwarder-exec-upgrade';
import { ENTRY_CLIENT_IP_HEADER, stampedAuthorizedHeaders } from './forwarder-headers';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';
import { authorizeHttpStream, verifyStreamAuth } from './stream-auth';
import { type TokenFixture, bootTokenFixture } from './token-test-support';

const OTHER = 'bb'.repeat(16);
const DAY_MS = 86_400_000;
const NO_SESSIONS = {
  verify: () => ({ ok: false, reason: 'unknown' }),
} as unknown as NodeSessionStore;

let fixture: TokenFixture;
beforeEach(() => {
  fixture = bootTokenFixture();
});
afterEach(() => fixture.close());

const withCookie = (cookie: string, path = '/api/exec', method = 'POST') =>
  new Request(`http://localhost/n/${OTHER}${path}`, { method, headers: { cookie } });

describe('entry: which credential goes to the target', () => {
  test('token cookie becomes tok:<secret> only when there is no session cookie', () => {
    const req = withCookie(`vibeterm_t_${OTHER}=vtk_abc`);
    expect(forwardedAuthFor(req, OTHER, '/api/exec')).toBe('tok:vtk_abc');
    expect(execForwardCredential(req, OTHER)).toBe('tok:vtk_abc');
    const both = withCookie(`vibeterm_t_${OTHER}=vtk_abc; vibeterm_s_${OTHER}=sid-1`);
    expect(forwardedAuthFor(both, OTHER, '/api/exec')).toBe('sid-1');
    expect(execForwardCredential(both, OTHER)).toBe('sid-1');
    const legacy = withCookie(`vibeterm_t_${OTHER}=vtk_abc; tmex_s_${OTHER}=sid-2`);
    expect(forwardedAuthFor(legacy, OTHER, '/api/exec')).toBe('sid-2');
  });

  test('tokens are per target node and never sent on public auth-flow paths', () => {
    const req = withCookie(`vibeterm_t_${OTHER}=vtk_abc; vibeterm_t_self=vtk_self`);
    expect(forwardedAuthFor(req, 'cc'.repeat(16), '/api/exec')).toBeNull();
    for (const rest of ['/api/auth/mode', '/api/auth/login', '/api/auth/challenge']) {
      expect(forwardedAuthFor(req, OTHER, rest)).toBeNull();
    }
  });

  test('http forward sends tok: auth plus the entry client ip header', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, {} as LinkSession);
    const streams = new FakeStreams();
    streams.nextResponse = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const mesh = await bootMesh({ peers, streams });
    try {
      const req = withCookie(`vibeterm_t_${OTHER}=vtk_abc`);
      setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '203.0.113.9' });
      req.headers.set(ENTRY_CLIENT_IP_HEADER, '198.51.100.1');
      await mesh.runtime.handleRequest(req, { upgrade: () => true });
      expect(streams.lastOpen?.auth).toBe('tok:vtk_abc');
      expect(streams.lastOpen?.headers[ENTRY_CLIENT_IP_HEADER]).toBe('203.0.113.9');
      expect(streams.lastOpen?.headers.cookie).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('session cookie wins on the wire: no tok: and no client ip header', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, {} as LinkSession);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const req = withCookie(`vibeterm_t_${OTHER}=vtk_abc; vibeterm_s_${OTHER}=sid-1`);
      setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '203.0.113.9' });
      await mesh.runtime.handleRequest(req, { upgrade: () => true });
      expect(streams.lastOpen?.auth).toBe('sid-1');
      expect(streams.lastOpen?.headers[ENTRY_CLIENT_IP_HEADER]).toBeUndefined();
    } finally {
      mesh.close();
    }
  });

  test('stampedAuthorizedHeaders only stamps the ip for token credentials', () => {
    const req = new Request('http://localhost/x');
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '203.0.113.9' });
    expect(stampedAuthorizedHeaders(req, { a: '1' }, 'sid-1')).toEqual({ a: '1' });
    expect(stampedAuthorizedHeaders(req, { [ENTRY_CLIENT_IP_HEADER]: 'forged' }, 'tok:x')).toEqual({
      [ENTRY_CLIENT_IP_HEADER]: '203.0.113.9',
    });
  });

  test('exec forward open payload carries the tok: credential and the real client ip', async () => {
    const peers = new FakePeers();
    const stream = new FakeLinkStream();
    const payloads: Uint8Array[] = [];
    peers.links.set(OTHER, {
      openStream: async (payload: Uint8Array) => {
        payloads.push(payload);
        return stream;
      },
    } as unknown as LinkSession);
    const mesh = await bootMesh({ peers });
    try {
      let data: ExecForwardSocketData | undefined;
      const req = new Request(`http://localhost/n/${OTHER}/api/exec/ws`, {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          cookie: `vibeterm_t_${OTHER}=vtk_abc`,
        },
      });
      setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '203.0.113.9' });
      await mesh.runtime.handleRequest(req, {
        upgrade: (_r: Request, o?: { data?: unknown }) => {
          data = o?.data as ExecForwardSocketData;
          return true;
        },
      });
      expect(data?.credential).toBe('tok:vtk_abc');
      const ws = {
        data: data as ExecForwardSocketData,
        send: () => 1,
        close: () => {},
        getBufferedAmount: () => 0,
      };
      execForwardWebsocket.open(ws);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(decodeJsonBytes(payloads[0] as Uint8Array)).toEqual({
        type: 'exec',
        credential: 'tok:vtk_abc',
        clientIp: '203.0.113.9',
      });
    } finally {
      mesh.close();
    }
  });
});

describe('target: HTTP stream tok: credentials', () => {
  const ctx = () => ({ peerNodeId: 'entry-a', sessionStore: NO_SESSIONS });

  test('valid token yields the owner uid and a token principal, no session', () => {
    const { secret, id } = fixture.mint(['exec', 'files']);
    const result = authorizeHttpStream(`tok:${secret}`, 'POST', '/api/exec', ctx(), {});
    expect(result).toEqual({
      ok: true,
      uid: 'tok-user',
      token: { tokenId: id, scopes: ['exec', 'files'] },
    });
  });

  test('client ip: the entry header is used, otherwise peer:<node>', () => {
    const { secret, id } = fixture.mint(['exec']);
    authorizeHttpStream(`tok:${secret}`, 'POST', '/api/exec', ctx(), {
      [ENTRY_CLIENT_IP_HEADER]: '203.0.113.9',
    });
    expect(fixture.service.list('tok-user').find((t) => t.id === id)?.lastUsedIp).toBe(
      '203.0.113.9'
    );
    fixture.setNow(1_800_000_000_000 + 120_000);
    authorizeHttpStream(`tok:${secret}`, 'POST', '/api/exec', ctx(), {
      [ENTRY_CLIENT_IP_HEADER]: 'not an ip',
    });
    expect(fixture.service.list('tok-user').find((t) => t.id === id)?.lastUsedIp).toBe(
      'peer:entry-a'
    );
  });

  test('unknown, revoked, expired and malformed all fail with the same reason', () => {
    const revoked = fixture.mint(['exec']);
    fixture.service.revoke('tok-user', revoked.id);
    const expiring = fixture.mint(['exec'], 1);
    fixture.setNow(1_800_000_000_000 + 2 * DAY_MS);
    const reasons = new Set(
      [`tok:${revoked.secret}`, `tok:${expiring.secret}`, 'tok:vtk_unknown', 'tok:'].map((auth) => {
        const result = authorizeHttpStream(auth, 'POST', '/api/exec', ctx(), {});
        expect(result.ok).toBe(false);
        return result.ok ? '' : result.reason;
      })
    );
    expect([...reasons]).toEqual(['token_invalid']);
  });

  test('public auth-flow paths treat any token (valid or not) as anonymous', () => {
    const { secret } = fixture.mint(['exec']);
    for (const auth of [`tok:${secret}`, 'tok:vtk_garbage']) {
      for (const path of ['/api/auth/mode', '/api/auth/challenge', '/api/auth/login']) {
        expect(authorizeHttpStream(auth, 'GET', path, ctx(), {})).toEqual({ ok: true, uid: null });
      }
    }
  });

  test('websocket streams never accept tok: (terminal /ws has no token scope)', () => {
    const { secret } = fixture.mint(['exec', 'files', 'forward']);
    const result = verifyStreamAuth(`tok:${secret}`, '/ws', ctx());
    expect(result.ok).toBe(false);
  });
});

describe('target: exec credential and stream', () => {
  const ctx = (clientIp?: string) => ({
    peerNodeId: 'entry-a',
    sessionStore: NO_SESSIONS,
    ...(clientIp ? { clientIp } : {}),
  });

  test('exec-scoped token opens an exec channel with its token id', () => {
    const { secret, id } = fixture.mint(['exec']);
    expect(verifyExecCredential(`tok:${secret}`, ctx())).toEqual({
      ok: true,
      uid: 'tok-user',
      tokenId: id,
    });
  });

  test('a token without exec scope is refused', () => {
    const { secret } = fixture.mint(['files', 'forward']);
    expect(verifyExecCredential(`tok:${secret}`, ctx())).toEqual({
      ok: false,
      reason: 'token_scope',
    });
  });

  test('invalid tokens share one reason', () => {
    const revoked = fixture.mint(['exec']);
    fixture.service.revoke('tok-user', revoked.id);
    for (const credential of [`tok:${revoked.secret}`, 'tok:vtk_nope', 'tok:']) {
      expect(verifyExecCredential(credential, ctx())).toEqual({
        ok: false,
        reason: 'token_invalid',
      });
    }
  });

  test('acceptExecStream passes tokenId to the channel and the OPEN client ip to verification', () => {
    const { secret, id } = fixture.mint(['exec']);
    const stream = new FakeLinkStream(
      encodeJsonBytes({ type: 'exec', credential: `tok:${secret}`, clientIp: '203.0.113.9' })
    );
    const attached: unknown[] = [];
    acceptExecStream(stream, ctx(), (_s, auth) => attached.push(auth));
    expect(attached).toEqual([{ uid: 'tok-user', tokenId: id }]);
    expect(fixture.service.list('tok-user')[0]?.lastUsedIp).toBe('203.0.113.9');
  });

  test('acceptExecStream resets with auth:token_invalid / auth:token_scope', () => {
    const files = fixture.mint(['files']);
    const cases: Array<[string, string]> = [
      ['tok:vtk_nope', 'auth:token_invalid'],
      [`tok:${files.secret}`, 'auth:token_scope'],
    ];
    for (const [credential, reason] of cases) {
      const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential }));
      acceptExecStream(stream, ctx(), () => {});
      expect(stream.resetReason).toBe(reason);
    }
  });
});

const depsOf = (mesh: { nodeSessionStore: NodeSessionStore }) => ({
  roles: { node: true, relay: false },
  nodeSessionStore: mesh.nodeSessionStore,
});

describe('local exec websocket upgrade', () => {
  const upgrade = (headers: Record<string, string>) =>
    new Request('http://localhost/api/exec/ws', {
      headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers },
    });

  test('exec token (Bearer or cookie) upgrades with its token id; other scopes get 403', async () => {
    const mesh = await bootMesh();
    try {
      const deps = depsOf(mesh);
      const exec = fixture.mint(['exec']);
      const files = fixture.mint(['files']);
      expect(
        authenticateExecUpgrade(upgrade({ authorization: `Bearer ${exec.secret}` }), deps)
      ).toEqual({ uid: 'tok-user', tokenId: exec.id });
      expect(
        authenticateExecUpgrade(upgrade({ cookie: `vibeterm_t_self=${exec.secret}` }), deps)
      ).toEqual({ uid: 'tok-user', tokenId: exec.id });
      const denied = authenticateExecUpgrade(
        upgrade({ authorization: `Bearer ${files.secret}` }),
        deps
      ) as Response;
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { code: string }).code).toBe('TOKEN_SCOPE');
      const invalid = authenticateExecUpgrade(upgrade({ authorization: 'Bearer vtk_x' }), deps);
      expect((invalid as Response).status).toBe(401);
      expect((authenticateExecUpgrade(upgrade({}), deps) as Response).status).toBe(401);
    } finally {
      mesh.close();
    }
  });

  test('a live session wins over a token and never carries a token id', async () => {
    const mesh = await bootMesh();
    try {
      const deps = depsOf(mesh);
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const files = fixture.mint(['files']);
      const auth = authenticateExecUpgrade(
        upgrade({ cookie: `vibeterm_s_self=${sid}; vibeterm_t_self=${files.secret}` }),
        deps
      );
      expect(auth).toEqual({
        uid: mesh.boot.userId,
        tokenId: null,
        session: { sid, viaNodeId: 'self' },
      });
      const withBadToken = authenticateExecUpgrade(
        upgrade({ cookie: `vibeterm_s_self=${sid}`, authorization: 'Bearer vtk_bad' }),
        deps
      );
      expect(withBadToken).toEqual({
        uid: mesh.boot.userId,
        tokenId: null,
        session: { sid, viaNodeId: 'self' },
      });
    } finally {
      mesh.close();
    }
  });
});
