import { encodeBase64url } from '@tmex/shared/auth';
import type { StoredMeshRelayRow } from '../auth/mesh-relay-store';
import { type RelayDialContext, resolveRelayDialUrl } from './relay-dial';
import { readRelayErrorCode } from './relay-routes-input';
import type { RelaySecrets } from './relay-secrets';

export const RELAY_ENROLLMENT_FANOUT_TIMEOUT_MS = 5_000;

export type JoinMaterialRelay = { url: string; tenantId: string; token: string };

export type EnrollmentFanoutAccepted = {
  url: string;
  tenantId: string;
  token: string;
  accepted: true;
};

export type EnrollmentFanoutRejected = {
  url: string;
  tenantId: string;
  accepted: false;
  error: string;
};

export type EnrollmentFanoutResult = EnrollmentFanoutAccepted | EnrollmentFanoutRejected;

export type EnrollmentFanoutPayload = {
  id: string;
  enrollPk: Uint8Array;
  authorization: Uint8Array;
  authorizationSig: Uint8Array;
  exp: number;
};

export async function collectJoinMaterialRelays(
  secrets: RelaySecrets,
  targets: readonly { url: string }[]
): Promise<JoinMaterialRelay[]> {
  const relays: JoinMaterialRelay[] = [];
  for (const target of targets) {
    const relay = await secrets.store.getRelay(target.url);
    if (!relay) continue;
    relays.push({
      url: target.url,
      tenantId: relay.tenantId,
      token: encodeBase64url(relay.token),
    });
  }
  return relays;
}

function isUnreachableError(error: string): boolean {
  return error === 'timeout' || error === 'RELAY_UNREACHABLE';
}

/** 旧版 attached 中继没有新 HTTP collection 路由时，回退到 uplink `relay.enroll.create`。 */
function isMissingHttpRouteError(error: string): boolean {
  return (
    error === 'RELAY_NOT_FOUND' ||
    error === 'RELAY_METHOD_NOT_ALLOWED' ||
    error === 'HTTP_404' ||
    error === 'HTTP_405'
  );
}

function shouldFallbackToUplink(error: string, attached: boolean): boolean {
  if (isUnreachableError(error)) return true;
  return attached && isMissingHttpRouteError(error);
}

async function postEnrollmentHttp(input: {
  url: string;
  tenantId: string;
  token: string;
  payload: EnrollmentFanoutPayload;
  doFetch: typeof fetch;
  dial: RelayDialContext;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const dialUrl = resolveRelayDialUrl(input.url, input.dial);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), input.timeoutMs);
  try {
    const res = await input.doFetch(
      `${dialUrl.replace(/\/+$/, '')}/api/relay/tenants/${input.tenantId}/enrollments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tmex-relay-token': input.token,
        },
        body: JSON.stringify({
          id: input.payload.id,
          enroll_pk: encodeBase64url(input.payload.enrollPk),
          authorization: encodeBase64url(input.payload.authorization),
          authorization_sig: encodeBase64url(input.payload.authorizationSig),
          exp: input.payload.exp,
        }),
        signal: ac.signal,
      }
    );
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: false, error: readRelayErrorCode(body) ?? `HTTP_${res.status}` };
  } catch {
    return { ok: false, error: ac.signal.aborted ? 'timeout' : 'RELAY_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

async function createOnOneRelay(input: {
  row: StoredMeshRelayRow;
  token: string;
  payload: EnrollmentFanoutPayload;
  doFetch: typeof fetch;
  dial: RelayDialContext;
  timeoutMs: number;
  attachedUrl: string | null;
  uplinkCreate?: () => Promise<{ ok: boolean; error?: string }>;
}): Promise<EnrollmentFanoutResult> {
  const http = await postEnrollmentHttp({
    url: input.row.url,
    tenantId: input.row.tenantId,
    token: input.token,
    payload: input.payload,
    doFetch: input.doFetch,
    dial: input.dial,
    timeoutMs: input.timeoutMs,
  });
  if (http.ok) {
    return {
      url: input.row.url,
      tenantId: input.row.tenantId,
      token: input.token,
      accepted: true,
    };
  }
  const uplinkCreate = input.uplinkCreate;
  const attached = input.attachedUrl === input.row.url;
  if (uplinkCreate && attached && shouldFallbackToUplink(http.error, true)) {
    const ack = await uplinkCreate();
    if (ack.ok) {
      return {
        url: input.row.url,
        tenantId: input.row.tenantId,
        token: input.token,
        accepted: true,
      };
    }
    return {
      url: input.row.url,
      tenantId: input.row.tenantId,
      accepted: false,
      error: ack.error ?? 'RELAY_REJECTED',
    };
  }
  return {
    url: input.row.url,
    tenantId: input.row.tenantId,
    accepted: false,
    error: http.error,
  };
}

/** 对 `mesh_relays` 每一行并发 POST enrollment；HTTP 够不着 attached 那台时才退回 uplink。 */
export async function fanOutEnrollmentCreate(input: {
  secrets: RelaySecrets;
  rows: readonly StoredMeshRelayRow[];
  payload: EnrollmentFanoutPayload;
  fetchImpl: typeof fetch;
  dial: RelayDialContext;
  timeoutMs: number;
  attachedUrl: string | null;
  uplinkCreate?: () => Promise<{ ok: boolean; error?: string }>;
}): Promise<EnrollmentFanoutResult[]> {
  const settled = await Promise.allSettled(
    input.rows.map(async (row) => {
      const relay = await input.secrets.store.getRelay(row.url);
      if (!relay) {
        return {
          url: row.url,
          tenantId: row.tenantId,
          accepted: false as const,
          error: 'RELAY_KEY_MISSING',
        };
      }
      return createOnOneRelay({
        row,
        token: encodeBase64url(relay.token),
        payload: input.payload,
        doFetch: input.fetchImpl,
        dial: input.dial,
        timeoutMs: input.timeoutMs,
        attachedUrl: input.attachedUrl,
        uplinkCreate: input.uplinkCreate,
      });
    })
  );
  return settled.map((item, index) => {
    if (item.status === 'fulfilled') return item.value;
    const row = input.rows[index];
    return {
      url: row?.url ?? '',
      tenantId: row?.tenantId ?? '',
      accepted: false as const,
      error: 'RELAY_UNREACHABLE',
    };
  });
}
