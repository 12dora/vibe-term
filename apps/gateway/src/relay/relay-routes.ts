import {
  bytesEqual,
  decodeCertificate,
  encodeBase64url,
  nodeIdToHex,
  verifyEd25519,
  verifyNodeCertificate,
} from '@tmex/shared/auth';
import { readJsonObjectBody } from '@tmex/shared/http';
import {
  RELAY_ENROLL_PROOF_MAX_SKEW_MS,
  relaySeqToWire,
  verifyRelayEnrollProof,
} from '@tmex/shared/relay';
import { decodeB64url, requireB64url } from '../api/route-input';
import { encodeRedeemPopMessage } from '../hub/redeem-pop';
import type { RelayConfigStore } from './relay-config-store';
import type { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RelayErrorCode, relayError, relayJson } from './relay-http';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { parseRelayEnvelopeJson } from './relay-key-log-store';
import {
  constantTimeEqual,
  generateRelayTenantId,
  generateRelayToken,
  sha256Hex,
  verifyRelayPassword,
} from './relay-password';
import type { RelayTenantStore } from './relay-tenant-store';
import type { RelayUplinkServer } from './relay-uplink-server';
import type { RelayEnrollmentRecord, RelayTenantRecord } from './types';

export const RELAY_TOKEN_HEADER = 'x-tmex-relay-token';

export type RelayPublicRoutesDeps = {
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  configStore: RelayConfigStore;
  limiter: RelayEnrollLimiter;
  uplink: RelayUplinkServer;
  publicUrl: string;
  relayHost: string;
  now: () => number;
  clientIp: (req: Request) => string;
};

type ParsedEnroll = {
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  proofBytes: Uint8Array;
  proofSig: Uint8Array;
  password: string | null;
};

function parseEnrollBody(body: Record<string, unknown>): ParsedEnroll | null {
  const rootEpoch = body.root_epoch;
  if (typeof rootEpoch !== 'number' || !Number.isInteger(rootEpoch) || rootEpoch < 0) return null;
  const proof = body.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  const rec = proof as Record<string, unknown>;
  if (typeof rec.bytes !== 'string' || typeof rec.sig !== 'string') return null;
  try {
    return {
      rootPublicKey: requireB64url(body, 'root_public_key', 32),
      rootEpoch,
      proofBytes: decodeB64url(rec.bytes),
      proofSig: decodeB64url(rec.sig, 64),
      password: typeof body.password === 'string' ? body.password : null,
    };
  } catch {
    return null;
  }
}

async function checkEnrollPassword(
  deps: RelayPublicRoutesDeps,
  parsed: ParsedEnroll,
  passwordHash: string | null,
  ip: string
): Promise<Response | null> {
  if (!passwordHash) return null;
  if (parsed.password === null) return relayError(RelayErrorCode.passwordRequired, 401);
  if (await verifyRelayPassword(passwordHash, parsed.password)) return null;
  deps.limiter.recordFailure(ip);
  return relayError(RelayErrorCode.passwordInvalid, 401);
}

/** 同一根公钥重复 enroll = 重新签发令牌（被踢后重输口令的路径），tenant_id 不变。 */
function issueTenantToken(
  deps: RelayPublicRoutesDeps,
  parsed: ParsedEnroll,
  tokenEpoch: number
): { tenantId: string; token: string } {
  const token = generateRelayToken();
  const now = deps.now();
  const existing = deps.tenants.getByRootPublicKey(parsed.rootPublicKey);
  const tenantId = existing?.id ?? generateRelayTenantId();
  const tokenHash = sha256Hex(token);
  if (existing) {
    deps.tenants.reissueToken({
      tenantId,
      tokenHash,
      tokenEpoch,
      rootEpoch: parsed.rootEpoch,
      now,
    });
  } else {
    deps.tenants.create({
      id: tenantId,
      rootPublicKey: parsed.rootPublicKey,
      rootEpoch: parsed.rootEpoch,
      tokenHash,
      tokenEpoch,
      now,
    });
  }
  return { tenantId, token };
}

