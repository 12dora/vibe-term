import { encodeBase64url } from '@vibeterm/shared/auth';
import { RELAY_TOKEN_HEADER, assignHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import { readJsonObjectBody } from '../api/http';
import { RelayErrorCode } from '../relay/relay-http';
import { readRotateMode, readRotateNext } from '../relay/relay-password-rotate';
import { type RelayDialContext, relayDialContextFromEnv, resolveRelayDialUrl } from './relay-dial';
import { RELAY_ENROLL_FETCH_TIMEOUT_MS } from './relay-enroll-call';
import { normalizeUrlOrNull, readRelayErrorCode } from './relay-routes-input';
import type { RelaySecrets } from './relay-secrets';
import { jsonBody, jsonError } from './session-middleware';

export type MeshRelayPasswordDeps = {
  secrets: RelaySecrets;
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
};

export async function handleMeshRelayPasswordGet(
  deps: MeshRelayPasswordDeps,
  req: Request
): Promise<Response> {
  const url = normalizeUrlOrNull(new URL(req.url).searchParams.get('url'));
  if (!url) return jsonError('INVALID_URL', 400);
  const row = await deps.secrets.store.getRelay(url);
  if (!row) return jsonError(RelayErrorCode.notAttached, 404);
  const known = deps.secrets.store.hasEnrollPassword(url);
  const password = known ? await deps.secrets.store.getEnrollPassword(url) : null;
  return jsonBody({ known, password }, 200, { 'cache-control': 'no-store' });
}

type RotateBody = {
  url: string;
  current?: string;
  next: string | null;
  mode: 'keep' | 'kick';
};

function parseRotateBody(body: Record<string, unknown> | null): RotateBody | null {
  if (!body) return null;
  const url = normalizeUrlOrNull(body.url);
  const mode = readRotateMode(body.mode);
  if (!url || !('next' in body) || !mode) return null;
  if ('current' in body && body.current !== undefined && typeof body.current !== 'string') {
    return null;
  }
  const next = readRotateNext(body.next);
  if (next === undefined) return null;
  return {
    url,
    ...(typeof body.current === 'string' ? { current: body.current } : {}),
    next,
    mode,
  };
}

export async function handleMeshRelayPasswordPost(
  deps: MeshRelayPasswordDeps,
  req: Request
): Promise<Response> {
  const parsed = parseRotateBody(await readJsonObjectBody(req));
  if (!parsed) return jsonError('MALFORMED', 400);
  const stored = await deps.secrets.store.getRelay(parsed.url);
  if (!stored) return jsonError(RelayErrorCode.notAttached, 404);
  const current =
    parsed.current !== undefined
      ? parsed.current
      : ((await deps.secrets.store.getEnrollPassword(parsed.url)) ?? '');
  const remote = await callRelayPasswordRotate({
    url: parsed.url,
    tenantId: stored.tenantId,
    token: stored.token,
    current,
    next: parsed.next,
    mode: parsed.mode,
    fetchImpl: deps.fetchImpl,
    dial: deps.dial,
  });
  if (!remote.ok) return jsonError(remote.error, remote.status);
  await deps.secrets.store.setEnrollPassword(parsed.url, parsed.next);
  return jsonBody({ ok: true, passwordEpoch: remote.passwordEpoch });
}

type RotateCallResult =
  | { ok: true; passwordEpoch: number }
  | { ok: false; error: string; status: number };

async function callRelayPasswordRotate(input: {
  url: string;
  tenantId: string;
  token: Uint8Array;
  current: string;
  next: string | null;
  mode: 'keep' | 'kick';
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
}): Promise<RotateCallResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const dialUrl = resolveRelayDialUrl(input.url, input.dial ?? relayDialContextFromEnv());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_ENROLL_FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(`${dialUrl.replace(/\/+$/, '')}/api/relay/password/rotate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...assignHeaderPair({}, RELAY_TOKEN_HEADER, encodeBase64url(input.token)),
      },
      signal: ac.signal,
      body: JSON.stringify({
        tenantId: input.tenantId,
        current: input.current,
        next: input.next,
        mode: input.mode,
      }),
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = readRelayErrorCode(payload) ?? RelayErrorCode.unreachable;
      return { ok: false, error: code, status: mapRotateStatus(res.status, code) };
    }
    const passwordEpoch = typeof payload?.passwordEpoch === 'number' ? payload.passwordEpoch : 0;
    return { ok: true, passwordEpoch };
  } catch {
    return { ok: false, error: RelayErrorCode.unreachable, status: 502 };
  } finally {
    clearTimeout(timer);
  }
}

function mapRotateStatus(httpStatus: number, code: string): number {
  if (code === RelayErrorCode.enrollPasswordInvalid) return 401;
  if (code === RelayErrorCode.enrollPasswordTooShort) return 400;
  if (code === RelayErrorCode.membersOffline) return 409;
  if (httpStatus === 429) return 429;
  if (httpStatus >= 400 && httpStatus < 500) return httpStatus;
  return 502;
}
