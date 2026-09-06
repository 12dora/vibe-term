import {
  addHeaderNames,
  assignHeaderPair,
  isVibeTermHeaderName,
} from '@vibeterm/shared/http/mesh-headers';
import { CLIENT_SOURCE_HEADER, CLIENT_SOURCE_LOCAL, isTrustedLocalClient } from './client-source';
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

function baseMime(contentType: string): string {
  return contentType.trim().toLowerCase().split(';')[0]?.trim() ?? '';
}
