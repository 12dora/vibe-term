import {
  addHeaderNames,
  assignHeaderPair,
  isVibeTermHeaderName,
} from '@vibeterm/shared/http/mesh-headers';
import { clientIpFromRequest } from './client-ip';
import { CLIENT_SOURCE_HEADER, CLIENT_SOURCE_LOCAL, isTrustedLocalClient } from './client-source';

/** 入口把真实客户端 IP 交给目标，只用于登录记录。浏览器自带的同名头一律丢掉。 */
export const ENTRY_CLIENT_IP_HEADER = 'x-vibeterm-entry-client-ip';
export const VIBETERM_CLIENT_HEADER = 'x-vibeterm-client';

const FORWARDED_AUTH_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);
import { MESH_ALLOWED_MIME, MESH_FORWARD_CSP, SET_SESSION_HEADER } from './mesh-deps';
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

export function copyUpstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  let contentType = '';
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
  const mime = baseMime(contentType);
  if (mime && MESH_ALLOWED_MIME.has(mime)) {
    headers.set('content-type', contentType || mime);
    if (contentDisposition) headers.set('content-disposition', contentDisposition);
  } else {
    headers.set('content-type', 'application/octet-stream');
    headers.set('content-disposition', 'attachment');
  }
  headers.set('content-security-policy', MESH_FORWARD_CSP);
  headers.set('x-content-type-options', 'nosniff');
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
  if (isTrustedLocalClient(req)) {
    assignHeaderPair(out, CLIENT_SOURCE_HEADER, CLIENT_SOURCE_LOCAL);
  }
  return out;
}

export function stampForwardedAuthHeaders(
  headers: Record<string, string>,
  req: Request,
  rest: string
): void {
  deleteHeader(headers, ENTRY_CLIENT_IP_HEADER);
  if (!FORWARDED_AUTH_PATHS.has(rest)) return;
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

function baseMime(contentType: string): string {
  return contentType.trim().toLowerCase().split(';')[0]?.trim() ?? '';
}
