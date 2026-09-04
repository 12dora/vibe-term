import {
  decodeAuthorization,
  decodeHubEnrollProof,
  encodeBase64url,
  hubHostFromUrl,
  verifyHubEnrollProof,
} from '@tmex/shared/auth';
import { json, readJsonObjectBody } from '../api/http';
import { requireB64url, validationError } from '../api/route-input';
import type { UserRecord, UserStore } from '../auth/user-store';
import { clientIpFromRequest } from '../mesh/client-ip';
import { HubEnrollLimiter } from './hub-enroll-limiter';
import type { HubAuthResult, HubRuntimeConfig } from './types';

export type HubPasswordEnrollHost = {
  userStore: UserStore;
  now: () => number;
  config: HubRuntimeConfig;
  tlsInfo?: () =>
    | { caFingerprint: string | null; caPem: string | null }
    | Promise<{ caFingerprint: string | null; caPem: string | null }>;
  verifyEnrollmentAuthorization(
    user: UserRecord,
    enrollPk: Uint8Array,
    authorizationBytes: Uint8Array,
    authorizationSig: Uint8Array,
    authorization: ReturnType<typeof decodeAuthorization>
  ): Promise<string | null>;
  publishEnrollmentToken(token: ReturnType<UserStore['createEnrollmentToken']>): Promise<string[]>;
};

type StoredEnrollmentPayload = {
  authorization_b64: string;
  entry_node_id: string | null;
  entry_sid?: string | null;
};

const limiters = new WeakMap<object, HubEnrollLimiter>();

export function enrollLimiterOf(host: HubPasswordEnrollHost): HubEnrollLimiter {
  let limiter = limiters.get(host);
  if (!limiter) {
    limiter = new HubEnrollLimiter(() => host.now());
    limiters.set(host, limiter);
  }
  return limiter;
}

export async function createEnrollmentFromAuth(
  host: HubPasswordEnrollHost,
  req: Request,
  auth: HubAuthResult
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: 'invalid_body' }, 400);
  const user = host.userStore.getById(auth.userId);
  if (!user) return json({ error: 'user_not_found' }, 404);
  const parsed = parseEnrollmentFields(body);
  if (parsed instanceof Response) return parsed;
  return persistEnrollment(host, {
    user,
    ...parsed,
    bodyExp: typeof body.exp === 'number' ? body.exp : undefined,
    entryNodeId: auth.entryNodeId,
    entrySid: auth.sid,
  });
}

type PasswordEnrollAccepted = {
  user: UserRecord;
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  authorization: ReturnType<typeof decodeAuthorization>;
  proofUid: string;
};

function failLimited(
  limiter: HubEnrollLimiter,
  ip: string,
  uid: string,
  response: Response
): Response {
  limiter.recordFailure(ip, uid);
  return response;
}

function acceptPasswordEnroll(
  host: HubPasswordEnrollHost,
  body: Record<string, unknown>,
  ip: string,
  limiter: HubEnrollLimiter
): PasswordEnrollAccepted | Response {
  const proofFields = parseProofFields(body);
  if (proofFields instanceof Response) {
    return failLimited(limiter, ip, '', proofFields);
  }

  let enrollPk: Uint8Array;
  try {
    enrollPk = requireB64url(body, 'enroll_pk', 32);
  } catch (err) {
    return failLimited(limiter, ip, '', validationError(err));
  }

  let proofUid = '';
  try {
    proofUid = decodeHubEnrollProof(proofFields.bytes).uid;
  } catch {
    return failLimited(limiter, ip, '', json({ error: 'invalid_proof' }, 401));
  }

  if (limiter.isLimited(ip, proofUid)) {
    return json({ error: 'rate_limited' }, 429);
  }

  const user = host.userStore.getById(proofUid);
  if (!user) {
    return failLimited(limiter, ip, proofUid, json({ error: 'invalid_proof' }, 401));
  }

  let hubHost: string;
  try {
    hubHost = hubHostFromUrl(host.config.publicUrl);
  } catch {
    return failLimited(limiter, ip, proofUid, json({ error: 'invalid_proof' }, 401));
  }

  const verified = verifyHubEnrollProof({
    bytes: proofFields.bytes,
    sig: proofFields.sig,
    hubHost,
    uid: proofUid,
    rootPublicKey: user.rootPublicKey,
    enrollPk,
    now: host.now(),
  });
  if (!verified.ok) {
    const response =
      verified.error === 'ts_skew'
        ? json({ error: 'ts_skew' }, 400)
        : json({ error: 'invalid_proof' }, 401);
    return failLimited(limiter, ip, proofUid, response);
  }

  const parsed = parseEnrollmentFields(body, enrollPk);
  if (parsed instanceof Response) {
    return failLimited(limiter, ip, proofUid, parsed);
  }
  if (limiter.isLimited(ip, proofUid)) {
    return json({ error: 'rate_limited' }, 429);
  }
  return { user, ...parsed, proofUid };
}

