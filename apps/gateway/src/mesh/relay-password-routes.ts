import { readJsonObjectBody } from '../api/http';
import type { StoredMeshRelay } from '../auth/mesh-relay-store';
import { CryptoDecryptError } from '../crypto/errors';
import { RelayErrorCode } from '../relay/relay-http';
import { readRotateMode, readRotateNext } from '../relay/relay-password-rotate';
import { isPeerRequest } from './client-source';
import { type RelayDialContext, relayDialContextFromEnv } from './relay-dial';
import { relayTenantPost } from './relay-enroll-call';
import { normalizeUrlOrNull, readRelayErrorCode } from './relay-routes-input';
import type { RelaySecrets } from './relay-secrets';
import { jsonBody, jsonError } from './session-middleware';

export type MeshRelayPasswordDeps = {
  secrets: RelaySecrets;
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
};

export function meshRelayPasswordHandlers(
  deps: MeshRelayPasswordDeps
): Record<string, (req: Request) => Promise<Response>> {
  return {
    'GET /password': (req) => handleMeshRelayPasswordGet(deps, req),
    'POST /password': (req) => handleMeshRelayPasswordPost(deps, req),
  };
}

async function attachedRelayOrError(
  store: RelaySecrets['store'],
  url: string
): Promise<StoredMeshRelay | Response> {
  try {
    const row = await store.getRelay(url);
    if (!row) return jsonError(RelayErrorCode.notAttached, 404);
    return row;
  } catch (error) {
    if (error instanceof CryptoDecryptError) return jsonError(RelayErrorCode.notAttached, 404);
    return jsonError('MALFORMED', 400);
  }
}

export async function handleMeshRelayPasswordGet(
  deps: MeshRelayPasswordDeps,
  req: Request
): Promise<Response> {
  if (isPeerRequest(req)) return jsonError('UNAUTHORIZED', 401);
  const url = normalizeUrlOrNull(new URL(req.url).searchParams.get('url'));
  if (!url) return jsonError('INVALID_URL', 400);
  const row = await attachedRelayOrError(deps.secrets.store, url);
  if (row instanceof Response) return row;
  const password = await deps.secrets.store.getEnrollPassword(url);
  const known = password != null && password.length > 0;
  return jsonBody(
    {
      known,
      password: known ? password : null,
      passwordEpoch: deps.secrets.store.getEnrollPasswordEpoch(url),
    },
    200,
    { 'cache-control': 'no-store' }
  );
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
  if (isPeerRequest(req)) return jsonError('UNAUTHORIZED', 401);
  const parsed = parseRotateBody(await readJsonObjectBody(req));
  if (!parsed) return jsonError('MALFORMED', 400);
  const stored = await attachedRelayOrError(deps.secrets.store, parsed.url);
  if (stored instanceof Response) return stored;
  const storedPassword = await deps.secrets.store.getEnrollPassword(parsed.url);
  const usedStored = parsed.current === undefined;
  const current = usedStored ? (storedPassword ?? '') : (parsed.current ?? '');
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
  if (!remote.ok) {
    if (remote.error === RelayErrorCode.enrollPasswordInvalid && usedStored && storedPassword) {
      await deps.secrets.store.setEnrollPassword(parsed.url, null, null);
    }
    return jsonError(remote.error, remote.status, rotateErrorExtra(remote));
  }
  await deps.secrets.store.setEnrollPassword(parsed.url, parsed.next, remote.passwordEpoch);
  return jsonBody({ ok: true, passwordEpoch: remote.passwordEpoch });
}

type RotateCallOk = { ok: true; passwordEpoch: number };
type RotateCallFail = {
  ok: false;
  error: string;
  status: number;
  online?: number;
  admitted?: number;
  retryAfterMs?: number;
};
type RotateCallResult = RotateCallOk | RotateCallFail;

function rotateErrorExtra(remote: RotateCallFail): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (typeof remote.online === 'number') extra.online = remote.online;
  if (typeof remote.admitted === 'number') extra.admitted = remote.admitted;
  if (typeof remote.retryAfterMs === 'number') extra.retryAfterMs = remote.retryAfterMs;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

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
  const posted = await relayTenantPost({
    url: input.url,
    path: '/api/relay/password/rotate',
    token: input.token,
    fetchImpl: input.fetchImpl,
    dial: input.dial ?? relayDialContextFromEnv(),
    body: {
      tenantId: input.tenantId,
      current: input.current,
      next: input.next,
      mode: input.mode,
    },
  });
  if (posted.status === 0) {
    return { ok: false, error: RelayErrorCode.unreachable, status: 502 };
  }
  if (!posted.ok) {
    const code = readRelayErrorCode(posted.payload) ?? RelayErrorCode.unreachable;
    return {
      ok: false,
      error: code,
      status: mapRotateStatus(posted.status, code),
      ...readRotateErrorDetail(posted.payload, posted.retryAfterMs),
    };
  }
  const passwordEpoch =
    typeof posted.payload?.passwordEpoch === 'number' ? posted.payload.passwordEpoch : 0;
  return { ok: true, passwordEpoch };
}

function readRotateErrorDetail(
  payload: Record<string, unknown> | null,
  retryAfterMs?: number
): Pick<RotateCallFail, 'online' | 'admitted' | 'retryAfterMs'> {
  const nested = payload?.error;
  const src =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : payload;
  const extra: Pick<RotateCallFail, 'online' | 'admitted' | 'retryAfterMs'> = {};
  if (typeof src?.online === 'number') extra.online = src.online;
  if (typeof src?.admitted === 'number') extra.admitted = src.admitted;
  const retry = typeof src?.retryAfterMs === 'number' ? src.retryAfterMs : retryAfterMs;
  if (typeof retry === 'number') extra.retryAfterMs = retry;
  return extra;
}

function mapRotateStatus(httpStatus: number, code: string): number {
  if (code === RelayErrorCode.enrollPasswordInvalid) return 401;
  if (code === RelayErrorCode.enrollPasswordTooShort) return 400;
  if (code === RelayErrorCode.membersOffline) return 409;
  if (code === RelayErrorCode.enrollPasswordUnset) return 409;
  if (code === RelayErrorCode.rateLimited || httpStatus === 429) return 429;
  if (httpStatus >= 400 && httpStatus < 500) return httpStatus;
  return 502;
}
