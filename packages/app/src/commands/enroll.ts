import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import {
  ENROLLMENT_TTL_MS,
  bytesEqual,
  createEnrollment,
  decodeBase64url,
  decodeCertificate,
  deriveTotpKey,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeJoinToken,
  nodeIdToHex,
} from '../../../shared/src/auth';
import { parseDurationMs } from '../lib/duration';
import type { FetchLike } from '../lib/fetch-like';
import {
  createHubFetcher,
  fetchAuthMode,
  listHubNodes,
  loginWithRootKey,
  postEnrollment,
} from '../lib/hub-client';
import { quotePosixShellArg } from '../lib/install';
import type { LocalAuthContext } from '../lib/local-auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { promptPassword } from '../lib/prompt';
import { parseTmexRoles } from '../lib/roles';
import { asString } from '../lib/validate';
import { spkiFingerprint } from '../tls/cert-authority';
import type { ParsedArgs } from '../types';
import { type HubIo, NODE_REVOKED_REJOIN_ERROR } from './hub';
import { withAuth } from './with-auth';

export type AdmitCandidate = {
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
  alreadyAdmitted?: boolean;
};

export type EnrollIo = HubIo & {
  wait?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  pollRedeemed?: () => Promise<AdmitCandidate | null>;
  ttlMs?: number;
  joinUrl?: string;
};

function log(io: EnrollIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

const PASSKEY_ENROLL_UNAVAILABLE =
  'This account requires passkey second-factor for password sign-in, so CLI password enrollment is unavailable. Use the web UI (Settings → Nodes → Node management → Add → generate a join code) and run the join command instead.';

function existingAdmission(
  ctx: LocalAuthContext,
  candidate: AdmitCandidate
): 'admitted' | 'revoked' | null {
  let nodeId: string;
  try {
    nodeId = nodeIdToHex(decodeCertificate(candidate.certificateBytes).node_id);
  } catch {
    return null;
  }
  const cert = ctx.userStore.getCert(nodeId);
  if (!cert) return null;
  if (cert.revokedLogSeq != null) return 'revoked';
  return 'admitted';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveTtlMs(parsed: ParsedArgs, io?: EnrollIo): number {
  if (io?.ttlMs !== undefined) return io.ttlMs;
  const raw = asString(parsed.flags.ttl);
  if (!raw) return ENROLLMENT_TTL_MS;
  return parseDurationMs(raw);
}

const redeemMailbox = new Map<string, AdmitCandidate>();

function mailboxKey(enrollPk: Uint8Array): string {
  return encodeBase64url(enrollPk);
}

export function noteRedeemedCertificate(enrollPk: Uint8Array, candidate: AdmitCandidate): void {
  redeemMailbox.set(mailboxKey(enrollPk), candidate);
}

function quoteJoinArg(value: string): string {
  if (/^[A-Za-z0-9._:/@%+=-]+$/.test(value)) return value;
  return quotePosixShellArg(value);
}

function hubJoinUrl(ctx: LocalAuthContext, io?: EnrollIo): string {
  return (
    io?.joinUrl ||
    ctx.env.TMEX_HUB_PUBLIC_URL ||
    ctx.env.TMEX_HUB_URL ||
    process.env.TMEX_HUB_PUBLIC_URL ||
    process.env.TMEX_HUB_URL ||
    'https://<hub-host>'
  );
}

export function parseEnrollmentAuthorizationJson(json: string): AdmitCandidate | null {
  try {
    const parsed = JSON.parse(json) as {
      certificate_b64?: unknown;
      cert_sig_b64?: unknown;
    };
    if (typeof parsed.certificate_b64 !== 'string' || typeof parsed.cert_sig_b64 !== 'string') {
      return null;
    }
    return {
      certificateBytes: decodeBase64url(parsed.certificate_b64),
      certSig: decodeBase64url(parsed.cert_sig_b64),
    };
  } catch {
    return null;
  }
}

export async function fakeLocalRedeem(
  ctx: LocalAuthContext,
  input: {
    enrollPk: Uint8Array;
    certificateBytes: Uint8Array;
    certSig: Uint8Array;
    name?: string;
  }
): Promise<void> {
  const token = ctx.userStore.getEnrollmentTokenByEnrollPublicKey(input.enrollPk);
  if (!token) {
    throw new Error('enrollment token not found');
  }
  const certificate = decodeCertificate(input.certificateBytes);
  const nodeId = nodeIdToHex(certificate.node_id);
  const now = Date.now();
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(token.authorizationJson) as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const authorizationJson = JSON.stringify({
    ...stored,
    certificate_b64: encodeBase64url(input.certificateBytes),
    cert_sig_b64: encodeBase64url(input.certSig),
  });
  ctx.sqlite.run(
    'UPDATE enrollment_tokens SET used_at = ?, node_id = ?, authorization_json = ? WHERE id = ?',
    [now, nodeId, authorizationJson, token.id]
  );
  if (!ctx.userStore.getNode(nodeId)) {
    ctx.userStore.createNode({
      id: nodeId,
      userId: token.userId,
      name: input.name ?? 'node',
      now,
    });
  }
  noteRedeemedCertificate(input.enrollPk, {
    certificateBytes: input.certificateBytes,
    certSig: input.certSig,
  });
}

export async function pollLocalEnrollmentRedeem(
  ctx: LocalAuthContext,
  enrollPk: Uint8Array
): Promise<AdmitCandidate | null> {
  const token = ctx.userStore.getEnrollmentTokenByEnrollPublicKey(enrollPk);
  if (!token?.usedAt || !token.nodeId) return null;
  if (!ctx.userStore.getNode(token.nodeId)) return null;
  const admitted = ctx.userStore.getCert(token.nodeId);
  if (admitted && admitted.revokedLogSeq === null) {
    return {
      certificateBytes: admitted.certificateBytes,
      certSig: admitted.certSig,
      alreadyAdmitted: true,
    };
  }
  return parseEnrollmentAuthorizationJson(token.authorizationJson);
}

export async function pollHubEnrollment(options: {
  baseUrl: string;
  cookieHeader: string;
  enrollmentId: string;
  fetcher?: FetchLike;
}): Promise<AdmitCandidate | null> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `${options.baseUrl.replace(/\/+$/, '')}/api/hub/enrollments/${encodeURIComponent(options.enrollmentId)}`,
    { headers: { cookie: options.cookieHeader }, redirect: 'error' }
  );
  if (!response.ok) return null;
  let body: {
    status?: unknown;
    certificate?: unknown;
    cert_sig?: unknown;
    already_admitted?: unknown;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return null;
  }
  if (body.status !== 'redeemed') return null;
  if (typeof body.certificate !== 'string' || typeof body.cert_sig !== 'string') return null;
  try {
    return {
      certificateBytes: decodeBase64url(body.certificate),
      certSig: decodeBase64url(body.cert_sig),
      alreadyAdmitted: body.already_admitted === true,
    };
  } catch {
    return null;
  }
}