export async function handleRelayEnroll(
  deps: RelayPublicRoutesDeps,
  req: Request
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const ip = deps.clientIp(req);
  if (deps.limiter.isLimited(ip)) return relayError(RelayErrorCode.rateLimited, 429);
  const parsed = parseEnrollBody(body);
  if (!parsed) return relayError(RelayErrorCode.invalidBody, 400);
  const verified = verifyRelayEnrollProof({
    bytes: parsed.proofBytes,
    sig: parsed.proofSig,
    relayHost: deps.relayHost,
    rootPublicKey: parsed.rootPublicKey,
    now: deps.now(),
    maxSkewMs: RELAY_ENROLL_PROOF_MAX_SKEW_MS,
  });
  if (!verified.ok) return relayError(RelayErrorCode.badProof, 401);
  const config = deps.configStore.ensure(deps.now());
  const rejected = await checkEnrollPassword(deps, parsed, config.passwordHash, ip);
  if (rejected) return rejected;
  deps.limiter.reset(ip);
  const issued = issueTenantToken(deps, parsed, config.passwordEpoch);
  return relayJson({
    tenant_id: issued.tenantId,
    token: issued.token,
    password_epoch: config.passwordEpoch,
  });
}

export function authenticateRelayTenant(
  deps: RelayPublicRoutesDeps,
  req: Request,
  tenantId: string
): RelayTenantRecord | Response {
  const presented = req.headers.get(RELAY_TOKEN_HEADER)?.trim();
  if (!presented) return relayError(RelayErrorCode.unauthorized, 401);
  const tenant = deps.tenants.get(tenantId);
  if (!tenant) return relayError(RelayErrorCode.tenantNotFound, 404);
  if (!constantTimeEqual(sha256Hex(presented), tenant.tokenHash)) {
    return relayError(RelayErrorCode.tokenInvalid, 401);
  }
  if (tenant.kicked) return relayError(RelayErrorCode.tenantKicked, 401);
  if (tenant.tokenEpoch < deps.configStore.ensure(deps.now()).minTokenEpoch) {
    return relayError(RelayErrorCode.tokenInvalid, 401);
  }
  return tenant;
}

/**
 * 按 enroll_pk 取回中继保存的 authorization 字节。
 * 加入方必须在造证书前读出租户 uid（`applyAdmitNode` 要求 cert.uid == authorization.uid），
 * 而 r3 join 串里没有 uid，redeem 又是一次性的，所以单独开这条只读路由（同租户令牌鉴权）。
 */
export function handleRelayEnrollmentLookup(
  deps: RelayPublicRoutesDeps,
  req: Request,
  tenantId: string,
  enrollPkRaw: string
): Response {
  const tenant = authenticateRelayTenant(deps, req, tenantId);
  if (tenant instanceof Response) return tenant;
  let enrollPk: Uint8Array;
  try {
    enrollPk = decodeB64url(enrollPkRaw, 32);
  } catch {
    return relayError(RelayErrorCode.notFound, 404);
  }
  const enrollment = deps.tenants.getEnrollmentByEnrollPk(enrollPk);
  if (!enrollment || enrollment.tenantId !== tenant.id) {
    return relayError(RelayErrorCode.notFound, 404);
  }
  return relayJson({
    authorization: encodeBase64url(enrollment.authorizationBytes),
    authorization_sig: encodeBase64url(enrollment.authorizationSig),
    exp: enrollment.expiresAt,
    used_at: enrollment.usedAt,
  });
}

type RedeemInput = {
  certBytes: Uint8Array;
  certSig: Uint8Array;
  pop: Uint8Array;
  certificate: ReturnType<typeof decodeCertificate>;
};

function parseRedeemBody(body: Record<string, unknown>): RedeemInput | Response {
  let certBytes: Uint8Array;
  let certSig: Uint8Array;
  let pop: Uint8Array;
  try {
    certBytes = requireB64url(body, 'certificate');
    certSig = requireB64url(body, 'cert_sig', 64);
    pop = requireB64url(body, 'pop', 64);
  } catch {
    return relayError(RelayErrorCode.invalidBody, 400);
  }
  try {
    return { certBytes, certSig, pop, certificate: decodeCertificate(certBytes) };
  } catch {
    return relayError(RelayErrorCode.badCertificate, 400);
  }
}

