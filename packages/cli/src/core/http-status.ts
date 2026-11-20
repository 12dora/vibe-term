// HTTP 状态码 → CLI 错误。从 http.ts 拆出以保持该文件 ≤ 500 行。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { AuthError, CliError, EXIT_GENERIC, NotFoundError, PermissionError } from './errors';
import { isPopErrorCode, popAuthError, popCodeFromMessage } from './session-pop';
import type { CookieJar } from './session-store';
import type { TokenSource } from './token-store';

/** 会话失效的服务端判词；命中即提示重新登录该 node。 */
const REJECTED_SESSION_REASONS: ReadonlySet<string> = new Set([
  'via_mismatch',
  'expired',
  'revoked',
  'unknown',
  'NODE_LOGIN_REQUIRED',
  'UNAUTHORIZED',
]);

export const TOKEN_SCOPE_CODE = 'TOKEN_SCOPE';

export interface HttpStatusContext {
  entry: string;
  jar: CookieJar;
  tokens?: TokenSource | null;
}

/**
 * 入口「没有任何凭据」：jar 里没有 self 行（有 sid 就算，过期也算），且 tokens 里没有 self。
 * 只有这时才走名册 fallback / 裸目标按节点名路由 / 新的入口无会话文案。
 */
export function hasEntryCredential(jar: CookieJar, tokens?: TokenSource | null): boolean {
  if (jar.get(SELF_NODE_ID)?.sid) return true;
  return Boolean(tokens?.get(SELF_NODE_ID));
}

function reasonFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    if (typeof parsed.code === 'string') return parsed.code;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON 体：没有业务码
  }
  return null;
}

/** 入口代操作的 401 体会带目标 `nodeId`；比请求自身的 `self` 更准。 */
function nodeIdFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { nodeId?: unknown };
    if (typeof parsed.nodeId === 'string' && parsed.nodeId) return parsed.nodeId;
  } catch {
    // 非 JSON 体
  }
  return null;
}

/**
 * 403 里仍属于「会话 / 需要登录」的判词。其余 403（`outside_roots`、`FORBIDDEN`、
 * `UPGRADE_NOT_ALLOWED`、`peer_mismatch` 等）是权限不足，重新登录也没用。
 */
function isAuthErrorCode(code: string | null): boolean {
  if (!code) return false;
  return (
    REJECTED_SESSION_REASONS.has(code) ||
    code.startsWith('SESSION_') ||
    code.endsWith('LOGIN_REQUIRED')
  );
}

/** 401，或 403 且业务码属于会话失效（`via_mismatch` / `expired` / `revoked` / `SESSION_*`）。 */
export function isSessionAuthFailure(status: number, body: string): boolean {
  const code = reasonFromBody(body);
  if (isPopErrorCode(code)) return false;
  if (status === 401) return true;
  if (status !== 403) return false;
  return isAuthErrorCode(code);
}

function isUnupgradedAuthPath(path: string): boolean {
  return path.includes('/api/auth/login-records') || path.includes('/api/auth/login-policy');
}

function forbiddenError(path: string, code: string | null, body: string): PermissionError {
  const detail = body && body !== code ? `: ${body}` : '';
  return new PermissionError(`${path} → ${code ?? 'forbidden'}${detail}`.trim(), code ?? undefined);
}

function isNotFoundStatus(status: number, path: string): boolean {
  return status === 404 || (status === 405 && isUnupgradedAuthPath(path));
}

function notFoundError(path: string, status: number, body: string): NotFoundError {
  const detail = status === 405 ? 'needs upgrade to 2.10.0' : body || 'not found';
  return new NotFoundError(`${path} → ${status} ${detail}`);
}

/** 令牌调用方越权：重新登录救不了，要换一把带对应 scope 的令牌。 */
function tokenScopeError(path: string): PermissionError {
  return new PermissionError(
    `access token lacks the scope for ${path} (TOKEN_SCOPE)`,
    TOKEN_SCOPE_CODE,
    'create a token with the needed scope: vibeterm token create --name <name> --scope exec,files,forward; or log in: vibeterm login'
  );
}

