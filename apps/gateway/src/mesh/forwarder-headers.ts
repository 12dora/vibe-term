import {
  CLIENT_SOURCE_HEADER,
  addHeaderNames,
  isVibeTermHeaderName,
} from '@vibeterm/shared/http/mesh-headers';
import { isTokenCredential } from '../auth/access-token-auth';
import { applySafeFileHeaders } from '../files/safe-file-headers';
import { clientIpFromRequest } from './client-ip';

/** 入口把真实客户端 IP 交给目标，只用于登录记录。浏览器自带的同名头一律丢掉。 */
export const ENTRY_CLIENT_IP_HEADER = 'x-vibeterm-entry-client-ip';
export const VIBETERM_CLIENT_HEADER = 'x-vibeterm-client';

const FORWARDED_AUTH_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);
import { SET_SESSION_HEADER } from './mesh-deps';
import { CLEAR_SHARE_HEADER, SET_SHARE_HEADER, SET_SHARE_MAX_AGE_HEADER } from './share-credential';

/** 内部凭证头：Hub 翻成 Set-Cookie 后不得再回给浏览器。 */
const INTERNAL_CREDENTIAL_HEADERS = addHeaderNames(
  new Set<string>(),
  SET_SESSION_HEADER,
  SET_SHARE_HEADER,
  SET_SHARE_MAX_AGE_HEADER,
  CLEAR_SHARE_HEADER
);

const RESPONSE_ALLOW = new Set([
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
]);
const DROP_REQUEST_HEADERS = addHeaderNames(
  new Set([
    'cookie',
    'authorization',
    'host',
    'connection',
    'upgrade',
    'cf-connecting-ip',
    'cf-access-jwt-assertion',
    'cf-access-authenticated-user-email',
    'cf-ray',
  ]),
  CLIENT_SOURCE_HEADER
);

/** `req` 是入口收到的浏览器请求：内联与否按它的 `Sec-Fetch-Dest` 判定，与本机文件响应同一规则。 */
export function copyUpstreamHeaders(upstream: Response, req: Request): Headers {
  const headers = new Headers();
  let contentType: string | null = null;
  let contentDisposition: string | null = null;
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (INTERNAL_CREDENTIAL_HEADERS.has(lower)) return;
    if (lower === 'content-type') {
      contentType = value;
      return;
    }
    if (lower === 'content-disposition') {
      contentDisposition = value;
      return;
    }
    if (RESPONSE_ALLOW.has(lower) || isVibeTermHeaderName(lower)) headers.set(key, value);
  });
  applySafeFileHeaders(headers, { contentType, disposition: contentDisposition, req });
  return headers;
}

export function filterRequestHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      DROP_REQUEST_HEADERS.has(lower) ||
      lower.startsWith('proxy-') ||
      lower.startsWith('x-forwarded-')
    ) {
      return;
    }
    out[key] = value;
  });
  return out;
}

/** `forwardAuthorizedHttp` 的出站头：调用方给的头 + 令牌凭证所需的入口客户端 IP。 */
export function stampedAuthorizedHeaders(
  req: Request,
  given: Record<string, string> | undefined,
  auth: string | null
): Record<string, string> {
  const headers: Record<string, string> = { ...(given ?? {}) };
  deleteHeader(headers, ENTRY_CLIENT_IP_HEADER);
  const ip = isTokenCredential(auth) ? clientIpFromRequest(req) : undefined;
  if (ip) headers[ENTRY_CLIENT_IP_HEADER] = ip;
  return headers;
}

export function stampForwardedAuthHeaders(
  headers: Record<string, string>,
  req: Request,
  rest: string,
  auth: string | null = null
): void {
  deleteHeader(headers, ENTRY_CLIENT_IP_HEADER);
  if (!FORWARDED_AUTH_PATHS.has(rest) && !isTokenCredential(auth)) return;
  const ip = clientIpFromRequest(req);
  if (ip) headers[ENTRY_CLIENT_IP_HEADER] = ip;
  copyIfMissing(headers, req, VIBETERM_CLIENT_HEADER);
  copyIfMissing(headers, req, 'user-agent');
}

function copyIfMissing(headers: Record<string, string>, req: Request, name: string): void {
  if (hasHeader(headers, name)) return;
  const value = req.headers.get(name);
  if (value) headers[name] = value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}
