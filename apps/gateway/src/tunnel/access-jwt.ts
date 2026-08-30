import type { TunnelFetch } from './access-client';
import { jwksUrlForTeam, teamIssuer } from './access-sanitize';

export type JwkRsa = {
  kty?: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
};

export type Jwks = { keys?: JwkRsa[] };

const JWKS_TTL_MS = 10 * 60 * 1000;

export type JwksCacheOptions = {
  fetchImpl?: TunnelFetch;
  now?: () => number;
  ttlMs?: number;
  cacheTtlMs?: number;
};

export class JwksCache {
  private keys: JwkRsa[] = [];
  private fetchedAt = 0;
  private readonly ttlMs: number;
  private fetchImpl: TunnelFetch;
  protected readonly now: () => number;

  constructor(opts: JwksCacheOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? opts.cacheTtlMs ?? JWKS_TTL_MS;
  }

  setFetchImpl(fn: TunnelFetch): void {
    this.fetchImpl = fn;
  }

  invalidate(): void {
    this.keys = [];
    this.fetchedAt = 0;
  }

  async getKey(teamDomain: string, kid: string, forceRefresh = false): Promise<JwkRsa | null> {
    const stale = this.now() - this.fetchedAt > this.ttlMs;
    if (forceRefresh || stale || this.keys.length === 0) {
      await this.refresh(teamDomain);
    }
    let found = this.keys.find((k) => k.kid === kid) ?? null;
    if (!found && !forceRefresh) {
      await this.refresh(teamDomain);
      found = this.keys.find((k) => k.kid === kid) ?? null;
    }
    return found;
  }

  private async refresh(teamDomain: string): Promise<void> {
    const url = jwksUrlForTeam(teamDomain);
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new Error(`JWKS HTTP ${res.status}`);
    }
    const body = (await res.json()) as Jwks;
    this.keys = Array.isArray(body.keys) ? body.keys : [];
    this.fetchedAt = this.now();
  }
}

export type VerifyAccessJwtInput = {
  token: string;
  teamDomain: string;
  aud: string;
  now?: number;
  jwks: JwksCache;
};

export async function verifyAccessJwt(input: VerifyAccessJwtInput): Promise<boolean> {
  const parsed = splitJwt(input.token);
  if (!parsed) return false;
  const { header, payload, signingInput, signature } = parsed;
  if (header.alg !== 'RS256') return false;
  const kid = typeof header.kid === 'string' ? header.kid : '';
  if (!kid) return false;
  let key: JwkRsa | null;
  try {
    key = await input.jwks.getKey(input.teamDomain, kid);
  } catch {
    return false;
  }
  if (!key?.n || !key.e) return false;
  const ok = await verifyRs256(signingInput, signature, key);
  if (!ok) return false;
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) return false;
  if (typeof payload.nbf === 'number' && nowSec < payload.nbf) return false;
  const iss = teamIssuer(input.teamDomain);
  if (payload.iss !== iss) return false;
  const auds = Array.isArray(payload.aud)
    ? payload.aud.filter((v): v is string => typeof v === 'string')
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];
  return auds.includes(input.aud);
}

type JwtHeader = { alg?: string; kid?: string; typ?: string };
type JwtPayload = { aud?: unknown; iss?: unknown; exp?: number; nbf?: number; iat?: number };

function splitJwt(token: string): {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Uint8Array;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const header = JSON.parse(utf8FromB64url(parts[0])) as JwtHeader;
    const payload = JSON.parse(utf8FromB64url(parts[1])) as JwtPayload;
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: b64urlToBytes(parts[2]),
    };
  } catch {
    return null;
  }
}

async function verifyRs256(
  signingInput: string,
  signature: Uint8Array,
  jwk: JwkRsa
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const data = new TextEncoder().encode(signingInput);
    const sig = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength
    ) as ArrayBuffer;
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  } catch {
    return false;
  }
}

function utf8FromB64url(value: string): string {
  return new TextDecoder().decode(b64urlToBytes(value));
}

function b64urlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export class AccessJwtVerifier extends JwksCache {
  async verify(token: string, claims: { aud: string; teamDomain: string }): Promise<boolean> {
    return verifyAccessJwt({
      token,
      teamDomain: claims.teamDomain,
      aud: claims.aud,
      now: this.now(),
      jwks: this,
    });
  }
}

export async function generateAccessTestKey(kid: string): Promise<{
  privateKey: CryptoKey;
  jwk: JwkRsa;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JwkRsa;
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
  };
}

export async function signAccessJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<string> {
  const encoder = new TextEncoder();
  const signingInput = `${bytesToB64url(encoder.encode(JSON.stringify(header)))}.${bytesToB64url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(signingInput))
  );
  return `${signingInput}.${bytesToB64url(signature)}`;
}
