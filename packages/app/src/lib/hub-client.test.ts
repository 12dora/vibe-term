import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes, rootKeyFromSeed } from '../../../shared/src/auth';
import {
  REDEEM_NETWORK_RETRY_LIMIT,
  assertHubJoinUrl,
  createHubFetcher,
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

  test('returns a canonical URL (lowercase host, no default port, no trailing slash origin)', () => {
    const url = assertHubJoinUrl('HTTPS://Hub.Example:443/');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('hub.example');
    expect(url.port).toBe('');
    expect(url.toString().replace(/\/+$/, '')).toBe('https://hub.example');
  });

  test('rejects credentials, query, and fragment', () => {
    expect(() => assertHubJoinUrl('https://user:pass@hub.example')).toThrow(/credentials/);
    expect(() => assertHubJoinUrl('https://hub.example?x=1')).toThrow(/query|fragment/);
    expect(() => assertHubJoinUrl('https://hub.example#frag')).toThrow(/query|fragment/);
  });
});

describe('createHubFetcher', () => {
  test('returns inner fetch when no pinned CA exists', () => {
    const inner: typeof fetch = async () => new Response('{}');
    const fetcher = createHubFetcher({ get: () => null }, 'https://hub.example', inner);
    expect(fetcher).toBe(inner);
  });

  test('pins tls.ca for subsequent hub fetches', async () => {
    const seen: unknown[] = [];
    const inner: typeof fetch = async (_input, init) => {
      seen.push((init as { tls?: unknown } | undefined)?.tls);
      return new Response('{}');
    };
    const fetcher = createHubFetcher(
      { get: () => ({ caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' }) },
      'https://hub.example',
      inner
    );
    await fetcher('https://hub.example/api/auth/mode');
    expect(seen).toEqual([{ ca: ['-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----'] }]);
  });

  test('looks up trust by canonical hub URL', async () => {
    const keys: string[] = [];
    const inner: typeof fetch = async () => new Response('{}');
    const fetcher = createHubFetcher(
      {
        get(hubUrl) {
          keys.push(hubUrl);
          return { caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' };
        },
      },
      'HTTPS://Hub.Example:443/',
      inner
    );
    await fetcher('https://hub.example/api/auth/mode');
    expect(keys).toEqual(['https://hub.example']);
  });
});

describe('fetchAuthMode', () => {
  test('parses passkeySecondFactor as boolean and defaults to false', async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        mode: 'mesh',
        nodeId: 'self',
        uid: 'u1',
        totpEnabled: false,
        passkeySecondFactor: true,
      });
    const on = await fetchAuthMode('https://hub.example', fetcher);
    expect(on.passkeySecondFactor).toBe(true);

    const off = await fetchAuthMode('https://hub.example', async () =>
      Response.json({ mode: 'mesh', nodeId: 'self', uid: 'u1', totpEnabled: false })
    );
    expect(off.passkeySecondFactor).toBe(false);
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
  loginStatus?: number;
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
          status: options.loginStatus ?? 200,
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

  test('maps PASSKEY_REQUIRED / PASSKEY_INVALID / INVALID_CREDENTIALS to clear errors', async () => {
    await expect(
      loginWithRootKey({
        baseUrl: 'https://hub.example',
        rootKey,
        uid: 'u1',
        fetcher: loginFetcher({
          loginStatus: 401,
          loginBody: { code: 'PASSKEY_REQUIRED' },
        }),
      })
    ).rejects.toThrow(/passkey second-factor/i);
    await expect(
      loginWithRootKey({
        baseUrl: 'https://hub.example',
        rootKey,
        uid: 'u1',
        fetcher: loginFetcher({
          loginStatus: 401,
          loginBody: { code: 'PASSKEY_INVALID' },
        }),
      })
    ).rejects.toThrow(/Passkey second-factor verification failed/i);
    await expect(
      loginWithRootKey({
        baseUrl: 'https://hub.example',
        rootKey,
        uid: 'u1',
        fetcher: loginFetcher({
          loginStatus: 401,
          loginBody: { code: 'INVALID_CREDENTIALS' },
        }),
      })
    ).rejects.toThrow(/Invalid credentials/i);
  });
});
