// `/api/mesh/relay/*` 的入参解析与上游错误码提取：纯函数，与路由类分开放，
// 免得 `relay-routes.ts` 继续朝 600 行门禁上顶。

import { decodeAuthorization, decodeBase64url } from '@tmex/shared/auth';
import { normalizeRelayUrl } from '@tmex/shared/relay';

export type ParsedEnrollment = {
  enrollPk: Uint8Array;
  authorization: Uint8Array;
  authorizationSig: Uint8Array;
  exp: number;
  bodyExp?: number;
};

export function parseEnrollmentBody(body: Record<string, unknown> | null): ParsedEnrollment | null {
  if (!body) return null;
  try {
    const enrollPk = decodeBase64url(String(body.enroll_pk ?? ''));
    const authorization = decodeBase64url(String(body.authorization ?? ''));
    const authorizationSig = decodeBase64url(String(body.authorization_sig ?? ''));
    if (enrollPk.byteLength !== 32 || authorization.byteLength === 0) return null;
    const decoded = decodeAuthorization(authorization);
    return {
      enrollPk,
      authorization,
      authorizationSig,
      exp: Number(decoded.exp),
      ...(typeof body.exp === 'number' ? { bodyExp: body.exp } : {}),
    };
  } catch {
    return null;
  }
}

export function parseStoredJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 中继（运营者侧）的错误体是 `{ error: { code, message } }`（`relay/relay-http.ts` 的 `relayError`）。
 * 只读顶层 `code` 会把 `RELAY_PASSWORD_INVALID` 一律降级成 `RELAY_ENROLL_FAILED`，
 * 浏览器那句「中继口令不正确」就永远出不来。两种形状都认。
 */
export function readRelayErrorCode(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const nested = payload.error;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const code = (nested as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return typeof payload.code === 'string' && payload.code ? payload.code : null;
}

export function normalizeUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeRelayUrl(value.trim());
  } catch {
    return null;
  }
}

export function readProof(value: unknown): { bytes: Uint8Array; sig: Uint8Array } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { bytes?: unknown; sig?: unknown };
  if (typeof raw.bytes !== 'string' || typeof raw.sig !== 'string') return null;
  try {
    const bytes = decodeBase64url(raw.bytes);
    const sig = decodeBase64url(raw.sig);
    if (sig.byteLength !== 64 || bytes.byteLength === 0) return null;
    return { bytes, sig };
  } catch {
    return null;
  }
}