export async function pollHubNodesForCertificate(options: {
  baseUrl: string;
  cookieHeader: string;
  enrollPk: Uint8Array;
  fetcher?: FetchLike;
}): Promise<AdmitCandidate | null> {
  const nodes = await listHubNodes(options);
  for (const node of nodes) {
    if (typeof node.certificate !== 'string' || typeof node.cert_sig !== 'string') continue;
    try {
      const certificateBytes = decodeBase64url(node.certificate);
      const cert = decodeCertificate(certificateBytes);
      if (!bytesEqual(cert.enroll_pk, options.enrollPk)) continue;
      return {
        certificateBytes,
        certSig: decodeBase64url(node.cert_sig),
        alreadyAdmitted: (node as { already_admitted?: unknown }).already_admitted === true,
      };
    } catch {
      // skip malformed hub node certificates
    }
  }
  return null;
}

async function resolveTotpCode(io?: EnrollIo): Promise<string> {
  if (io?.totpCode !== undefined) {
    if (!io.totpCode) throw new Error('TOTP code cannot be empty');
    return io.totpCode;
  }
  return await promptPassword('TOTP code', { envKey: 'TMEX_TOTP', confirm: false });
}

async function enrollOnLocalHub(
  ctx: LocalAuthContext,
  userId: string,
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  now: number,
  ttlMs: number
): Promise<string | undefined> {
  ctx.userStore.createEnrollmentToken({
    id: crypto.randomUUID(),
    userId,
    enrollPublicKey: enrollment.enrollPk,
    authorizationJson: JSON.stringify({
      authorization_b64: encodeBase64url(enrollment.authorizationBytes),
      entry_node_id: 'self',
    }),
    authorizationSig: enrollment.authorizationSig,
    expiresAt: now + ttlMs,
  });
  const tls = await new TlsConfigStore(ctx.db).get();
  if (tls.mode === 'selfsigned' && tls.caCertPem) {
    return await spkiFingerprint(tls.caCertPem);
  }
  return undefined;
}

