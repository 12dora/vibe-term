import {
  ACCESS_TOKEN_EXPIRES_DAYS_MAX,
  ACCESS_TOKEN_NAME_MAX,
  type AccessTokenListResponse,
  type AccessTokenScope,
  type CreateAccessTokenRequest,
  isAccessTokenScope,
} from '@vibeterm/shared';
import { AccessTokenLimitError, getAccessTokenService } from '../auth/access-tokens';
import { loginRecordIp } from '../auth/login-records-meta';
import { requestDispatchContext } from '../mesh/types';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

export const ACCESS_TOKEN_COLLECTION_PATH = '/api/auth/tokens';

export function isAccessTokenPath(path: string): boolean {
  return (
    path === ACCESS_TOKEN_COLLECTION_PATH || path.startsWith(`${ACCESS_TOKEN_COLLECTION_PATH}/`)
  );
}

function fail(code: string, status: number, message: string): Response {
  return json({ code, message }, status);
}

/**
 * 管理接口只认真实节点会话：可信上下文带 tokenId 的令牌调用方一律拒绝（fail-closed：
 * 有 uid 但没有会话 id 这一正向标记也不放行）；没有用户（standalone 开放模式）也无从归属。
 */
function sessionUid(req: Request): string | Response {
  const ctx = requestDispatchContext.get(req);
  if (ctx?.tokenId) {
    return fail('TOKEN_SCOPE', 403, 'access tokens cannot manage access tokens');
  }
  if (!ctx?.uid || !ctx.sid) return fail('UNAUTHORIZED', 401, 'login required');
  return ctx.uid;
}

function clientIp(req: Request): string | null {
  try {
    return loginRecordIp(req);
  } catch {
    return null;
  }
}

function parseScopes(raw: unknown): AccessTokenScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const scopes: AccessTokenScope[] = [];
  for (const item of raw) {
    if (!isAccessTokenScope(item) || scopes.includes(item)) return null;
    scopes.push(item);
  }
  return scopes;
}

function parseExpiresInDays(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  if (raw < 1 || raw > ACCESS_TOKEN_EXPIRES_DAYS_MAX) return undefined;
  return raw;
}

function parseCreateRequest(body: Record<string, unknown>): CreateAccessTokenRequest | null {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > ACCESS_TOKEN_NAME_MAX) return null;
  const scopes = parseScopes(body.scopes);
  if (!scopes) return null;
  const expiresInDays = parseExpiresInDays(body.expiresInDays);
  if (expiresInDays === undefined) return null;
  return { name, scopes, expiresInDays };
}

function handleList(req: Request): Response {
  const uid = sessionUid(req);
  if (typeof uid !== 'string') return uid;
  const body: AccessTokenListResponse = { tokens: getAccessTokenService().list(uid) };
  return json(body);
}

async function handleCreate(req: Request): Promise<Response> {
  const uid = sessionUid(req);
  if (typeof uid !== 'string') return uid;
  const body = await readJsonObjectBody(req);
  const parsed = body ? parseCreateRequest(body) : null;
  if (!parsed) return fail('invalid_body', 400, 'invalid access token request');
  try {
    return json(getAccessTokenService().create(uid, parsed, clientIp(req)), 201);
  } catch (err) {
    if (err instanceof AccessTokenLimitError) {
      return fail('token_limit', 409, 'too many active access tokens');
    }
    throw err;
  }
}

function handleRevoke(req: Request, id: string): Response {
  const uid = sessionUid(req);
  if (typeof uid !== 'string') return uid;
  if (!getAccessTokenService().revoke(uid, id, clientIp(req))) {
    return fail('not_found', 404, 'access token not found');
  }
  return new Response(null, { status: 204 });
}

export const accessTokenRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: ACCESS_TOKEN_COLLECTION_PATH,
    handler: (req) => handleList(req),
  }),
  route({
    method: 'POST',
    path: ACCESS_TOKEN_COLLECTION_PATH,
    handler: (req) => handleCreate(req),
  }),
  route({
    method: 'DELETE',
    path: `${ACCESS_TOKEN_COLLECTION_PATH}/:id`,
    handler: (req, params) => handleRevoke(req, params.id),
  }),
];
