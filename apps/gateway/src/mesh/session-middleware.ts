import { buildSetCookie, nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { NodeSessionRecord, NodeSessionStore } from '../auth/node-session-store';
import {
  MESH_VIA_SELF,
  type MeshRoles,
  X_TMEX_SESSION_RENEWED,
  X_TMEX_SET_SESSION,
  getMeshRequestContext,
  isStandaloneRoles,
  parseSetSessionHeader,
  requestDispatchContext,
  setMeshRequestContext,
} from './mesh-deps';
import { applyShareCookieHeaders, hasShareCookieHeaders } from './share-credential';

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
  trustProxy?: boolean;
  /** standalone 下本机登录门是否已生效；缺省视为未生效（保持历史短路）。 */
  localAuthEffective?: () => boolean;
};

export type AuthedHandler = (req: Request, auth: AuthenticateOk) => Promise<Response> | Response;

function standaloneOpenBypass(deps: SessionMiddlewareDeps): AuthenticateOk | null {
  if (!isStandaloneRoles(deps.roles)) return null;
  if (deps.localAuthEffective?.()) return null;
  return { ok: true, userId: null, session: null, sid: null };
}

/** standalone 开放短路：ok 但无 sid/uid，WS 门应放行而不是 4401。 */
export function isStandaloneOpenAuth(auth: AuthenticateResult): boolean {
  return auth.ok && auth.sid == null && auth.userId == null;
}

export function authenticateRequest(
  req: Request,
  deps: SessionMiddlewareDeps,
  viaOverride?: string
): AuthenticateResult {
  const bypass = standaloneOpenBypass(deps);
  if (bypass) return bypass;
  const dispatch = requestDispatchContext.get(req);
  const ctx = getMeshRequestContext(req);
  const via = viaOverride ?? dispatch?.viaNodeId ?? ctx.via ?? MESH_VIA_SELF;

  if (dispatch && via !== MESH_VIA_SELF && dispatch.uid) {
    const result: AuthenticateOk = {
      ok: true,
      userId: dispatch.uid,
      session: null,
      sid: ctx.auth ?? ctx.sid ?? null,
      ...(dispatch.renewedExpiresAt !== undefined
        ? { renewedExpiresAt: dispatch.renewedExpiresAt }
        : {}),
    };
    attachAuthToRequest(req, result, via);
    return result;
  }

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
  const result: AuthenticateOk = {
    ok: true,
    userId: verified.session.userId,
    session: verified.session,
    sid,
    ...(verified.renewedExpiresAt !== undefined
      ? { renewedExpiresAt: verified.renewedExpiresAt }
      : {}),
  };
  attachAuthToRequest(req, result, via);
  return result;
}

export function attachAuthToRequest(req: Request, auth: AuthenticateOk, via?: string): void {
  const ctx = getMeshRequestContext(req);
  setMeshRequestContext(req, {
    ...ctx,
    via: via ?? ctx.via ?? MESH_VIA_SELF,
    sid: auth.sid,
    uid: auth.userId,
    ...(auth.renewedExpiresAt !== undefined ? { renewedExpiresAt: auth.renewedExpiresAt } : {}),
  });
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

export function applyLocalRenewal(req: Request, response: Response): Response {
  const ctx = getMeshRequestContext(req);
  let next = response;
  if (
    (ctx.via ?? MESH_VIA_SELF) === MESH_VIA_SELF &&
    ctx.renewedExpiresAt !== undefined &&
    ctx.sid
  ) {
    next = applySessionHeaders(
      next,
      {
        ok: true,
        userId: ctx.uid ?? null,
        session: null,
        sid: ctx.sid,
        renewedExpiresAt: ctx.renewedExpiresAt,
      },
      req
    );
  }
  return consumeSetSessionForBrowser(req, next);
}

export function consumeSetSessionForBrowser(req: Request, response: Response): Response {
  const via = getMeshRequestContext(req).via ?? MESH_VIA_SELF;
  const rawSession = response.headers.get(X_TMEX_SET_SESSION);
  const share = hasShareCookieHeaders(response);
  if (!rawSession && !share) {
    return response;
  }
  if (via !== MESH_VIA_SELF) {
    return response;
  }
  const headers = new Headers(response.headers);
  const secure = isHttps(req);
  if (rawSession) {
    headers.delete(X_TMEX_SET_SESSION);
    const parsed = parseSetSessionHeader(rawSession);
    if (parsed) {
      headers.append(
        'set-cookie',
        buildSetCookie(nodeSessionCookieName(MESH_VIA_SELF), parsed.sid, {
          maxAgeSec: parsed.maxAgeSec,
          secure,
        })
      );
    }
  }
  if (share) {
    applyShareCookieHeaders(headers, response, MESH_VIA_SELF, secure);
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
  return publicRequestUrl(req).protocol === 'https:';
}

export function publicRequestUrl(req: Request): URL {
  const ctx = getMeshRequestContext(req);
  const fallback = new URL(req.url);
  if (!ctx.trustProxy || ctx.via !== MESH_VIA_SELF) {
    return fallback;
  }
  const proto = firstForwarded(req.headers.get('x-forwarded-proto'));
  const host = firstForwarded(req.headers.get('x-forwarded-host'));
  if (!proto && !host) {
    return fallback;
  }
  const scheme = proto === 'http' || proto === 'https' ? proto : fallback.protocol.replace(':', '');
  try {
    return new URL(`${scheme}://${host ?? fallback.host}`);
  } catch {
    return fallback;
  }
}

function firstForwarded(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim() ?? '';
  return first || null;
}

function readSelfCookie(req: Request): string | null {
  const cookies = parseCookies(req.headers.get('cookie'));
  return cookies.get(nodeSessionCookieName(MESH_VIA_SELF)) ?? null;
}
