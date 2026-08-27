import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '../../../shared/src/auth';
import {
  REDEEM_NETWORK_RETRY_LIMIT,
  assertHubJoinUrl,
  fetchAuthMode,
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
