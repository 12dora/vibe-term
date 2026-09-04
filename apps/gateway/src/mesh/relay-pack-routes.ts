import { encodeBase64url } from '@tmex/shared/auth';
import {
  RELAY_PACK_MAX_BYTES,
  kdfParamsFromWire,
  kdfParamsToWire,
  relaySeqFromWire,
} from '@tmex/shared/relay';
import { readJsonObjectBody } from '../api/http';
import { decodeB64url } from '../api/route-input';
import { type RelayDialContext, relayDialContextFromEnv, resolveRelayDialUrl } from './relay-dial';
import type { RelaySecrets } from './relay-secrets';
import { jsonBody, jsonError } from './session-middleware';

export const RELAY_PACK_FORWARD_TIMEOUT_MS = 15_000;

export type MeshRelayPackDeps = {
  secrets: RelaySecrets;
  fetchImpl?: typeof fetch;
  dial?: RelayDialContext;
  now?: () => number;
};

export type MeshRelayPackBody = {
  sealed_pack: string;
  kdf_params: ReturnType<typeof kdfParamsToWire>;
  root_epoch: number;
  head_seq: number | string;
  urls?: string[];
};

/** FE / CLI 在持有根种子时密封后提交；节点把密封包转发到已配置的中继。 */
export function parseMeshRelayPackBody(
  body: Record<string, unknown> | null
): MeshRelayPackBody | null {
  if (!body) return null;
  if (typeof body.sealed_pack !== 'string' || !body.sealed_pack) return null;
  const kdf = kdfParamsFromWire(body.kdf_params);
  if (!kdf) return null;
  if (
    typeof body.root_epoch !== 'number' ||
    !Number.isInteger(body.root_epoch) ||
    body.root_epoch < 0
  ) {
    return null;
  }
  try {
    relaySeqFromWire(body.head_seq as number | string);
  } catch {
    return null;
  }
  let sealed: Uint8Array;
  try {
    sealed = decodeB64url(body.sealed_pack);
  } catch {
    return null;
  }
  if (sealed.byteLength === 0 || sealed.byteLength > RELAY_PACK_MAX_BYTES) return null;
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
    : undefined;
  return {
    sealed_pack: body.sealed_pack,
    kdf_params: kdfParamsToWire(kdf),
    root_epoch: body.root_epoch,
    head_seq: body.head_seq as number | string,
    ...(urls && urls.length > 0 ? { urls } : {}),
  };
}

export async function handleMeshRelayPack(
  deps: MeshRelayPackDeps,
  req: Request
): Promise<Response> {
  const parsed = parseMeshRelayPackBody(await readJsonObjectBody(req));
  if (!parsed) return jsonError('MALFORMED', 400);
  const rows = deps.secrets.relayRows();
  if (rows.length === 0) return jsonError('RELAY_NOT_CONFIGURED', 409);
  const wanted = parsed.urls ? new Set(parsed.urls) : null;
  const targets = wanted ? rows.filter((row) => wanted.has(row.url)) : rows;
  if (targets.length === 0) return jsonError('RELAY_NOT_FOUND', 404);
  const doFetch = deps.fetchImpl ?? fetch;
  const dial = deps.dial ?? relayDialContextFromEnv();
  const payload = JSON.stringify({
    sealed_pack: parsed.sealed_pack,
    kdf_params: parsed.kdf_params,
    root_epoch: parsed.root_epoch,
    head_seq: parsed.head_seq,
  });
  const results: Array<{ url: string; ok: boolean; status: number; code?: string }> = [];
  for (const row of targets) {
    const relay = await deps.secrets.store.getRelay(row.url);
    if (!relay) {
      results.push({ url: row.url, ok: false, status: 0, code: 'RELAY_KEY_MISSING' });
      continue;
    }
    const dialUrl = resolveRelayDialUrl(row.url, dial);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RELAY_PACK_FORWARD_TIMEOUT_MS);
    try {
      const res = await doFetch(
        `${dialUrl.replace(/\/+$/, '')}/api/relay/tenants/${relay.tenantId}/pack`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tmex-relay-token': encodeBase64url(relay.token),
          },
          body: payload,
          signal: ac.signal,
        }
      );
      let code: string | undefined;
      if (!res.ok) {
        try {
          const errBody = (await res.json()) as { error?: { code?: string }; code?: string };
          code = errBody.error?.code ?? errBody.code;
        } catch {
          code = `HTTP_${res.status}`;
        }
      }
      results.push({ url: row.url, ok: res.ok, status: res.status, ...(code ? { code } : {}) });
    } catch {
      results.push({ url: row.url, ok: false, status: 0, code: 'RELAY_UNREACHABLE' });
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = results.some((item) => item.ok);
  if (!ok) return jsonError('RELAY_PACK_FORWARD_FAILED', 502, { results });
  return jsonBody({ ok: true, results });
}
