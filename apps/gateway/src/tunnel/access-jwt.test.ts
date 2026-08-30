import { describe, expect, test } from 'bun:test';
import { JwksCache, verifyAccessJwt } from './access-jwt';

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

async function jwkFor(publicKey: CryptoKey, kid: string) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'app-aud-1';
const NOW = 1_700_000_000_000;

describe('verifyAccessJwt', () => {
  test('accepts a valid RS256 token and rejects expired/wrong-aud/wrong-iss', async () => {
    const { publicKey, privateKey } = await generateRsa();
    const kid = 'kid-1';
    let fetches = 0;
    const jwks = new JwksCache({
      now: () => NOW,
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ keys: [await jwkFor(publicKey, kid)] });
      },
    });
    const valid = await signJwt(
      privateKey,
      { alg: 'RS256', kid, typ: 'JWT' },
      {
        aud: [AUD],
        iss: `https://${TEAM}`,
        exp: Math.floor(NOW / 1000) + 60,
        nbf: Math.floor(NOW / 1000) - 10,
      }
    );
    expect(
      await verifyAccessJwt({ token: valid, teamDomain: TEAM, aud: AUD, now: NOW, jwks })
    ).toBe(true);

    const expired = await signJwt(
      privateKey,
      { alg: 'RS256', kid, typ: 'JWT' },
      { aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) - 1 }
    );
    expect(
      await verifyAccessJwt({ token: expired, teamDomain: TEAM, aud: AUD, now: NOW, jwks })
    ).toBe(false);

    const wrongAud = await signJwt(
      privateKey,
      { alg: 'RS256', kid, typ: 'JWT' },
      { aud: ['other'], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) + 60 }
    );
    expect(
      await verifyAccessJwt({ token: wrongAud, teamDomain: TEAM, aud: AUD, now: NOW, jwks })
    ).toBe(false);

    const wrongIss = await signJwt(
      privateKey,
      { alg: 'RS256', kid, typ: 'JWT' },
      { aud: [AUD], iss: 'https://evil.example', exp: Math.floor(NOW / 1000) + 60 }
    );
    expect(
      await verifyAccessJwt({ token: wrongIss, teamDomain: TEAM, aud: AUD, now: NOW, jwks })
    ).toBe(false);
    expect(fetches).toBe(1);
  });

  test('refreshes JWKS when kid is unknown', async () => {
    const first = await generateRsa();
    const second = await generateRsa();
    const kids = ['old', 'new'];
    let fetches = 0;
    const jwks = new JwksCache({
      now: () => NOW,
      fetchImpl: async () => {
        fetches += 1;
        const pair = fetches === 1 ? first : second;
        const kid = kids[fetches - 1];
        return Response.json({ keys: [await jwkFor(pair.publicKey, kid)] });
      },
    });
    const firstTok = await signJwt(
      first.privateKey,
      { alg: 'RS256', kid: 'old', typ: 'JWT' },
      { aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) + 60 }
    );
    expect(
      await verifyAccessJwt({ token: firstTok, teamDomain: TEAM, aud: AUD, now: NOW, jwks })
    ).toBe(true);
    const secondTok = await signJwt(
      second.privateKey,
      { alg: 'RS256', kid: 'new', typ: 'JWT' },
      { aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) + 60 }
    );
    expect(
      await verifyAccessJwt({ token: secondTok, teamDomain: TEAM, aud: AUD, now: NOW, jwks })
    ).toBe(true);
    expect(fetches).toBe(2);
  });
});