async function assertCliPasswordEnrollAllowed(ctx: LocalAuthContext, io: EnrollIo): Promise<void> {
  const hubUrl = ctx.env.TMEX_HUB_URL || process.env.TMEX_HUB_URL;
  if (!hubUrl) {
    throw new Error('TMEX_HUB_URL is required to enroll from a non-hub node');
  }
  const fetcher = io.fetcher ?? createHubFetcher(new HubTrustStore(ctx.db), hubUrl);
  const mode = await fetchAuthMode(hubUrl, fetcher);
  if (mode.passkeySecondFactor) {
    throw new Error(PASSKEY_ENROLL_UNAVAILABLE);
  }
}

async function enrollOnRemoteHub(
  ctx: LocalAuthContext,
  io: EnrollIo,
  user: { id: string; rootEpoch: number },
  rootKey: Awaited<ReturnType<typeof deriveRootKey>>,
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  now: number,
  ttlMs: number
) {
  const hubUrl = ctx.env.TMEX_HUB_URL || process.env.TMEX_HUB_URL;
  if (!hubUrl) {
    throw new Error('TMEX_HUB_URL is required to enroll from a non-hub node');
  }
  const fetcher = io.fetcher ?? createHubFetcher(new HubTrustStore(ctx.db), hubUrl);
  const mode = await fetchAuthMode(hubUrl, fetcher);
  if (mode.passkeySecondFactor) {
    throw new Error(PASSKEY_ENROLL_UNAVAILABLE);
  }
  const caFingerprint =
    typeof mode.caFingerprint === 'string' && /^[0-9a-f]{64}$/.test(mode.caFingerprint)
      ? mode.caFingerprint
      : undefined;
  let totp: { code: string; kTotp: Uint8Array } | undefined;
  if (mode.totpEnabled) {
    totp = {
      code: await resolveTotpCode(io),
      kTotp: deriveTotpKey(rootKey.seed, user.id, user.rootEpoch),
    };
  }
  const session = await loginWithRootKey({
    baseUrl: hubUrl,
    rootKey,
    uid: user.id,
    fetcher,
    totp,
  });
  totp?.kTotp.fill(0);
  const created = await postEnrollment({
    baseUrl: hubUrl,
    cookieHeader: session.cookieHeader,
    enrollPk: enrollment.enrollPk,
    authorization: enrollment.authorizationBytes,
    authorizationSig: enrollment.authorizationSig,
    exp: now + ttlMs,
    fetcher,
  });
  return {
    cookieHeader: session.cookieHeader,
    hubUrl,
    enrollmentId: created.id,
    fetcher,
    caFingerprint,
  };
}

function makeRedeemPoll(
  ctx: LocalAuthContext,
  io: EnrollIo,
  isHub: boolean,
  enrollPk: Uint8Array,
  remote: Awaited<ReturnType<typeof enrollOnRemoteHub>> | null
): (() => Promise<AdmitCandidate | null>) | null {
  if (io.pollRedeemed) return io.pollRedeemed;
  if (isHub) return () => pollLocalEnrollmentRedeem(ctx, enrollPk);
  if (!remote) return null;
  const enrollmentId = remote.enrollmentId;
  if (enrollmentId) {
    return () =>
      pollHubEnrollment({
        baseUrl: remote.hubUrl,
        cookieHeader: remote.cookieHeader,
        enrollmentId,
        fetcher: remote.fetcher,
      });
  }
  return () =>
    pollHubNodesForCertificate({
      baseUrl: remote.hubUrl,
      cookieHeader: remote.cookieHeader,
      enrollPk,
      fetcher: remote.fetcher,
    });
}

