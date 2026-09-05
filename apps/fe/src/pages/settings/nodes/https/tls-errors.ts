import { TlsApiError } from '@tmex/api-client/local/tls-api';
import { errorMessage } from '@tmex/shared';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const ERROR_PREFIX = 'nodes.https.errors.';

const KNOWN_ERROR_CODES = new Set([
  'invalid_sans',
  'invalid_domain',
  'invalid_email',
  'cloudflare_token_required',
  'dns_provider_required',
  'dns_credentials_required',
  'invalid_port',
  'port_in_use',
  'tls_failed',
  'not_applicable',
  'no_ca',
  'unauthorized',
]);

/** 已知错误码返回 `nodes.https.errors.<code>`；未知返回 null。 */
export function tlsErrorKey(code: string): string | null {
  return KNOWN_ERROR_CODES.has(code) ? `${ERROR_PREFIX}${code}` : null;
}

/** 后端错误码优先走本地化文案；未知码退化成「未知错误 + 原始 message」。 */
export function describeTlsError(t: Translate, error: unknown): string {
  if (error instanceof TlsApiError) {
    const key = tlsErrorKey(error.code);
    if (key) return t(key);
    return t(`${ERROR_PREFIX}unknown`, { message: error.message || error.code });
  }
  const message = errorMessage(error);
  return t(`${ERROR_PREFIX}unknown`, { message });
}
