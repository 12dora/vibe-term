import { bytesEqual, encodeBase64url } from '@tmex/shared/auth';
import {
  RELAY_KEYLOG_SEQ_MISMATCH,
  RELAY_PACK_MAX_BYTES,
  type RelayKeylogMember,
  kdfParamsFromWire,
  kdfParamsToWire,
  relaySeqFromWire,
  relaySeqToWire,
} from '@tmex/shared/relay';
import { decodeB64url } from '../api/route-input';
import type { RelayConfigStore } from './relay-config-store';
import type { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RelayErrorCode, relayError, relayJson, relayNoStore } from './relay-http';
import { appendRelayKeyLog, pageRelayKeyLog } from './relay-key-log-service';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { parseRelayEnvelopeJson } from './relay-key-log-store';
import { sha256Hex } from './relay-password';
import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayUplinkServer } from './relay-uplink-server';
import type { RelayTenantRecord } from './types';

const TENANT_ID_HEX = /^[0-9a-f]{32}$/;
const KDF_JSON_MAX = 512;

export type RelayPackHttpDeps = {
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  configStore: RelayConfigStore;
  limiter: RelayEnrollLimiter;
  uplink: RelayUplinkServer;
  now: () => number;
  clientIp: (req: Request) => string;
};

export function isRelayTenantId(value: string): boolean {
  return TENANT_ID_HEX.test(value);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseStoredKdf(tenant: RelayTenantRecord): ReturnType<typeof kdfParamsFromWire> {
  if (!tenant.kdfParamsJson) return null;
  return kdfParamsFromWire(safeJson(tenant.kdfParamsJson));
}

function parseRelayKeylogMember(
  raw: Record<string, unknown> | null
): RelayKeylogMember | undefined {
  const op = raw?.op;
  if (op !== 'admit' && op !== 'revoke' && op !== 'rotate-root') return undefined;
  if (typeof raw?.bytes !== 'string' || typeof raw.sig !== 'string') return undefined;
  return { op, bytes: raw.bytes, sig: raw.sig };
}

export function handleRelayTenantKdf(
  deps: RelayPackHttpDeps,
  req: Request,
  tenantId: string
): Response {
  const ip = deps.clientIp(req);
  if (deps.limiter.isLimited(ip, tenantId)) return relayError(RelayErrorCode.rateLimited, 429);
  if (!isRelayTenantId(tenantId)) {
    deps.limiter.recordFailure(ip, tenantId);
    return relayError(RelayErrorCode.tenantNotFound, 404);
  }
  const tenant = deps.tenants.get(tenantId);
  if (!tenant) {
    deps.limiter.recordFailure(ip, tenantId);
    return relayError(RelayErrorCode.tenantNotFound, 404);
  }
  const kdf = parseStoredKdf(tenant);
  if (!kdf) {
    deps.limiter.recordFailure(ip, tenantId);
    return relayError(RelayErrorCode.tenantNotFound, 404);
  }
  return relayNoStore({ kdf_params: kdfParamsToWire(kdf), root_epoch: tenant.rootEpoch });
}

export function handleRelayJoin(
  deps: RelayPackHttpDeps,
  parsed: { rootPublicKey: Uint8Array; rootEpoch: number; tenantId: string },
  ip: string
): Response {
  if (deps.limiter.isLimited(ip, parsed.tenantId)) {
    return relayError(RelayErrorCode.rateLimited, 429);
  }
  if (!isRelayTenantId(parsed.tenantId)) {
    deps.limiter.recordFailure(ip, parsed.tenantId);
    return relayError(RelayErrorCode.tenantNotFound, 404);
  }
  const tenant = deps.tenants.get(parsed.tenantId);
  if (!tenant) {
    deps.limiter.recordFailure(ip, parsed.tenantId);
    return relayError(RelayErrorCode.tenantNotFound, 404);
  }
  if (tenant.kicked) {
    deps.limiter.recordFailure(ip, parsed.tenantId);
    return relayError(RelayErrorCode.tenantKicked, 401);
  }
  if (!bytesEqual(parsed.rootPublicKey, tenant.rootPublicKey)) {
    deps.limiter.recordFailure(ip, parsed.tenantId);
    return relayError(RelayErrorCode.badProof, 401);
  }
  if (parsed.rootEpoch !== tenant.rootEpoch) {
    deps.limiter.recordFailure(ip, parsed.tenantId);
    return relayError(RelayErrorCode.badProof, 401);
  }
  const kdf = parseStoredKdf(tenant);
  if (!kdf || !tenant.sealedPack) {
    deps.limiter.recordFailure(ip, parsed.tenantId);
    return relayError(RelayErrorCode.packMissing, 404);
  }
  deps.limiter.reset(ip, parsed.tenantId);
  return relayNoStore({
    tenant_id: tenant.id,
    kdf_params: kdfParamsToWire(kdf),
    sealed_pack: encodeBase64url(tenant.sealedPack),
    root_epoch: tenant.rootEpoch,
    key_log_head_seq: relaySeqToWire(tenant.keyLogHeadSeq),
  });
}

function parsePackUploadBody(
  body: Record<string, unknown>
): { sealedPack: Uint8Array; kdfJson: string; rootEpoch: number; headSeq: bigint } | Response {
  let sealedPack: Uint8Array;
  try {
    if (typeof body.sealed_pack !== 'string' || !body.sealed_pack) {
      return relayError(RelayErrorCode.invalidBody, 400);
    }
    sealedPack = decodeB64url(body.sealed_pack);
  } catch {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  if (sealedPack.byteLength > RELAY_PACK_MAX_BYTES) {
    return relayError(RelayErrorCode.packTooLarge, 400);
  }
  const kdf = kdfParamsFromWire(body.kdf_params);
  if (!kdf) return relayError(RelayErrorCode.invalidBody, 400);
  const rootEpoch = body.root_epoch;
  if (typeof rootEpoch !== 'number' || !Number.isInteger(rootEpoch) || rootEpoch < 0) {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  let headSeq: bigint;
  try {
    headSeq = relaySeqFromWire(body.head_seq as number | string);
  } catch {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  const kdfJson = JSON.stringify(kdfParamsToWire(kdf));
  if (kdfJson.length > KDF_JSON_MAX) return relayError(RelayErrorCode.invalidBody, 400);
  return { sealedPack, kdfJson, rootEpoch, headSeq };
}

function packStoreResponse(
  stored: 'ok' | 'not_found' | 'epoch' | 'head_ahead' | 'kicked' | 'unauthorized'
): Response {
  if (stored === 'not_found') return relayError(RelayErrorCode.tenantNotFound, 404);
  if (stored === 'kicked') return relayError(RelayErrorCode.tenantKicked, 401);
  if (stored === 'unauthorized') return relayError(RelayErrorCode.tokenInvalid, 401);
  if (stored === 'epoch') return relayError(RelayErrorCode.packEpoch, 409);
  if (stored === 'head_ahead') return relayError(RelayErrorCode.packHeadAhead, 409);
  return relayJson({ ok: true });
}

export function applyRelayPackUpload(
  deps: RelayPackHttpDeps,
  tenantId: string,
  presentedToken: string | null,
  body: Record<string, unknown>
): Response {
  if (!presentedToken) return relayError(RelayErrorCode.unauthorized, 401);
  const parsed = parsePackUploadBody(body);
  if (parsed instanceof Response) return parsed;
  return packStoreResponse(
    deps.tenants.putPack({
      tenantId,
      kdfParamsJson: parsed.kdfJson,
      sealedPack: parsed.sealedPack,
      expectedRootEpoch: parsed.rootEpoch,
      headSeq: parsed.headSeq,
      tokenHash: sha256Hex(presentedToken),
      minTokenEpoch: deps.configStore.ensure(deps.now()).minTokenEpoch,
      now: deps.now(),
    })
  );
}

export function handleRelayKeyLogPage(
  deps: RelayPackHttpDeps,
  tenant: RelayTenantRecord,
  req: Request
): Response {
  const url = new URL(req.url);
  const fromRaw = url.searchParams.get('from_seq') ?? '1';
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  const fromSeq = /^\d+$/.test(fromRaw) ? Number(fromRaw) : fromRaw;
  const page = pageRelayKeyLog(
    { keyLog: deps.keyLog },
    tenant.id,
    fromSeq,
    Number.isFinite(limit) ? limit : undefined
  );
  return relayNoStore({
    key_log: page.records,
    has_more: page.hasMore,
  });
}

function keyLogAppendFailure(outcome: { error: string; head: bigint }): Response {
  if (outcome.error === 'TENANT_KICKED') return relayError(RelayErrorCode.tenantKicked, 401);
  if (outcome.error === 'UNAUTHORIZED') return relayError(RelayErrorCode.tokenInvalid, 401);
  return relayJson(
    {
      error: {
        code:
          outcome.error === RELAY_KEYLOG_SEQ_MISMATCH
            ? RELAY_KEYLOG_SEQ_MISMATCH
            : RelayErrorCode.invalidBody,
        message: outcome.error,
        head: relaySeqToWire(outcome.head),
      },
    },
    409
  );
}

function finishKeyLogAppend(
  deps: RelayPackHttpDeps,
  tenantId: string,
  outcome: Extract<ReturnType<typeof appendRelayKeyLog>, { ok: true }>
): Response {
  if (outcome.revokedNodeId) {
    deps.uplink.disconnectNode(tenantId, outcome.revokedNodeId, 'revoked');
  }
  if (!outcome.memberIgnored) deps.uplink.notifyQuota(tenantId);
  deps.uplink.scheduleList(tenantId);
  return relayJson({
    ok: true,
    seq: relaySeqToWire(outcome.seq),
    head: relaySeqToWire(outcome.head),
    ...(outcome.memberIgnored ? { member_ignored: true } : {}),
    ...(outcome.memberError ? { member_error: outcome.memberError } : {}),
  });
}

export function applyRelayKeyLogAppend(
  deps: RelayPackHttpDeps,
  tenantId: string,
  presentedToken: string | null,
  body: Record<string, unknown>
): Response {
  if (!presentedToken) return relayError(RelayErrorCode.unauthorized, 401);
  const blob =
    typeof body.blob === 'string'
      ? parseRelayEnvelopeJson(body.blob)
      : parseRelayEnvelopeJson(JSON.stringify(body.blob ?? null));
  if (!blob) return relayError(RelayErrorCode.invalidBody, 400);
  const member = parseRelayKeylogMember(
    body.member && typeof body.member === 'object' && !Array.isArray(body.member)
      ? (body.member as Record<string, unknown>)
      : null
  );
  const tenant = deps.tenants.get(tenantId);
  if (!tenant) return relayError(RelayErrorCode.tenantNotFound, 404);
  const outcome = appendRelayKeyLog(
    { db: deps.uplink.db, tenants: deps.tenants, keyLog: deps.keyLog, now: deps.now },
    tenant,
    {
      t: 'relay.keylog.append',
      id: typeof body.id === 'string' ? body.id : 'http',
      seq: body.seq as number | string,
      blob,
      ...(member ? { member } : {}),
    },
    {
      tokenHash: sha256Hex(presentedToken),
      minTokenEpoch: deps.configStore.ensure(deps.now()).minTokenEpoch,
    }
  );
  if (!outcome.ok) return keyLogAppendFailure(outcome);
  return finishKeyLogAppend(deps, tenantId, outcome);
}
