import { json } from '../api/http';
import { parseCookies } from '../auth/cookies';
import { isPeerInboundRequest } from '../mesh/peer-request-marker';
import type { TunnelFetch } from './access-client';
import { JwksCache, verifyAccessJwt } from './access-jwt';
import { isAccessGuardExemptPath } from './access-paths';

export type AccessEnforcement = {
  enforceJwt: boolean;
  configured: boolean;
  aud: string | null;
  teamDomain: string | null;
  /** 与当前 named 隧道主机名匹配时才真正强制；缺省时回退到 enforceJwt && configured */
  effective?: boolean;
};

const DENIED = { error: { code: 'access_denied' as const } };

const defaultSnapshot = (): AccessEnforcement => ({
  enforceJwt: false,
  configured: false,
  aud: null,
  teamDomain: null,
  effective: false,
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

export function resetAccessGuardForTests(): void {
  snapshotFn = defaultSnapshot;
  fetchImpl = fetch;
  nowFn = Date.now;
  defaultJwks.invalidate();
  defaultJwks.setFetchImpl(fetch);
}

export function accessEnforcementActive(snap: AccessEnforcement): boolean {
  if (snap.effective === false) return false;
  const on = snap.effective === true || (snap.enforceJwt && snap.configured);
  return Boolean(on && snap.aud && snap.teamDomain);
}

/**
 * 每个 Bun `fetch` 最外层调用：豁免 peer inbound、机器路径、无 cf-connecting-ip，再校验 JWT。
 */
export async function guardEntryAccess(req: Request): Promise<Response | null> {
  if (isPeerInboundRequest(req)) return null;
  let pathname = '/';
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return json(DENIED, 403);
  }
  if (isAccessGuardExemptPath(pathname)) return null;
  return enforceTunnelAccessJwt(req);
}

export async function guardedGatewayFetch(
  req: Request,
  handle: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response | undefined> | undefined,
  bunServer: Bun.Server<unknown>,
  notFound: () => Response = () => new Response('Not Found', { status: 404 })
): Promise<Response> {
  const denied = await guardEntryAccess(req);
  if (denied) return denied;
  const response = await handle(req, bunServer);
  if (response !== undefined) return response;
  return notFound();
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
  if (!accessEnforcementActive(snap) || !snap.aud || !snap.teamDomain) return null;
  const token = readAccessJwt(req);
  if (!token) return json(DENIED, 403);
  let ok = false;
  try {
    ok = await verifyAccessJwt({
      token,
      teamDomain: snap.teamDomain,
      aud: snap.aud,
      now: (opts.now ?? Date.now)(),
      jwks: opts.jwks,
    });
  } catch {
    return json(DENIED, 403);
  }
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
