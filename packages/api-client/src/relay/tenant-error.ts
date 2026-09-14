import { readCodedError } from '../json-mutation';
import { RelayApiError, type RelayApiErrorDetails } from './admin-api';

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
            online?: unknown;
            admitted?: unknown;
            retryAfterMs?: unknown;
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

type DetailBody = {
  lastError?: unknown;
  lastErrorCode?: unknown;
  count?: unknown;
  online?: unknown;
  admitted?: unknown;
  retryAfterMs?: unknown;
};

function detailsFromBody(body: DetailBody): RelayApiErrorDetails | undefined {
  const lastError = readOptionalString(body.lastError);
  const lastErrorCode = readOptionalString(body.lastErrorCode);
  const numbers = readFiniteNumbers(body, ['count', 'online', 'admitted', 'retryAfterMs']);
  if (lastError === undefined && lastErrorCode === undefined && !numbers) return undefined;
  return { lastError, lastErrorCode, ...numbers };
}

function readFiniteNumbers(
  body: DetailBody,
  keys: ReadonlyArray<'count' | 'online' | 'admitted' | 'retryAfterMs'>
): Partial<Record<'count' | 'online' | 'admitted' | 'retryAfterMs', number>> | undefined {
  const out: Partial<Record<'count' | 'online' | 'admitted' | 'retryAfterMs', number>> = {};
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}
