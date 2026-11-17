import {
  CLIENT_SOURCE_HEADER,
  NAV_TICKET_HEADER,
  SET_NAV_TICKET_HEADER,
  addHeaderNames,
  isVibeTermHeaderName,
} from '@vibeterm/shared/http/mesh-headers';
import { isTokenCredential } from '../auth/access-token-auth';
import { toBase64Url } from '../auth/binary';
import { parseCookies, readNavTicketCookie } from '../auth/cookies';
import { POP_ENTRY_PROVEN_HEADER, requestPopProvenKey } from '../auth/session-pop';
import { applySafeFileHeaders } from '../files/safe-file-headers';
import { LOGIN_CODE_PUBLIC_PATHS } from './auth-public-paths';
import { clientIpFromRequest } from './client-ip';

/** 入口把真实客户端 IP 交给目标，只用于登录记录。浏览器自带的同名头一律丢掉。 */
export const ENTRY_CLIENT_IP_HEADER = 'x-vibeterm-entry-client-ip';
export const VIBETERM_CLIENT_HEADER = 'x-vibeterm-client';

const FORWARDED_AUTH_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
  ...LOGIN_CODE_PUBLIC_PATHS,
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
).add(SET_NAV_TICKET_HEADER);

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
    NAV_TICKET_HEADER,
    SET_NAV_TICKET_HEADER,
    POP_ENTRY_PROVEN_HEADER,
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
  deleteHeader(headers, POP_ENTRY_PROVEN_HEADER);
  const ip = isTokenCredential(auth) ? clientIpFromRequest(req) : undefined;
  if (ip) headers[ENTRY_CLIENT_IP_HEADER] = ip;
  // 服务端代发的调用签不了浏览器的证明：本机已凭签名头验过这次请求，就带上那条会话的公钥替它担保，
  // 目标只在自己的会话出自同一次登录（同一把 sk_sess）时认。
  const provenPk = auth && !isTokenCredential(auth) ? requestPopProvenKey(req) : null;
  if (provenPk) headers[POP_ENTRY_PROVEN_HEADER] = toBase64Url(provenPk);
  return headers;
}

/** 浏览器的 `vibeterm_n_<nodeId>` cookie 换成流请求头 `x-vibeterm-nav`，由目标节点验票。 */
export function stampNavTicketHeader(
  headers: Record<string, string>,
  req: Request,
  nodeId: string
): void {
  deleteHeader(headers, NAV_TICKET_HEADER);
  const ticket = readNavTicketCookie(parseCookies(req.headers.get('cookie')), nodeId);
  if (ticket) headers[NAV_TICKET_HEADER] = ticket;
}

export function stampForwardedAuthHeaders(
  headers: Record<string, string>,
  req: Request,
  rest: string,
  auth: string | null = null,
  nodeId?: string
): void {
  deleteHeader(headers, ENTRY_CLIENT_IP_HEADER);
  if (nodeId) stampNavTicketHeader(headers, req, nodeId);
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
