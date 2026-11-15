import type { AuthenticateResult } from '../../../../apps/gateway/src/mesh/session-middleware';
import { errorMessage } from '../lib/error-message';
import { SetupError } from './setup-service';

export { JSON_BODY_MAX_BYTES, readJsonBody } from '../../../shared/src/http/read-body';

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonErr(code: string, message: string, status: number): Response {
  return jsonOk({ error: { code, message } }, status);
}

/**
 * 鉴权失败的 401：会话有效但持有证明缺失 / 无效时回顶层 `{ code: 'POP_REQUIRED' | 'POP_INVALID' }`
 * （与网关 `jsonError` 同形，客户端据此重签而不是登出），其余仍是 `{ error: { code, message } }`。
 */
export function authFailure(auth: AuthenticateResult | undefined, code = 'UNAUTHORIZED'): Response {
  if (auth && !auth.ok && auth.pop) return jsonOk({ code: auth.pop }, 401);
  return jsonErr(code, 'login required', 401);
}

export function mapError(error: unknown, fallback = 'internal_error'): Response {
  if (error instanceof SetupError) {
    return jsonErr(error.code, error.message, error.httpStatus);
  }
  const message = errorMessage(error);
  return jsonErr(fallback, message, 500);
}
