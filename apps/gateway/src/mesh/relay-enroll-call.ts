import { bytesToHex, encodeBase64url, sha256 } from '@vibeterm/shared/auth';
import { decodeBase64url } from '@vibeterm/shared/auth';
import { type RelayDialContext, relayDialContextFromEnv, resolveRelayDialUrl } from './relay-dial';
import { readRelayErrorCode } from './relay-routes-input';

export const RELAY_ENROLL_FETCH_TIMEOUT_MS = 15_000;

export type RelayEnrollCallInput = {
  password?: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  proof: { bytes: Uint8Array; sig: Uint8Array };
  /** 本机已持有的令牌哈希；与中继当前令牌一致时中继不再换发。 */
  knownTokenHash?: string;
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
};

export type RelayEnrollCallResult =
  | { ok: true; tenantId: string; token: Uint8Array | null; passwordEpoch: number }
  | { ok: false; error: string; status: number };

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
  const token = typeof payload?.token === 'string' ? payload.token : '';
  if (!token) {
    if (payload?.token_unchanged !== true) return bad;
    return { ok: true, tenantId, token: null, passwordEpoch };
  }
  const tokenBytes = decodeBase64url(token);
  if (tokenBytes.byteLength !== 32) return bad;
  return { ok: true, tenantId, token: tokenBytes, passwordEpoch };
}

function enrollRequestBody(input: RelayEnrollCallInput): string {
  return JSON.stringify({
    ...(input.password !== undefined ? { password: input.password } : {}),
    ...(input.knownTokenHash ? { known_token_hash: input.knownTokenHash } : {}),
    root_public_key: encodeBase64url(input.rootPublicKey),
    root_epoch: input.rootEpoch,
    proof: {
      bytes: encodeBase64url(input.proof.bytes),
      sig: encodeBase64url(input.proof.sig),
    },
  });
}

/** 本机代租户去打中继 `POST /api/relay/enroll`；网络层错误一律归到 `RELAY_UNREACHABLE`。 */
export async function callRelayEnroll(
  url: string,
  input: RelayEnrollCallInput
): Promise<RelayEnrollCallResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const dialUrl = resolveRelayDialUrl(url, input.dial ?? relayDialContextFromEnv());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_ENROLL_FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(`${dialUrl.replace(/\/+$/, '')}/api/relay/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: enrollRequestBody(input),
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = readRelayErrorCode(payload) ?? 'RELAY_ENROLL_FAILED';
      return { ok: false, error: code, status: res.status === 401 ? 401 : 502 };
    }
    return parseEnrollResponse(payload);
  } catch {
    return { ok: false, error: 'RELAY_UNREACHABLE', status: 502 };
  } finally {
    clearTimeout(timer);
  }
}
