import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes, rootKeyFromSeed } from '../../../shared/src/auth';
import {
  REDEEM_NETWORK_RETRY_LIMIT,
  assertHubJoinUrl,
  fetchAuthMode,
  loginWithRootKey,
  postEnrollment,
  redeemEnrollment,
} from './hub-client';

describe('assertHubJoinUrl', () => {
  test('rejects http unless insecure-local on loopback in non-production', () => {
    expect(() => assertHubJoinUrl('http://example.com')).toThrow(/https/);
    expect(() => assertHubJoinUrl('http://127.0.0.1:9')).toThrow(/https/);
    expect(assertHubJoinUrl('http://127.0.0.1:9', true, 'test').hostname).toBe('127.0.0.1');
    expect(assertHubJoinUrl('https://hub.example').protocol).toBe('https:');
  });

  test('refuses --insecure-local when NODE_ENV is production', () => {
    expect(() => assertHubJoinUrl('http://127.0.0.1:9', true, 'production')).toThrow(
      /NODE_ENV=production/
    );
    expect(assertHubJoinUrl('https://hub.example', true, 'production').protocol).toBe('https:');
  });
});

describe('hub-client fetch policy', () => {
  test('all hub fetches set redirect: error', async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      redirects.push(init?.redirect);
      return new Response(
        JSON.stringify({
          mode: 'mesh',
          nodeId: 'self',
          uid: 'u1',
          totpEnabled: false,
        }),
        { status: 200 }
      );
    };
    await fetchAuthMode('https://hub.example', fetcher);
    expect(redirects).toEqual(['error']);
  });

  test('redeemEnrollment retries network errors before a response is read', async () => {
    let attempts = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      expect(init?.redirect).toBe('error');
      attempts += 1;
      if (attempts < REDEEM_NETWORK_RETRY_LIMIT) {
        throw new Error('ECONNRESET');
      }
      return new Response(
        JSON.stringify({
          user: {
            id: 'u1',
            username: 'alice',
            root_public_key: 'x',
            root_epoch: 1,
            kdf_params: {},
          },
          user_key_log: [],
          node_certs: [],
        }),
        { status: 200 }
      );
    };
    const redeemed = await redeemEnrollment({
      baseUrl: 'https://hub.example',
      certificate: new Uint8Array(8),
      certSig: new Uint8Array(64),
      fetcher,
    });
    expect(attempts).toBe(REDEEM_NETWORK_RETRY_LIMIT);
    expect(redeemed.user.id).toBe('u1');
  });

  test('redeemEnrollment does not retry HTTP errors after a response is read', async () => {
    let attempts = 0;
    const fetcher: typeof fetch = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: 'reused' }), { status: 400 });
    };
    await expect(
      redeemEnrollment({
        baseUrl: 'https://hub.example',
        certificate: new Uint8Array([1]),
        certSig: new Uint8Array(64),
        fetcher,
      })
    ).rejects.toThrow(/redeem failed: HTTP 400 reused/);
    expect(attempts).toBe(1);
  });

  test('certificate bytes are reused across redeem retries', async () => {
    const cert = new Uint8Array([9, 8, 7]);
    const sig = new Uint8Array(64).fill(3);
    const bodies: string[] = [];
    let attempts = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      attempts += 1;
      bodies.push(String(init?.body ?? ''));
      if (attempts === 1) {
        throw new Error('socket hang up');
      }
      return new Response(
        JSON.stringify({
          user: {
            id: 'u1',
            username: 'alice',
            root_public_key: 'x',
            root_epoch: 1,
            kdf_params: {},
          },
          user_key_log: [],
          node_certs: [],
        }),
        { status: 200 }
      );
    };
    await redeemEnrollment({
      baseUrl: 'https://hub.example',
      certificate: cert,
      certSig: sig,
      name: 'studio',
      fetcher,
    });
    expect(attempts).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toContain(encodeBase64url(cert));
    expect(bodies[0]).toContain(encodeBase64url(sig));
  });
});

