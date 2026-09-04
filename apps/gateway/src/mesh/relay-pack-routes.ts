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

export type MeshRelayPackItem = { url: string; sealed_pack: string };

export type MeshRelayPackBody = {
  kdf_params: ReturnType<typeof kdfParamsToWire>;
  root_epoch: number;
  head_seq: number | string;
  packs: MeshRelayPackItem[];
  urls?: string[];
  legacySinglePack: boolean;
};

type PackForwardResult = { url: string; ok: boolean; status: number; code?: string };

function selectPackTargets<T extends { url: string }>(rows: T[], urls: string[] | undefined): T[] {
  if (!urls) return rows;
  const wanted = new Set(urls);
  return rows.filter((row) => wanted.has(row.url));
}

async function readForwardErrorCode(res: Response): Promise<string | undefined> {
  try {
    const errBody = (await res.json()) as { error?: { code?: string }; code?: string };
    return errBody.error?.code ?? errBody.code;
  } catch {
    return `HTTP_${res.status}`;
  }
}

async function forwardPackToRelay(input: {
  url: string;
  tenantId: string;
  token: Uint8Array;
  payload: string;
  doFetch: typeof fetch;
  dial: RelayDialContext;
}): Promise<PackForwardResult> {
  const dialUrl = resolveRelayDialUrl(input.url, input.dial);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_PACK_FORWARD_TIMEOUT_MS);
  try {
    const res = await input.doFetch(
      `${dialUrl.replace(/\/+$/, '')}/api/relay/tenants/${input.tenantId}/pack`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tmex-relay-token': encodeBase64url(input.token),
        },
        body: input.payload,
        signal: ac.signal,
      }
    );
    const code = res.ok ? undefined : await readForwardErrorCode(res);
    return { url: input.url, ok: res.ok, status: res.status, ...(code ? { code } : {}) };
  } catch {
    return { url: input.url, ok: false, status: 0, code: 'RELAY_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

function parseSealedPack(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let sealed: Uint8Array;
  try {
    sealed = decodeB64url(raw);
  } catch {
    return null;
  }
  if (sealed.byteLength === 0 || sealed.byteLength > RELAY_PACK_MAX_BYTES) return null;
  return raw;
}

function parsePackList(body: Record<string, unknown>): MeshRelayPackItem[] | null {
  if (!Array.isArray(body.packs)) return null;
  const packs: MeshRelayPackItem[] = [];
  for (const item of body.packs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.url !== 'string' || !rec.url) return null;
    const sealed = parseSealedPack(rec.sealed_pack);
    if (!sealed) return null;
    packs.push({ url: rec.url, sealed_pack: sealed });
  }
  return packs.length > 0 ? packs : null;
}

function parseMeta(
  body: Record<string, unknown>
): Omit<MeshRelayPackBody, 'packs' | 'legacySinglePack' | 'urls'> | null {
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
  return {
    kdf_params: kdfParamsToWire(kdf),
    root_epoch: body.root_epoch,
    head_seq: body.head_seq as number | string,
  };
}

/** FE / CLI 在持有根种子时密封后提交；节点把密封包转发到已配置的中继。 */
export function parseMeshRelayPackBody(
  body: Record<string, unknown> | null
): MeshRelayPackBody | null {
  if (!body) return null;
  const meta = parseMeta(body);
  if (!meta) return null;
  const listed = parsePackList(body);
  if (listed) return { ...meta, packs: listed, legacySinglePack: false };
  const sealed = parseSealedPack(body.sealed_pack);
  if (!sealed) return null;
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
    : undefined;
  return {
    ...meta,
    packs: [{ url: '', sealed_pack: sealed }],
    legacySinglePack: true,
    ...(urls && urls.length > 0 ? { urls } : {}),
  };
}

function packPayload(parsed: MeshRelayPackBody, sealedPack: string): string {
  return JSON.stringify({
    sealed_pack: sealedPack,
    kdf_params: parsed.kdf_params,
    root_epoch: parsed.root_epoch,
    head_seq: parsed.head_seq,
  });
}

async function forwardOne(
  deps: MeshRelayPackDeps,
  url: string,
  payload: string,
  doFetch: typeof fetch,
  dial: RelayDialContext
): Promise<PackForwardResult> {
  const relay = await deps.secrets.store.getRelay(url);
  if (!relay) return { url, ok: false, status: 0, code: 'RELAY_KEY_MISSING' };
  return forwardPackToRelay({
    url,
    tenantId: relay.tenantId,
    token: relay.token,
    payload,
    doFetch,
    dial,
  });
}

/** FE / CLI 在持有根种子时密封后提交；节点把密封包转发到已配置的中继。 */
export async function handleMeshRelayPack(
  deps: MeshRelayPackDeps,
  req: Request
): Promise<Response> {
  const parsed = parseMeshRelayPackBody(await readJsonObjectBody(req));
  if (!parsed) return jsonError('MALFORMED', 400);
  const rows = deps.secrets.relayRows();
  if (rows.length === 0) return jsonError('RELAY_NOT_CONFIGURED', 409);
  const doFetch = deps.fetchImpl ?? fetch;
  const dial = deps.dial ?? relayDialContextFromEnv();
  const results: PackForwardResult[] = [];
  if (parsed.legacySinglePack) {
    const targets = selectPackTargets(rows, parsed.urls);
    if (targets.length === 0) return jsonError('RELAY_NOT_FOUND', 404);
    const payload = packPayload(parsed, parsed.packs[0]?.sealed_pack ?? '');
    for (const row of targets) {
      results.push(await forwardOne(deps, row.url, payload, doFetch, dial));
    }
  } else {
    const known = new Set(rows.map((row) => row.url));
    for (const pack of parsed.packs) {
      if (!known.has(pack.url)) {
        results.push({ url: pack.url, ok: false, status: 0, code: 'RELAY_NOT_FOUND' });
        continue;
      }
      results.push(
        await forwardOne(deps, pack.url, packPayload(parsed, pack.sealed_pack), doFetch, dial)
      );
    }
    if (results.length === 0) return jsonError('RELAY_NOT_FOUND', 404);
  }
  if (!results.some((item) => item.ok)) {
    return jsonError('RELAY_PACK_FORWARD_FAILED', 502, { results });
  }
  return jsonBody({ ok: true, results });
}
