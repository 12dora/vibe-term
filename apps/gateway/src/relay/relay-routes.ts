import {
  bytesEqual,
  decodeCertificate,
  encodeBase64url,
  nodeIdToHex,
  verifyEd25519,
  verifyNodeCertificate,
} from '@vibeterm/shared/auth';
import { readJsonObjectBody } from '@vibeterm/shared/http';
import { RELAY_TOKEN_HEADER, readHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import {
  RELAY_ENROLL_PROOF_MAX_SKEW_MS,
  relaySeqToWire,
  verifyRelayEnrollProof,
} from '@vibeterm/shared/relay';
import { decodeB64url, requireB64url } from '../api/route-input';
import { encodeRedeemPopMessage } from '../hub/redeem-pop';
import type { RelayConfigStore } from './relay-config-store';
import type { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RelayErrorCode, relayError, relayJson } from './relay-http';
import type { RelayKeyLogStore } from './relay-key-log-store';
import { parseRelayEnvelopeJson } from './relay-key-log-store';
import { handleRelayJoin } from './relay-pack-http';
import {
  generateRelayTenantId,
  generateRelayToken,
  sha256Hex,
  verifyRelayPassword,
} from './relay-password';
import type { RelayTenantStore } from './relay-tenant-store';
import { relayTokenHashAccepted } from './relay-token-grace';
import type { RelayUplinkServer } from './relay-uplink-server';
import type { RelayEnrollmentRecord, RelayTenantRecord } from './types';

export { RELAY_TOKEN_HEADER };

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
  mode: 'enroll' | 'join';
  tenantId: string | null;
  /** 调用方手上那份令牌的 sha256（十六进制）；与中继当前令牌一致时不再换发。 */
  knownTokenHash: string | null;
};

type EnrollShape = {
  rootEpoch: number;
  proofBytes: string;
  proofSig: string;
  mode: 'enroll' | 'join';
  tenantId: string | null;
  knownTokenHash: string | null;
};

/** 形状与取值范围检查（不含 b64url 解码）：不合法一律 null，由调用方回 400。 */
function readEnrollShape(body: Record<string, unknown>): EnrollShape | null {
  const rootEpoch = body.root_epoch;
  if (typeof rootEpoch !== 'number' || !Number.isInteger(rootEpoch) || rootEpoch < 0) return null;
  const proof = body.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  const rec = proof as Record<string, unknown>;
  if (typeof rec.bytes !== 'string' || typeof rec.sig !== 'string') return null;
  const mode = body.mode === 'join' ? 'join' : 'enroll';
  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : null;
  if (mode === 'join' && !tenantId) return null;
  const hash = body.known_token_hash;
  return {
    rootEpoch,
    proofBytes: rec.bytes,
    proofSig: rec.sig,
    mode,
    tenantId,
    knownTokenHash: typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
  };
}

