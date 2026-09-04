import { CLIENT_SOURCE_LOCAL, X_TMEX_CLIENT_SOURCE, isTrustedLocalClient } from './client-source';
import { MESH_ALLOWED_MIME, MESH_FORWARD_CSP, X_TMEX_SET_SESSION } from './mesh-deps';

const RESPONSE_ALLOW = new Set([
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
]);
const DROP_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'connection',
  'upgrade',
  'cf-connecting-ip',
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
  'cf-ray',
  X_TMEX_CLIENT_SOURCE,
]);

export function copyUpstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  let contentType = '';
  let contentDisposition: string | null = null;
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === X_TMEX_SET_SESSION) return;
    if (lower === 'content-type') {
      contentType = value;
      return;
    }
    if (lower === 'content-disposition') {
      contentDisposition = value;
      return;
    }
    if (RESPONSE_ALLOW.has(lower) || lower.startsWith('x-tmex-')) headers.set(key, value);
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
    out[X_TMEX_CLIENT_SOURCE] = CLIENT_SOURCE_LOCAL;
  }
  return out;
}

function baseMime(contentType: string): string {
  return contentType.trim().toLowerCase().split(';')[0]?.trim() ?? '';
}