export function missingEntrySessionError(entry: string, reason?: string | null): AuthError {
  const known = reason && REJECTED_SESSION_REASONS.has(reason);
  return new AuthError(
    `this command runs on the entry ${entry}, which has no session`,
    'run: vibeterm login, or redeem a login command that includes the entry',
    known ? reason : undefined
  );
}

/** SELF 上的会话鉴权失败，且入口没有任何凭据（PoP 不算）。 */
export function isEntryAuthFallback(
  error: unknown,
  jar: CookieJar,
  tokens?: TokenSource | null
): boolean {
  if (!(error instanceof AuthError)) return false;
  if (isPopErrorCode(error.code)) return false;
  return !hasEntryCredential(jar, tokens);
}

function missingEntryCredential(ctx: HttpStatusContext | undefined): boolean {
  return Boolean(ctx && !hasEntryCredential(ctx.jar, ctx.tokens));
}

function isLoginRequiredCode(code: string | null): boolean {
  return Boolean(code?.endsWith('LOGIN_REQUIRED'));
}

/** 体里点名了别的 node，或业务码是 `*_LOGIN_REQUIRED`：401 是目标节点的，不是入口自己。 */
function isTargetNodeAuth(body: string, code: string | null): boolean {
  const target = nodeIdFromBody(body);
  if (target && target !== SELF_NODE_ID) return true;
  return isLoginRequiredCode(code);
}

/** 入口自身 401（无目标 nodeId / 非 LOGIN_REQUIRED）且入口没有任何凭据。 */
function isEntryUnauthenticated(
  nodeId: string,
  status: number,
  body: string,
  code: string | null,
  ctx?: HttpStatusContext
): ctx is HttpStatusContext {
  if (status !== 401 || nodeId !== SELF_NODE_ID || !ctx) return false;
  if (!missingEntryCredential(ctx)) return false;
  return !isTargetNodeAuth(body, code);
}

function sessionStatusError(
  nodeId: string,
  status: number,
  body: string,
  code: string | null,
  ctx?: HttpStatusContext
): CliError | null {
  if (isEntryUnauthenticated(nodeId, status, body, code, ctx)) {
    return missingEntrySessionError(ctx.entry, code);
  }
  if (status === 401 || (status === 403 && isAuthErrorCode(code))) {
    return loginRequiredError(nodeId, body);
  }
  return null;
}

function forbiddenStatusError(path: string, code: string | null, body: string): CliError {
  return code === TOKEN_SCOPE_CODE ? tokenScopeError(path) : forbiddenError(path, code, body);
}

function genericStatusError(
  path: string,
  status: number,
  body: string,
  code: string | null
): CliError {
  return new CliError(
    `${path} → HTTP ${status} ${body}`.trim(),
    EXIT_GENERIC,
    undefined,
    code ?? undefined
  );
}

/**
 * 非 2xx 响应 → CliError：401 与会话类 403 提示重新登录（退出码 3），其余 403 是权限
 * 不足（退出码 1，message 带服务端的业务码），404 → 4，其它 → 1。
 */
export function httpStatusError(
  nodeId: string,
  path: string,
  status: number,
  body: string,
  ctx?: HttpStatusContext
): CliError {
  const code = reasonFromBody(body);
  if (code && isPopErrorCode(code)) return popAuthError(code);
  const session = sessionStatusError(nodeId, status, body, code, ctx);
  if (session) return session;
  if (status === 403) return forbiddenStatusError(path, code, body);
  if (isNotFoundStatus(status, path)) return notFoundError(path, status, body);
  return genericStatusError(path, status, body, code);
}

export function loginRequiredError(nodeId: string, body: string): AuthError {
  const pop = popCodeFromMessage(body);
  if (pop) return popAuthError(pop);
  const reason = reasonFromBody(body);
  const hintNode = nodeIdFromBody(body) ?? nodeId;
  const target = hintNode === SELF_NODE_ID ? '' : ` --node ${hintNode}`;
  const known = reason && REJECTED_SESSION_REASONS.has(reason);
  const detail = reason ? ` (${reason})` : '';
  return new AuthError(
    `not authenticated for node ${hintNode}${detail}`,
    `run: vibeterm login${target}`,
    known ? reason : undefined
  );
}
