import { buildSetCookie, nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { NodeSessionRecord, NodeSessionStore } from '../auth/node-session-store';
import {
  MESH_VIA_SELF,
  type MeshRoles,
  X_TMEX_SESSION_RENEWED,
  getMeshRequestContext,
  isStandaloneRoles,
} from './mesh-deps';

export type AuthenticateOk = {
  ok: true;
  userId: string | null;
  session: NodeSessionRecord | null;
  sid: string | null;
  renewedExpiresAt?: number;
};

export type AuthenticateFail = { ok: false };

export type AuthenticateResult = AuthenticateOk | AuthenticateFail;

export type SessionMiddlewareDeps = {
  roles: MeshRoles;
  nodeSessionStore: NodeSessionStore;
  now?: () => number;
};

export type AuthedHandler = (req: Request, auth: AuthenticateOk) => Promise<Response> | Response;

export function authenticateRequest(
  req: Request,
  deps: SessionMiddlewareDeps,
  viaOverride?: string
): AuthenticateResult {
  if (isStandaloneRoles(deps.roles)) {
    return { ok: true, userId: null, session: null, sid: null };
  }
  const ctx = getMeshRequestContext(req);
  const via = viaOverride ?? ctx.via ?? MESH_VIA_SELF;
  const sid = via === MESH_VIA_SELF ? readSelfCookie(req) : (ctx.auth ?? null);
  if (!sid) {
    return { ok: false };
  }
  const verified = deps.nodeSessionStore.verify(sid, {
    viaNodeId: via,
    now: deps.now?.() ?? Date.now(),
  });
  if (!verified.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    userId: verified.session.userId,
    session: verified.session,
    sid,
    ...(verified.renewedExpiresAt !== undefined
      ? { renewedExpiresAt: verified.renewedExpiresAt }
      : {}),
  };
}

export function applySessionHeaders(
  response: Response,
  auth: AuthenticateOk,
  req: Request
): Response {
  if (auth.renewedExpiresAt === undefined || !auth.sid) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(X_TMEX_SESSION_RENEWED, String(auth.renewedExpiresAt));
  const via = getMeshRequestContext(req).via ?? MESH_VIA_SELF;
  if (via === MESH_VIA_SELF) {
    const maxAgeSec = Math.max(0, Math.floor((auth.renewedExpiresAt - Date.now()) / 1000));
    headers.append(
      'set-cookie',
      buildSetCookie(nodeSessionCookieName(MESH_VIA_SELF), auth.sid, {
        maxAgeSec,
        secure: isHttps(req),
      })
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function requireSession(
  deps: SessionMiddlewareDeps,
  handler: AuthedHandler
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const auth = authenticateRequest(req, deps);
    if (!auth.ok) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const response = await handler(req, auth);
    return applySessionHeaders(response, auth, req);
  };
}

export function jsonError(code: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ code, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonBody(data: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  if (!h.has('content-type')) {
    h.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === 'https:';
}

function readSelfCookie(req: Request): string | null {
  const cookies = parseCookies(req.headers.get('cookie'));
  return cookies.get(nodeSessionCookieName(MESH_VIA_SELF)) ?? null;
}
