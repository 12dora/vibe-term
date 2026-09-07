import { readCodedError } from '../json-mutation';
import { RelayApiError } from './admin-api';

/**
 * `/api/mesh/relay/*` 的错误体是 `{ code, ... }`（`session-middleware.ts` 的 `jsonError`），
 * 与运营者侧的 `{ error: { code, message } }` 不同一形，这里两种都认。
 */
export function readRelayTenantError(res: Response, fallback: string): Promise<RelayApiError> {
  return readCodedError(
    res,
    fallback,
    (code, message, status) => new RelayApiError(code, message, status),
    (body, status) => {
      const own = body as
        | {
            code?: unknown;
            reason?: unknown;
            lastError?: unknown;
            lastErrorCode?: unknown;
            count?: unknown;
          }
        | undefined;
      if (own && typeof own.code === 'string') {
        const reason = typeof own.reason === 'string' ? `${own.code}: ${own.reason}` : own.code;
        return new RelayApiError(own.code, reason, status, detailsFromBody(own));
      }
      return undefined;
    }
  );
}

function detailsFromBody(body: { lastError?: unknown; lastErrorCode?: unknown; count?: unknown }) {
  const lastError = readOptionalString(body.lastError);
  const lastErrorCode = readOptionalString(body.lastErrorCode);
  const count =
    typeof body.count === 'number' && Number.isFinite(body.count) ? body.count : undefined;
  if (lastError === undefined && lastErrorCode === undefined && count === undefined)
    return undefined;
  return { lastError, lastErrorCode, ...(count === undefined ? {} : { count }) };
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}
