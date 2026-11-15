import {
  SESSION_RENEWED_HEADER,
  SET_NAV_TICKET_HEADER,
  SET_SESSION_HEADER,
  deleteHeaderPair,
  readHeaderPair,
  setHeaderPair,
} from '@vibeterm/shared/http/mesh-headers';
import {
  appendNavTicketCookie,
  buildClearCookie,
  buildSetCookie,
  legacyNodeSessionCookieName,
  nodeSessionCookieName,
  parseCookies,
  readNodeSessionCookie,
} from '../auth/cookies';
import { NAV_TICKET_MAX_AGE_SEC, parseSetNavHeader } from '../auth/nav-ticket';
import type { NodeSessionRecord, NodeSessionStore } from '../auth/node-session-store';
import { type PopFailureCode, enforceRequestPop } from '../auth/session-pop';
import { isTrustedProxyHop } from './client-ip';
import {
  MESH_VIA_SELF,
  type MeshRoles,
  getMeshRequestContext,
  isStandaloneRoles,
  parseSetSessionHeader,
  requestDispatchContext,
  setMeshRequestContext,
} from './mesh-deps';
import {
  applyShareCookieHeaders,
  hasShareCookieHeaders,
  staleShareCookieNames,
} from './share-credential';

export type AuthenticateOk = {
  ok: true;
  userId: string | null;
  session: NodeSessionRecord | null;
  sid: string | null;
  renewedExpiresAt?: number;
};

/** `pop` 有值：会话本身有效，但缺少或带了无效的持有证明（不等于登出）。 */
export type AuthenticateFail = { ok: false; pop?: PopFailureCode };

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
  const verified = verifyWithPop(req, sid, via, deps);
  if (!verified.ok) {
    return verified;
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

/** 会话校验 + 持有证明：会话有效但证明缺失 / 无效时带 `pop` 失败码返回。 */
function verifyWithPop(
  req: Request,
  sid: string,
  via: string,
  deps: SessionMiddlewareDeps
): { ok: true; session: NodeSessionRecord; renewedExpiresAt?: number } | AuthenticateFail {
  const now = deps.now?.() ?? Date.now();
  const verified = deps.nodeSessionStore.verify(sid, { viaNodeId: via, now });
  if (!verified.ok) return { ok: false };
  const navKey = () => deps.nodeSessionStore.navKey();
  const pop = enforceRequestPop(req, verified.session, { now, navKey });
  return pop ? { ok: false, pop } : verified;
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

/** 本机会话 cookie（via=self，不是规范节点 id）：新旧两个名字都下发。 */
function appendSelfSessionCookie(
  headers: Headers,
  sid: string,
  options: { maxAgeSec: number; secure: boolean }
): void {
  for (const name of [
    nodeSessionCookieName(MESH_VIA_SELF),
    legacyNodeSessionCookieName(MESH_VIA_SELF),
  ]) {
    headers.append('set-cookie', buildSetCookie(name, sid, options));
  }
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
  setHeaderPair(headers, SESSION_RENEWED_HEADER, String(auth.renewedExpiresAt));
  const via = getMeshRequestContext(req).via ?? MESH_VIA_SELF;
  if (via === MESH_VIA_SELF) {
    const maxAgeSec = Math.max(0, Math.floor((auth.renewedExpiresAt - Date.now()) / 1000));
    appendSelfSessionCookie(headers, auth.sid, { maxAgeSec, secure: isHttps(req) });
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
  if (via !== MESH_VIA_SELF) {
    return response;
  }
  const rawSession = readHeaderPair(response.headers, SET_SESSION_HEADER);
  const rawNav = response.headers.get(SET_NAV_TICKET_HEADER);
  const share = hasShareCookieHeaders(response);
  const stale = share ? [] : staleShareCookieNames(req, MESH_VIA_SELF);
  if (!rawSession && rawNav === null && !share && stale.length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  const secure = isHttps(req);
  if (rawNav !== null) applySelfNavCookie(headers, rawNav, secure);
  for (const name of stale) {
    headers.append('set-cookie', buildClearCookie(name, { secure }));
  }
  if (rawSession) applySelfSessionHeader(headers, rawSession, secure);
  if (share) {
    applyShareCookieHeaders(headers, response, MESH_VIA_SELF, secure);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applySelfSessionHeader(headers: Headers, raw: string, secure: boolean): void {
  deleteHeaderPair(headers, SET_SESSION_HEADER);
  const parsed = parseSetSessionHeader(raw);
  if (parsed) appendSelfSessionCookie(headers, parsed.sid, { maxAgeSec: parsed.maxAgeSec, secure });
}

/** 内部头 `x-vibeterm-set-nav` 换成本机导航票据 cookie `vibeterm_n_self`（空票据即清除）。 */
function applySelfNavCookie(headers: Headers, raw: string, secure: boolean): void {
  headers.delete(SET_NAV_TICKET_HEADER);
  const parsed = parseSetNavHeader(raw);
  if (!parsed) return;
  appendNavTicketCookie(headers, MESH_VIA_SELF, parsed.ticket, {
    maxAgeSec: Math.min(parsed.maxAgeSec, NAV_TICKET_MAX_AGE_SEC),
    secure,
  });
}

export function requireSession(
  deps: SessionMiddlewareDeps,
  handler: AuthedHandler
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const auth = authenticateRequest(req, deps);
    if (!auth.ok) {
      return jsonError(auth.pop ?? 'UNAUTHORIZED', 401);
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
  const fallback = new URL(req.url);
  if (!isTrustedProxyHop(req)) {
    return fallback;
  }
  const proto = lastForwarded(req.headers.get('x-forwarded-proto'));
  const host = lastForwarded(req.headers.get('x-forwarded-host'));
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

function lastForwarded(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(',');
  const last = parts[parts.length - 1]?.trim() ?? '';
  return last || null;
}

function readSelfCookie(req: Request): string | null {
  return readNodeSessionCookie(parseCookies(req.headers.get('cookie')), MESH_VIA_SELF);
}
