import { bytesEqual, decodeAuthorization, verifyEd25519 } from '@tmex/shared/auth';
import { decodeB64url } from '../api/route-input';
import { RelayErrorCode, relayError, relayJson } from './relay-http';
import { ED25519_SIG_BYTES } from './relay-member';
import type { RelayTenantStore } from './relay-tenant-store';
import {
  RELAY_ENROLLMENT_MAX_TTL_MS,
  RELAY_MAX_UNUSED_ENROLLMENTS,
  type RelayEnrollmentRecord,
  type RelayTenantRecord,
} from './types';

const ENROLL_CREATE_ID_MAX = 512;

export type RelayEnrollCreateHost = {
  tenants: RelayTenantStore;
  now: () => number;
  allowEnrollCreate: (tenantId: string) => boolean;
};

export type RelayEnrollCreateFields = {
  id: string;
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  exp: number;
};

export type RelayEnrollCreateResult = { ok: true } | { ok: false; error: string };

/**
 * 中继只能验根签名的 authorization；passkey 签名验不了（plan 1.12），按令牌信任放行。
 * 无论哪种签名，`root_epoch` 都必须是租户**当前**的 epoch，`exp` 不得超过 authorization 自身的到期。
 */
export function verifyRelayAuthorization(input: {
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  exp: number;
}): string | null {
  let authorization: ReturnType<typeof decodeAuthorization>;
  try {
    authorization = decodeAuthorization(input.authorizationBytes);
  } catch {
    return 'BAD_AUTHORIZATION';
  }
  if (authorization.enroll_pk.length !== input.enrollPk.length) return 'ENROLL_PK_MISMATCH';
  for (let i = 0; i < input.enrollPk.length; i++) {
    if (authorization.enroll_pk[i] !== input.enrollPk[i]) return 'ENROLL_PK_MISMATCH';
  }
  if (authorization.root_epoch !== input.rootEpoch) return 'ROOT_EPOCH_MISMATCH';
  if (BigInt(input.exp) > authorization.exp) return 'BAD_EXPIRY';
  if (authorization.signer === 'root') {
    if (input.authorizationSig.byteLength !== ED25519_SIG_BYTES) return 'BAD_AUTHORIZATION_SIG';
    return verifyEd25519(input.authorizationSig, input.authorizationBytes, input.rootPublicKey)
      ? null
      : 'BAD_AUTHORIZATION_SIG';
  }
  return authorization.signer === 'passkey' ? null : 'BAD_AUTHORIZATION';
}

function enrollmentPayloadMatches(
  existing: RelayEnrollmentRecord,
  input: RelayEnrollCreateFields
): boolean {
  return (
    existing.expiresAt === input.exp &&
    bytesEqual(existing.enrollPk, input.enrollPk) &&
    bytesEqual(existing.authorizationBytes, input.authorizationBytes) &&
    bytesEqual(existing.authorizationSig, input.authorizationSig)
  );
}

/** uplink `relay.enroll.create` 与 HTTP `POST …/enrollments` 共用：校验、配额、限流、幂等写入。 */
export function applyRelayEnrollCreate(
  host: RelayEnrollCreateHost,
  tenant: RelayTenantRecord,
  input: RelayEnrollCreateFields
): RelayEnrollCreateResult {
  const now = host.now();
  if (input.exp <= now || input.exp - now > RELAY_ENROLLMENT_MAX_TTL_MS) {
    return { ok: false, error: 'BAD_EXPIRY' };
  }
  const rejected = verifyRelayAuthorization({
    enrollPk: input.enrollPk,
    authorizationBytes: input.authorizationBytes,
    authorizationSig: input.authorizationSig,
    rootPublicKey: tenant.rootPublicKey,
    rootEpoch: tenant.rootEpoch,
    exp: input.exp,
  });
  if (rejected) return { ok: false, error: rejected };

  const existing = host.tenants.getEnrollmentById(input.id);
  if (existing) {
    if (existing.tenantId === tenant.id && enrollmentPayloadMatches(existing, input)) {
      return { ok: true };
    }
    return { ok: false, error: 'RELAY_ENROLLMENT_CONFLICT' };
  }
  const byPk = host.tenants.getEnrollmentByEnrollPk(input.enrollPk);
  if (byPk) return { ok: false, error: 'RELAY_ENROLLMENT_CONFLICT' };
  if (host.tenants.countUnusedEnrollments(tenant.id, now) >= RELAY_MAX_UNUSED_ENROLLMENTS) {
    return { ok: false, error: 'ENROLLMENT_QUOTA' };
  }
  if (!host.allowEnrollCreate(tenant.id)) {
    return { ok: false, error: 'ENROLLMENT_RATE_LIMITED' };
  }
  try {
    host.tenants.createEnrollment({
      id: input.id,
      tenantId: tenant.id,
      enrollPk: input.enrollPk,
      authorizationBytes: input.authorizationBytes,
      authorizationSig: input.authorizationSig,
      expiresAt: input.exp,
      now,
    });
  } catch {
    return { ok: false, error: 'RELAY_ENROLLMENT_CONFLICT' };
  }
  return { ok: true };
}

function parseEnrollCreateBody(body: Record<string, unknown>): RelayEnrollCreateFields | null {
  const id = body.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > ENROLL_CREATE_ID_MAX) return null;
  if (typeof body.exp !== 'number' || !Number.isFinite(body.exp)) return null;
  try {
    return {
      id,
      enrollPk: decodeB64url(String(body.enroll_pk ?? ''), 32),
      authorizationBytes: decodeB64url(String(body.authorization ?? '')),
      authorizationSig: decodeB64url(String(body.authorization_sig ?? '')),
      exp: body.exp,
    };
  } catch {
    return null;
  }
}

function enrollCreateHttpError(error: string): Response {
  if (error === 'ENROLLMENT_RATE_LIMITED') {
    return relayError(RelayErrorCode.enrollmentRateLimited, 429);
  }
  if (error === 'ENROLLMENT_QUOTA') {
    return relayError(RelayErrorCode.enrollmentQuota, 409);
  }
  if (error === 'RELAY_ENROLLMENT_CONFLICT') {
    return relayError(RelayErrorCode.enrollmentConflict, 409);
  }
  return relayError(RelayErrorCode.invalidBody, 400, { reason: error });
}

/** 已通过租户令牌鉴权之后：解析 body 并写入，与 uplink create 同一套逻辑。 */
export function respondRelayEnrollmentCreate(
  host: RelayEnrollCreateHost,
  tenant: RelayTenantRecord,
  body: Record<string, unknown> | null
): Response {
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  const parsed = parseEnrollCreateBody(body);
  if (!parsed) return relayError(RelayErrorCode.invalidBody, 400);
  const result = applyRelayEnrollCreate(host, tenant, parsed);
  if (!result.ok) return enrollCreateHttpError(result.error);
  return relayJson({ ok: true }, 201);
}