function parseEnrollBody(body: Record<string, unknown>): ParsedEnroll | null {
  const shape = readEnrollShape(body);
  if (!shape) return null;
  try {
    return {
      rootPublicKey: requireB64url(body, 'root_public_key', 32),
      rootEpoch: shape.rootEpoch,
      proofBytes: decodeB64url(shape.proofBytes),
      proofSig: decodeB64url(shape.proofSig, 64),
      password: typeof body.password === 'string' ? body.password : null,
      mode: shape.mode,
      tenantId: shape.tenantId,
      knownTokenHash: shape.knownTokenHash,
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

type ReissueDecision = 'reuse' | 'recover' | 'rotate';

/**
 * 同一根公钥重复 enroll 时要不要换令牌。
 *
 * - `reuse`：租户健康且调用方出示的哈希就是当前令牌 → 一动不动。改完接入口令再走一次接入
 *   （网页「重新输入接入密码」/ CLI `relay reauth`）落在这里，成员节点因此不掉线。
 * - `recover`：被踢或令牌代次低于门槛 → 换发并断掉旧链路（旧令牌本来就该死）。
 * - `rotate`：租户健康但调用方拿不出当前令牌（离开后重新接入、令牌丢失）→ 换发，
 *   但保留上一代供成员在宽限期内继续认证，也不主动断链。
 */
function shouldReissueToken(
  existing: RelayTenantRecord,
  minTokenEpoch: number,
  knownTokenHash: string | null,
  now: number
): ReissueDecision {
  if (existing.kicked || existing.tokenEpoch < minTokenEpoch) return 'recover';
  if (!knownTokenHash) return 'rotate';
  return relayTokenHashAccepted(existing, knownTokenHash, now) ? 'reuse' : 'rotate';
}

/**
 * 同一根公钥重复 enroll：tenant_id 不变，令牌按 `shouldReissueToken` 决定是否换发。
 *
 * 匹配的是**当前**根公钥：根轮换之后旧根持有者的 pk 不再命中任何租户，于是被当成一个新租户
 * （拿不到原租户的注册表与日志）。`root_epoch` 只由 `rotate-root` 侧带记录推进，
 * 这里的自称值只用于建租户时的初值。
 */
function issueTenantToken(
  deps: RelayPublicRoutesDeps,
  parsed: ParsedEnroll,
  tokenEpoch: number,
  minTokenEpoch: number
): { tenantId: string; token: string | null } {
  const now = deps.now();
  const existing = deps.tenants.getByRootPublicKey(parsed.rootPublicKey);
  if (!existing) {
    const token = generateRelayToken();
    const tenantId = generateRelayTenantId();
    deps.tenants.create({
      id: tenantId,
      rootPublicKey: parsed.rootPublicKey,
      rootEpoch: parsed.rootEpoch,
      tokenHash: sha256Hex(token),
      tokenEpoch,
      now,
    });
    return { tenantId, token };
  }
  const decision = shouldReissueToken(existing, minTokenEpoch, parsed.knownTokenHash, now);
  if (decision === 'reuse') return { tenantId: existing.id, token: null };
  const token = generateRelayToken();
  const tokenHash = sha256Hex(token);
  deps.tenants.reissueToken({
    tenantId: existing.id,
    tokenHash,
    tokenEpoch,
    keepPrevious: decision === 'rotate',
    now,
  });
  // 踢出恢复：旧令牌的链路必须立刻断开，否则被踢的一方只要连着就永远不复查令牌。
  // `rotate` 不断链——新令牌还在密钥日志里没送到成员手上。
  if (decision === 'recover') deps.uplink.enforceTokenReissue(existing.id, tokenHash);
  return { tenantId: existing.id, token };
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
  if (!verified.ok) {
    if (parsed.mode === 'join') deps.limiter.recordFailure(ip, parsed.tenantId ?? undefined);
    return relayError(RelayErrorCode.badProof, 401);
  }
  if (parsed.mode === 'join' && parsed.tenantId) {
    return handleRelayJoin(
      deps,
      {
        rootPublicKey: parsed.rootPublicKey,
        rootEpoch: parsed.rootEpoch,
        tenantId: parsed.tenantId,
      },
      ip
    );
  }
  const config = deps.configStore.ensure(deps.now());
  const rejected = await checkEnrollPassword(deps, parsed, config.passwordHash, ip);
  if (rejected) return rejected;
  deps.limiter.reset(ip);
  // 满员判定放在口令校验之后：否则一个满员的中继会变成「口令对不对」的探测器。
  // 口令校验是异步的，期间运营者可能刚把租户上限调小，所以这里重新读一次配置，
  // 紧挨着后面同步的「计数—判断—建租户」三步，中间不再有 await。
  const maxTenants = deps.configStore.ensure(deps.now()).limits.maxTenants;
  if (
    maxTenants !== null &&
    !deps.tenants.getByRootPublicKey(parsed.rootPublicKey) &&
    deps.tenants.count() >= maxTenants
  ) {
    return relayError(RelayErrorCode.quotaTenants, 409);
  }
  const issued = issueTenantToken(deps, parsed, config.passwordEpoch, config.minTokenEpoch);
  return relayJson({
    tenant_id: issued.tenantId,
    // 令牌未换发时不回令牌原文——中继只存哈希，调用方手上那份仍然有效
    token: issued.token,
    token_unchanged: issued.token === null,
    password_epoch: config.passwordEpoch,
  });
}

export function authenticateRelayTenant(
  deps: RelayPublicRoutesDeps,
  req: Request,
  tenantId: string
): RelayTenantRecord | Response {
  const presented = readHeaderPair(req.headers, RELAY_TOKEN_HEADER)?.trim();
  if (!presented) return relayError(RelayErrorCode.unauthorized, 401);
  const tenant = deps.tenants.get(tenantId);
  if (!tenant) return relayError(RelayErrorCode.tenantNotFound, 404);
  if (!relayTokenHashAccepted(tenant, sha256Hex(presented), deps.now())) {
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
  deps.uplink.notifyQuota(tenant.id);
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
