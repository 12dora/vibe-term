import { json } from '../api/http';
import { parseCookies } from '../auth/cookies';
import type { TunnelFetch } from './access-client';
import { JwksCache, verifyAccessJwt } from './access-jwt';

export type AccessEnforcement = {
  enforceJwt: boolean;
  configured: boolean;
  aud: string | null;
  teamDomain: string | null;
};

export type AccessGuardOptions = {
  snapshot?: () => AccessEnforcement;
  fetchImpl?: TunnelFetch;
  now?: () => number;
  jwks?: JwksCache;
};

const DENIED = { error: { code: 'access_denied' as const } };

const defaultSnapshot = (): AccessEnforcement => ({
  enforceJwt: false,
  configured: false,
  aud: null,
  teamDomain: null,
});

let snapshotFn: () => AccessEnforcement = defaultSnapshot;
let fetchImpl: TunnelFetch = fetch;
let nowFn: () => number = Date.now;
let defaultJwks = new JwksCache();

export function setAccessGuardSnapshot(fn: (() => AccessEnforcement) | null): void {
  snapshotFn = fn ?? defaultSnapshot;
}

export const setAccessGuardSource = setAccessGuardSnapshot;

export function setAccessJwtVerifier(jwks: JwksCache): void {
  defaultJwks = jwks;
}

export const guardTunnelAccess = enforceTunnelAccessJwt;

export function setAccessGuardFetch(fn: TunnelFetch): void {
  fetchImpl = fn;
  defaultJwks.setFetchImpl(fn);
}

export function setAccessGuardNow(fn: () => number): void {
  nowFn = fn;
}

export function resetAccessGuardForTests(): void {
  snapshotFn = defaultSnapshot;
  fetchImpl = fetch;
  nowFn = Date.now;
  defaultJwks.invalidate();
  defaultJwks.setFetchImpl(fetch);
}

export function createAccessGuard(opts: AccessGuardOptions = {}) {
  const jwks = opts.jwks ?? new JwksCache({ fetchImpl: opts.fetchImpl, now: opts.now });
  if (opts.fetchImpl) jwks.setFetchImpl(opts.fetchImpl);
  return (req: Request) =>
    enforceAccessJwt(req, {
      snapshot: opts.snapshot ?? snapshotFn,
      fetchImpl: opts.fetchImpl ?? fetchImpl,
      now: opts.now ?? nowFn,
      jwks,
    });
}

export async function enforceTunnelAccessJwt(req: Request): Promise<Response | null> {
  return enforceAccessJwt(req, {
    snapshot: snapshotFn,
    fetchImpl,
    now: nowFn,
    jwks: defaultJwks,
  });
}

export async function enforceAccessJwt(
  req: Request,
  opts: {
    snapshot: () => AccessEnforcement;
    fetchImpl?: TunnelFetch;
    now?: () => number;
    jwks: JwksCache;
  }
): Promise<Response | null> {
  if (!req.headers.get('cf-connecting-ip')) return null;
  const snap = opts.snapshot();
  if (!snap.enforceJwt || !snap.configured || !snap.aud || !snap.teamDomain) return null;
  const token = readAccessJwt(req);
  if (!token) return json(DENIED, 403);
  const ok = await verifyAccessJwt({
    token,
    teamDomain: snap.teamDomain,
    aud: snap.aud,
    now: (opts.now ?? Date.now)(),
    jwks: opts.jwks,
  });
  if (!ok) return json(DENIED, 403);
  return null;
}

export function readAccessJwt(req: Request): string | null {
  const header = req.headers.get('Cf-Access-Jwt-Assertion')?.trim();
  if (header) return header;
  const cookies = parseCookies(req.headers.get('Cookie'));
  const fromCookie = cookies.get('CF_Authorization')?.trim();
  if (!fromCookie) return null;
  return fromCookie.replace(/^"|"$/g, '');
}
