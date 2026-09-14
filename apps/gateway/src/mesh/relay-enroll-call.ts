import { bytesToHex, encodeBase64url, sha256 } from '@vibeterm/shared/auth';
import { decodeBase64url } from '@vibeterm/shared/auth';
import { RELAY_TOKEN_HEADER, assignHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import { type RelayDialContext, relayDialContextFromEnv, resolveRelayDialUrl } from './relay-dial';
import { readRelayErrorCode } from './relay-routes-input';

export const RELAY_ENROLL_FETCH_TIMEOUT_MS = 15_000;

export type PersistEnrollPasswordStore = {
  setEnrollPassword(
    url: string,
    plaintext: string | null,
    passwordEpoch?: number | null
  ): Promise<void>;
};

export async function persistAcceptedEnrollPassword(
  store: PersistEnrollPasswordStore,
  url: string,
  password: string | undefined,
  verified: { passwordVerified: boolean; passwordEpoch: number }
): Promise<void> {
  if (verified.passwordVerified !== true) {
    await store.setEnrollPassword(url, null, verified.passwordEpoch);
    return;
  }
  if (typeof password !== 'string') return;
  await store.setEnrollPassword(url, password || null, verified.passwordEpoch);
}

export type RelayEnrollCallInput = {
  password?: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  proof: { bytes: Uint8Array; sig: Uint8Array };
  /** 本机已持有的令牌哈希；与中继当前令牌一致时中继不再换发。 */
  knownTokenHash?: string;
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
  persistStore?: PersistEnrollPasswordStore;
};

export type RelayEnrollCallResult =
  | {
      ok: true;
      tenantId: string;
      token: Uint8Array | null;
      passwordEpoch: number;
      passwordVerified: boolean;
    }
  | { ok: false; error: string; status: number };

export type RelayTenantPostInput = {
  url: string;
  path: string;
  body: unknown;
  token?: Uint8Array;
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
};

export type RelayTenantPostResult = {
  ok: boolean;
  status: number;
  payload: Record<string, unknown> | null;
  retryAfterMs?: number;
};

export function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** 本机代租户 POST 中继租户面；网络层失败 status=0。 */
export async function relayTenantPost(input: RelayTenantPostInput): Promise<RelayTenantPostResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const dialUrl = resolveRelayDialUrl(input.url, input.dial ?? relayDialContextFromEnv());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_ENROLL_FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (input.token) {
      assignHeaderPair(headers, RELAY_TOKEN_HEADER, encodeBase64url(input.token));
    }
    const res = await doFetch(`${dialUrl.replace(/\/+$/, '')}${input.path}`, {
      method: 'POST',
      headers,
      signal: ac.signal,
      body: JSON.stringify(input.body),
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const retryAfterMs = parseRetryAfterMs(res);
    return {
      ok: res.ok,
      status: res.status,
      payload,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  } catch {
    return { ok: false, status: 0, payload: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 与中继 `sha256Hex(token)` 同口径：令牌原文是 b64url 串，先转 UTF-8 再摘要。 */
export function relayTokenHashHex(token: Uint8Array): string {
  return bytesToHex(sha256(new TextEncoder().encode(encodeBase64url(token))));
}

/** `token` 缺席且带 `token_unchanged` = 令牌未换发，调用方沿用本机已存的那一份。 */
function parseEnrollResponse(payload: Record<string, unknown> | null): RelayEnrollCallResult {
  const bad = { ok: false, error: 'RELAY_BAD_RESPONSE', status: 502 } as const;
  const tenantId = typeof payload?.tenant_id === 'string' ? payload.tenant_id : '';
  if (!/^[0-9a-f]{32}$/.test(tenantId)) return bad;
  const passwordEpoch = typeof payload?.password_epoch === 'number' ? payload.password_epoch : 0;
  const passwordVerified =
    payload?.passwordVerified === true || payload?.password_verified === true;
  const token = typeof payload?.token === 'string' ? payload.token : '';
  if (!token) {
    if (payload?.token_unchanged !== true) return bad;
    return { ok: true, tenantId, token: null, passwordEpoch, passwordVerified };
  }
  const tokenBytes = decodeBase64url(token);
  if (tokenBytes.byteLength !== 32) return bad;
  return { ok: true, tenantId, token: tokenBytes, passwordEpoch, passwordVerified };
}

function enrollRequestBody(input: RelayEnrollCallInput): Record<string, unknown> {
  return {
    ...(input.password !== undefined ? { password: input.password } : {}),
    ...(input.knownTokenHash ? { known_token_hash: input.knownTokenHash } : {}),
    root_public_key: encodeBase64url(input.rootPublicKey),
    root_epoch: input.rootEpoch,
    proof: {
      bytes: encodeBase64url(input.proof.bytes),
      sig: encodeBase64url(input.proof.sig),
    },
  };
}

/** 本机代租户去打中继 `POST /api/relay/enroll`；网络层错误一律归到 `RELAY_UNREACHABLE`。 */
export async function callRelayEnroll(
  url: string,
  input: RelayEnrollCallInput
): Promise<RelayEnrollCallResult> {
  const posted = await relayTenantPost({
    url,
    path: '/api/relay/enroll',
    body: enrollRequestBody(input),
    fetchImpl: input.fetchImpl,
    dial: input.dial,
  });
  if (posted.status === 0) return { ok: false, error: 'RELAY_UNREACHABLE', status: 502 };
  if (!posted.ok) {
    const code = readRelayErrorCode(posted.payload) ?? 'RELAY_ENROLL_FAILED';
    return { ok: false, error: code, status: posted.status === 401 ? 401 : 502 };
  }
  const parsed = parseEnrollResponse(posted.payload);
  if (parsed.ok && input.persistStore) {
    await persistAcceptedEnrollPassword(input.persistStore, url, input.password, parsed);
  }
  return parsed;
}