export async function handleHubPasswordEnroll(
  host: HubPasswordEnrollHost,
  req: Request
): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: 'invalid_body' }, 400);
  const ip = clientIpFromRequest(req) ?? 'unknown';
  const limiter = enrollLimiterOf(host);
  const accepted = acceptPasswordEnroll(host, body, ip, limiter);
  if (accepted instanceof Response) return accepted;
  const created = await persistEnrollment(host, {
    user: accepted.user,
    enrollPk: accepted.enrollPk,
    authorizationBytes: accepted.authorizationBytes,
    authorizationSig: accepted.authorizationSig,
    authorization: accepted.authorization,
    bodyExp: typeof body.exp === 'number' ? body.exp : undefined,
    entryNodeId: null,
    joinMaterial: true,
  });
  if (created.status === 201) limiter.recordSuccess(accepted.proofUid);
  else if (created.status >= 400) limiter.recordFailure(ip, accepted.proofUid);
  return created;
}

function parseProofFields(
  body: Record<string, unknown>
): { bytes: Uint8Array; sig: Uint8Array } | Response {
  const proof = body.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return json({ error: 'invalid_body' }, 400);
  }
  const obj = proof as Record<string, unknown>;
  try {
    return {
      bytes: requireB64url(obj, 'bytes'),
      sig: requireB64url(obj, 'sig', 64),
    };
  } catch (err) {
    return validationError(err);
  }
}

function parseEnrollmentFields(
  body: Record<string, unknown>,
  enrollPk?: Uint8Array
):
  | Response
  | {
      enrollPk: Uint8Array;
      authorizationBytes: Uint8Array;
      authorizationSig: Uint8Array;
      authorization: ReturnType<typeof decodeAuthorization>;
    } {
  let pk = enrollPk;
  let authorizationBytes: Uint8Array;
  let authorizationSig: Uint8Array;
  try {
    pk = pk ?? requireB64url(body, 'enroll_pk', 32);
    authorizationBytes = requireB64url(body, 'authorization');
    authorizationSig = requireB64url(body, 'authorization_sig');
  } catch (err) {
    return validationError(err);
  }
  let authorization: ReturnType<typeof decodeAuthorization>;
  try {
    authorization = decodeAuthorization(authorizationBytes);
  } catch {
    return json({ error: 'bad_authorization' }, 400);
  }
  return { enrollPk: pk, authorizationBytes, authorizationSig, authorization };
}

async function persistEnrollment(
  host: HubPasswordEnrollHost,
  input: {
    user: UserRecord;
    enrollPk: Uint8Array;
    authorizationBytes: Uint8Array;
    authorizationSig: Uint8Array;
    authorization: ReturnType<typeof decodeAuthorization>;
    bodyExp?: number;
    entryNodeId: string | null;
    entrySid?: string | null;
    joinMaterial?: boolean;
  }
): Promise<Response> {
  const authErr = await host.verifyEnrollmentAuthorization(
    input.user,
    input.enrollPk,
    input.authorizationBytes,
    input.authorizationSig,
    input.authorization
  );
  if (authErr) return json({ error: authErr }, 400);
  const now = host.now();
  const authExp = Number(input.authorization.exp);
  const expiresAt = Math.min(authExp, input.bodyExp ?? authExp);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return json({ error: 'expired' }, 400);
  if (host.userStore.getEnrollmentTokenByEnrollPublicKey(input.enrollPk)) {
    return json({ error: 'duplicate_enroll_pk' }, 409);
  }
  const payload: StoredEnrollmentPayload = {
    authorization_b64: encodeBase64url(input.authorizationBytes),
    entry_node_id: input.entryNodeId,
    ...(input.entrySid && { entry_sid: input.entrySid }),
  };
  const token = host.userStore.createEnrollmentToken({
    id: crypto.randomUUID(),
    userId: input.user.id,
    enrollPublicKey: input.enrollPk,
    authorizationJson: JSON.stringify(payload),
    authorizationSig: input.authorizationSig,
    expiresAt,
  });
  const replicatedTo = await host.publishEnrollmentToken(token);
  const tls = (await host.tlsInfo?.()) ?? { caFingerprint: null, caPem: null };
  return json(
    {
      ok: true,
      id: token.id,
      expires_at: expiresAt,
      public_url: host.config.publicUrl,
      ca_fingerprint: tls.caFingerprint,
      ca_cert_pem: tls.caPem,
      replicatedTo,
      ...(input.joinMaterial
        ? {
            key_log_head_hash: encodeBase64url(input.user.keyLogHeadHash),
            root_public_key: encodeBase64url(input.user.rootPublicKey),
          }
        : {}),
    },
    201
  );
}