async function pollAndAdmit(
  ctx: LocalAuthContext,
  io: EnrollIo,
  userId: string,
  rootKey: Awaited<ReturnType<typeof deriveRootKey>>,
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  poll: (() => Promise<AdmitCandidate | null>) | null
): Promise<boolean> {
  const interval = io.pollIntervalMs ?? 1000;
  const controller = io.signal ? null : new AbortController();
  const signal = io.signal ?? controller?.signal;
  const onSigint = (): void => {
    log(io, 'confirm in the Nodes page');
    controller?.abort();
  };
  if (controller && typeof process.on === 'function') process.on('SIGINT', onSigint);
  try {
    while (!signal?.aborted) {
      const candidate = poll ? await poll() : null;
      if (candidate) {
        const existing = existingAdmission(ctx, candidate);
        if (existing === 'revoked') throw new Error(NODE_REVOKED_REJOIN_ERROR);
        if (candidate.alreadyAdmitted || existing === 'admitted') {
          log(io, 'already admitted');
          return true;
        }
        const applied = await ctx.userKeys.signAndApply(userId, rootKey, {
          type: 'admit-node',
          payload: encodeAdmitNodePayload({
            authorization_bytes: enrollment.authorizationBytes,
            authorization_sig: enrollment.authorizationSig,
            certificate_bytes: candidate.certificateBytes,
            cert_sig: candidate.certSig,
          }),
        });
        if (!applied.ok) throw new Error(`admit-node failed: ${applied.error}`);
        log(io, 'node admitted');
        return true;
      }
      try {
        await sleep(interval, signal);
      } catch {
        log(io, 'confirm in the Nodes page');
        return false;
      }
    }
  } finally {
    if (controller && typeof process.off === 'function') {
      const emitter: NodeJS.EventEmitter = process;
      emitter.off('SIGINT', onSigint);
    }
  }
  return false;
}

export async function runEnroll(
  parsed: ParsedArgs,
  io: EnrollIo = {}
): Promise<{ token: string; joinCommand: string; admitted: boolean }> {
  const ttlMs = resolveTtlMs(parsed, io);

  return await withAuth(parsed, io, async (ctx) => {
    const users = ctx.db
      .select()
      .from((await import('../../../../apps/gateway/src/db/schema')).users)
      .all();
    if (users.length === 0) {
      throw new Error('no local user; run hub user add first');
    }
    const userRow = users[0];
    const user = ctx.userStore.getById(userRow.id);
    if (!user) {
      throw new Error('user missing');
    }
    const roles = parseTmexRoles(ctx.env.TMEX_ROLES ?? process.env.TMEX_ROLES);
    if (!roles.hub) {
      await assertCliPasswordEnrollAllowed(ctx, io);
    }
    const password = await resolvePassword({
      password: io.password,
      confirm: false,
      prompt: 'Password',
    });
    const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
    assertRootKeyMatches(rootKey, user.rootPublicKey);

    const now = io.now?.() ?? Date.now();
    const enrollment = await createEnrollment(rootKey, {
      uid: user.id,
      rootEpoch: user.rootEpoch,
      now,
      ttlMs,
    });
    const remote = roles.hub
      ? null
      : await enrollOnRemoteHub(ctx, io, user, rootKey, enrollment, now, ttlMs);
    const caFingerprint = roles.hub
      ? await enrollOnLocalHub(ctx, user.id, enrollment, now, ttlMs)
      : remote?.caFingerprint;

    const token = encodeJoinToken(
      enrollment.enrollSk,
      user.rootPublicKey,
      user.keyLogHeadHash,
      caFingerprint
    );
    const joinCommand = `tmex hub join ${quoteJoinArg(hubJoinUrl(ctx, io))} --token ${quoteJoinArg(token)}`;
    log(io, `join token: ${token}`);
    log(io, joinCommand);
    if (io.wait === false) {
      return { token, joinCommand, admitted: false };
    }
    const admitted = await pollAndAdmit(
      ctx,
      io,
      user.id,
      rootKey,
      enrollment,
      makeRedeemPoll(ctx, io, roles.hub, enrollment.enrollPk, remote)
    );
    return { token, joinCommand, admitted };
  });
}