function loginFetcher(options: {
  loginHeaders?: HeadersInit;
  loginBody?: unknown;
  nodeId?: string;
  onLogin?: (req: RequestInit | undefined) => void;
}): typeof fetch {
  const nonce = encodeBase64url(randomBytes(32));
  const nodePk = encodeBase64url(randomBytes(32));
  return async (_url, init) => {
    const url = String(_url);
    if (url.endsWith('/api/auth/mode')) {
      return Response.json({
        mode: 'mesh',
        nodeId: options.nodeId ?? 'self',
        uid: 'u1',
        totpEnabled: false,
      });
    }
    if (url.endsWith('/api/auth/challenge')) {
      return Response.json({ challenge_id: 'c1', nonce, nodePk });
    }
    if (url.endsWith('/api/auth/login')) {
      options.onLogin?.(init);
      return new Response(
        JSON.stringify(options.loginBody ?? { expires_at: Date.now() + 60_000 }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(options.loginHeaders ?? {}),
          },
        }
      );
    }
    return new Response('nope', { status: 404 });
  };
}

describe('loginWithRootKey session extraction', () => {
  const rootKey = rootKeyFromSeed(randomBytes(32));

  test('reads sid from x-tmex-set-session header (no sid in body)', async () => {
    const session = await loginWithRootKey({
      baseUrl: 'https://hub.example',
      rootKey,
      uid: 'u1',
      fetcher: loginFetcher({
        loginHeaders: { 'x-tmex-set-session': 'header-sid;60' },
        loginBody: { expires_at: 1_700_000_000_000 },
      }),
    });
    expect(session.sid).toBe('header-sid');
    expect(session.expiresAt).toBe(1_700_000_000_000);
    expect(session.cookieHeader).toContain('tmex_s_self=header-sid');
  });

  test('falls back to Set-Cookie tmex_s_self when header is absent', async () => {
    const session = await loginWithRootKey({
      baseUrl: 'https://hub.example',
      rootKey,
      uid: 'u1',
      fetcher: loginFetcher({
        loginHeaders: {
          'set-cookie': 'tmex_s_self=cookie-sid; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
        },
      }),
    });
    expect(session.sid).toBe('cookie-sid');
    expect(session.cookieHeader).toContain('tmex_s_self=cookie-sid');
  });

  test('falls back to Set-Cookie tmex_s_<nodeId>', async () => {
    const session = await loginWithRootKey({
      baseUrl: 'https://hub.example',
      rootKey,
      uid: 'u1',
      fetcher: loginFetcher({
        nodeId: 'n1',
        loginHeaders: {
          'set-cookie': 'tmex_s_n1=node-sid; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
        },
      }),
    });
    expect(session.sid).toBe('node-sid');
    expect(session.cookieHeader).toContain('tmex_s_self=node-sid');
    expect(session.cookieHeader).toContain('tmex_s_n1=node-sid');
  });

  test('does not read sid from the JSON body', async () => {
    await expect(
      loginWithRootKey({
        baseUrl: 'https://hub.example',
        rootKey,
        uid: 'u1',
        fetcher: loginFetcher({
          loginBody: { sid: 'body-sid', expires_at: Date.now() + 60_000 },
        }),
      })
    ).rejects.toThrow(/did not return sid/);
  });

  test('postEnrollment sends the session cookie the gateway accepts', async () => {
    const cookies: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/hub/enrollments')) {
        cookies.push(String(init?.headers && new Headers(init.headers).get('cookie')));
        return Response.json({ ok: true, id: 'e1' }, { status: 201 });
      }
      return loginFetcher({
        loginHeaders: { 'x-tmex-set-session': 'sess-9;60' },
      })(input, init);
    };
    const session = await loginWithRootKey({
      baseUrl: 'https://hub.example',
      rootKey,
      uid: 'u1',
      fetcher,
    });
    await postEnrollment({
      baseUrl: 'https://hub.example',
      cookieHeader: session.cookieHeader,
      enrollPk: randomBytes(32),
      authorization: randomBytes(32),
      authorizationSig: randomBytes(64),
      exp: Date.now() + 60_000,
      fetcher,
    });
    expect(cookies[0]).toContain('tmex_s_self=sess-9');
  });
});
