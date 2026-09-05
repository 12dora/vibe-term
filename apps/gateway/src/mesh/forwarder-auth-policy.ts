import {
  appendNodeSessionCookie,
  clearNodeSessionCookie,
  nodeSessionCookieName,
  parseCookies,
} from '../auth/cookies';
import { AUTH_LOGIN_PUBLIC_PATHS } from './auth-public-paths';
import {
  AUTH_401_BODY_LIMIT,
  X_TMEX_SESSION_RENEWED,
  X_TMEX_SET_SESSION,
  parseSetSessionHeader,
} from './mesh-deps';
import { isHttps } from './session-middleware';
import { applyShareCookieHeaders } from './share-credential';

export const AUTH_SKIP = AUTH_LOGIN_PUBLIC_PATHS;
export const AUTH_CHALLENGE_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/passkey/login/options',
]);
export const AUTH_LOGIN_PATH = '/api/auth/login';

const DROP_ON_401_REWRITE = new Set([
  'content-length',
  'content-range',
  'etag',
  'content-disposition',
]);

export async function applyAuthPolicy(
  req: Request,
  headers: Headers,
  upstream: Response,
  nodeId: string,
  skip401Rewrite = false
): Promise<Response | null> {
  const parsed = parseSetSessionHeader(upstream.headers.get(X_TMEX_SET_SESSION) ?? '');
  const secure = isHttps(req);
  applyShareCookieHeaders(headers, upstream, nodeId, secure);
  const presented = parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId));
  if (parsed) {
    appendNodeSessionCookie(headers, nodeId, parsed.sid, { maxAgeSec: parsed.maxAgeSec, secure });
  }
  const renewed = upstream.headers.get(X_TMEX_SESSION_RENEWED);
  if (renewed) {
    headers.set(X_TMEX_SESSION_RENEWED, renewed);
    const expiresAt = Number(renewed);
    if (presented && Number.isFinite(expiresAt)) {
      appendNodeSessionCookie(headers, nodeId, presented, {
        maxAgeSec: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
        secure,
      });
    }
  }
  if (upstream.status !== 401 || skip401Rewrite) return null;
  const raw = await readBodyLimited(upstream, AUTH_401_BODY_LIMIT);
  let body: Record<string, unknown> = { code: 'NODE_LOGIN_REQUIRED', nodeId };
  try {
    const parsedBody = JSON.parse(raw) as unknown;
    if (typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)) {
      body = { ...(parsedBody as Record<string, unknown>), code: 'NODE_LOGIN_REQUIRED', nodeId };
    }
  } catch {
    if (raw) body.message = raw;
  }
  for (const name of DROP_ON_401_REWRITE) headers.delete(name);
  headers.set('content-type', 'application/json');
  if (shouldExpirePresentedCookie(presented, body)) {
    clearNodeSessionCookie(headers, nodeId, { secure });
  }
  return new Response(JSON.stringify(body), { status: 401, headers });
}

/**
 * 只清理「请求带了、而目标节点的会话校验明确判为无效」的 cookie（stream-targets 的 verifyAuth
 * 原因）。请求没带 cookie 的 401（登录前并发发出的请求）不能清：它的响应可能晚于登录的
 * Set-Cookie 到达，把刚签发的会话删掉；目标上其它按入口会话鉴权的 401（如 /api/mesh/connection）
 * 也不是会话失效，同样不能清。
 */
function shouldExpirePresentedCookie(
  presented: string | undefined,
  body: Record<string, unknown>
): boolean {
  if (!presented) return false;
  return typeof body.error === 'string' && REJECTED_SESSION_REASONS.has(body.error);
}

const REJECTED_SESSION_REASONS: ReadonlySet<string> = new Set([
  'via_mismatch',
  'expired',
  'revoked',
  'unknown',
]);

export async function peekJsonCode(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
    const rec = parsed as { code?: unknown; error?: unknown };
    if (typeof rec.code === 'string') return rec.code;
    if (typeof rec.error === 'string') return rec.error;
    return '';
  } catch {
    return '';
  }
}

async function readBodyLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, limit - total);
      if (take <= 0) {
        await reader.cancel();
        break;
      }
      chunks.push(take < value.byteLength ? value.subarray(0, take) : value);
      total += take;
      if (take < value.byteLength) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    try {
      await reader.cancel();
    } catch {}
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}