/** 校验 enrollment 存在且可用、证书由 enroll 私钥签发、PoP 由节点链路私钥签发。 */
function verifyRedeemInput(
  deps: RelayPublicRoutesDeps,
  tenant: RelayTenantRecord,
  input: RedeemInput,
  now: number
): RelayEnrollmentRecord | Response {
  const enrollment = deps.tenants.getEnrollmentByEnrollPk(input.certificate.enroll_pk);
  if (!enrollment || enrollment.tenantId !== tenant.id) {
    return relayError(RelayErrorCode.enrollmentUnknown, 400);
  }
  if (!bytesEqual(input.certificate.enroll_pk, enrollment.enrollPk)) {
    return relayError(RelayErrorCode.enrollmentUnknown, 400);
  }
  if (enrollment.usedAt !== null) return relayError(RelayErrorCode.enrollmentUsed, 400);
  if (enrollment.expiresAt <= now) return relayError(RelayErrorCode.enrollmentExpired, 400);
  if (!verifyNodeCertificate(input.certBytes, input.certSig, enrollment.enrollPk)) {
    return relayError(RelayErrorCode.badCertSig, 400);
  }
  const popMessage = encodeRedeemPopMessage({
    enrollmentId: encodeBase64url(input.certificate.enroll_pk),
    nodeId: input.certificate.node_id,
    certBytes: input.certBytes,
  });
  if (!verifyEd25519(input.pop, popMessage, input.certificate.ed_pk)) {
    return relayError(RelayErrorCode.badPop, 400);
  }
  return enrollment;
}

export async function handleRelayRedeem(
  deps: RelayPublicRoutesDeps,
  req: Request,
  tenantId: string
): Promise<Response> {
  const tenant = authenticateRelayTenant(deps, req, tenantId);
  if (tenant instanceof Response) return tenant;
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const input = parseRedeemBody(body);
  if (input instanceof Response) return input;
  const now = deps.now();
  const enrollment = verifyRedeemInput(deps, tenant, input, now);
  if (enrollment instanceof Response) return enrollment;
  const nodeId = nodeIdToHex(input.certificate.node_id);
  const existing = deps.tenants.getNode(tenant.id, nodeId);
  if (existing?.status === 'revoked') return relayError(RelayErrorCode.nodeRevoked, 409);
  if (
    !existing &&
    deps.tenants.countActiveNodes(tenant.id) >= deps.uplink.quotaFor(tenant.id).maxNodes
  ) {
    return relayError(RelayErrorCode.quotaNodes, 409);
  }
  if (!deps.tenants.consumeEnrollment(enrollment.id, nodeId, now)) {
    return relayError(RelayErrorCode.enrollmentUsed, 400);
  }
  deps.tenants.upsertNode({
    tenantId: tenant.id,
    nodeId,
    edPk: input.certificate.ed_pk,
    x25519Pk: input.certificate.x25519_pk,
    status: existing?.status === 'admitted' ? 'admitted' : 'pending',
    now,
  });
  deps.uplink.broadcast(tenant.id, {
    t: 'enroll.redeemed',
    certificate: encodeBase64url(input.certBytes),
    cert_sig: encodeBase64url(input.certSig),
    enroll_pk: encodeBase64url(input.certificate.enroll_pk),
    node_id: nodeId,
  });
  deps.uplink.scheduleList(tenant.id);
  return relayJson({
    tenant_id: tenant.id,
    relays: [deps.publicUrl],
    rtc: deps.uplink.rtcConfig(),
    key_log: deps.keyLog
      .listAll(tenant.id)
      .map((row) => ({ seq: relaySeqToWire(row.seq), blob: parseRelayEnvelopeJson(row.blob) }))
      .filter((row) => row.blob !== null),
  });
}

export function relayHealth(input: {
  version: string;
  tenants: number;
  nodesOnline: number;
  startedAt: number;
  now: number;
}): Response {
  return relayJson({
    ok: true,
    version: input.version,
    tenants: input.tenants,
    nodesOnline: input.nodesOnline,
    uptimeMs: Math.max(0, input.now - input.startedAt),
  });
}
