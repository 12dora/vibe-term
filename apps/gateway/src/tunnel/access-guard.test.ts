import { describe, expect, test } from 'bun:test';
import { enforceAccessJwt } from './access-guard';
import { JwksCache } from './access-jwt';

async function generateRsa() {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
}

async function signJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<string> {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(data)
  );
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-1';
const SNAP = {
  enforceJwt: true,
  configured: true,
  teamDomain: TEAM,
  aud: AUD,
};

describe('enforceAccessJwt', () => {
  test('passes when cf-connecting-ip is absent', async () => {
    const res = await enforceAccessJwt(new Request('http://127.0.0.1/api/devices'), {
      snapshot: () => SNAP,
      jwks: new JwksCache(),
    });
    expect(res).toBeNull();
  });

  test('returns 403 when the request came through cloudflared without a JWT', async () => {
    const res = await enforceAccessJwt(
      new Request('http://127.0.0.1/api/devices', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      { snapshot: () => SNAP, jwks: new JwksCache() }
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: { code: 'access_denied' } });
  });

  test('passes a valid JWT on a cloudflared request', async () => {
    const { publicKey, privateKey } = await generateRsa();
    const kid = 'k1';
    const jwks = new JwksCache({
      fetchImpl: async () => {
        const jwk = await crypto.subtle.exportKey('jwk', publicKey);
        return Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
      },
    });
    const now = Date.now();
    const token = await signJwt(
      privateKey,
      { alg: 'RS256', kid, typ: 'JWT' },
      {
        aud: [AUD],
        iss: `https://${TEAM}`,
        exp: Math.floor(now / 1000) + 120,
      }
    );
    const res = await enforceAccessJwt(
      new Request('http://127.0.0.1/api/devices', {
        headers: {
          'cf-connecting-ip': '1.2.3.4',
          'Cf-Access-Jwt-Assertion': token,
        },
      }),
      { snapshot: () => SNAP, jwks }
    );
    expect(res).toBeNull();
  });

  test('accepts CF_Authorization cookie on a cloudflared request', async () => {
    const { publicKey, privateKey } = await generateRsa();
    const kid = 'k-cookie';
    const jwks = new JwksCache({
      fetchImpl: async () => {
        const jwk = await crypto.subtle.exportKey('jwk', publicKey);
        return Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
      },
    });
    const now = Date.now();
    const token = await signJwt(
      privateKey,
      { alg: 'RS256', kid, typ: 'JWT' },
      {
        aud: [AUD],
        iss: `https://${TEAM}`,
        exp: Math.floor(now / 1000) + 120,
      }
    );
    const res = await enforceAccessJwt(
      new Request('http://127.0.0.1/api/devices', {
        headers: {
          'cf-connecting-ip': '1.2.3.4',
          Cookie: `CF_Authorization=${token}`,
        },
      }),
      { snapshot: () => SNAP, jwks }
    );
    expect(res).toBeNull();
  });
});
