import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  type AdmitNodePayload,
  ENROLLMENT_TTL_MS,
  createEnrollment,
  decodeCertificate,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeJoinToken,
  nodeIdToHex,
} from '../../../shared/src/auth';
import { parseDurationMs } from '../lib/duration';
import { loginWithRootKey, postEnrollment } from '../lib/hub-client';
import { type LocalAuthContext, openInstallAuth } from '../lib/local-auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from '../lib/password';
import { parseTmexRoles } from '../lib/roles';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import type { HubIo } from './hub';

export type AdmitCandidate = {
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });
}

async function withAuth<T>(
  parsed: ParsedArgs,
  io: EnrollIo | undefined,
  fn: (ctx: LocalAuthContext) => Promise<T>
): Promise<T> {
  if (io?.auth) {
    return await fn(io.auth);
  }
  const ctx = await openInstallAuth(parsed);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
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
  ctx.userStore.markEnrollmentUsed(token.id, { nodeId, now });
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

function localRedeemPoller(
  ctx: LocalAuthContext,
  enrollPk: Uint8Array
): () => Promise<AdmitCandidate | null> {
  return async () => {
    const token = ctx.userStore.getEnrollmentTokenByEnrollPublicKey(enrollPk);
    if (!token?.usedAt) return null;
    return redeemMailbox.get(mailboxKey(enrollPk)) ?? null;
  };
}

export async function runEnroll(
  parsed: ParsedArgs,
  io: EnrollIo = {}
): Promise<{ token: string; joinCommand: string; admitted: boolean }> {
  const password = await resolvePassword({
    password: io.password,
    confirm: false,
    prompt: 'Password',
  });
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
    const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
    assertRootKeyMatches(rootKey, user.rootPublicKey);

    const now = io.now?.() ?? Date.now();
    const enrollment = await createEnrollment(rootKey, {
      uid: user.id,
      rootEpoch: user.rootEpoch,
      now,
      ttlMs,
    });
    const token = encodeJoinToken(enrollment.enrollSk, user.rootPublicKey, user.keyLogHeadHash);
    const roles = parseTmexRoles(ctx.env.TMEX_ROLES ?? process.env.TMEX_ROLES);

    if (roles.hub) {
      ctx.userStore.createEnrollmentToken({
        id: crypto.randomUUID(),
        userId: user.id,
        enrollPublicKey: enrollment.enrollPk,
        authorizationJson: JSON.stringify({
          authorization_b64: encodeBase64url(enrollment.authorizationBytes),
          entry_node_id: 'self',
        }),
        authorizationSig: enrollment.authorizationSig,
        expiresAt: now + ttlMs,
      });
    } else {
      const hubUrl = ctx.env.TMEX_HUB_URL || process.env.TMEX_HUB_URL;
      if (!hubUrl) {
        throw new Error('TMEX_HUB_URL is required to enroll from a non-hub node');
      }
      const session = await loginWithRootKey({
        baseUrl: hubUrl,
        rootKey,
        uid: user.id,
        fetcher: io.fetcher,
      });
      await postEnrollment({
        baseUrl: hubUrl,
        cookieHeader: session.cookieHeader,
        enrollPk: enrollment.enrollPk,
        authorization: enrollment.authorizationBytes,
        authorizationSig: enrollment.authorizationSig,
        exp: now + ttlMs,
        fetcher: io.fetcher,
      });
    }

    const joinUrl = hubJoinUrl(ctx, io);
    const joinCommand = `npx tmex-cli hub join ${joinUrl} --token ${token}`;
    log(io, `join token: ${token}`);
    log(io, joinCommand);

    const shouldWait = io.wait !== false;
    if (!shouldWait) {
      return { token, joinCommand, admitted: false };
    }

    const poll =
      io.pollRedeemed ?? (roles.hub ? localRedeemPoller(ctx, enrollment.enrollPk) : null);
    const interval = io.pollIntervalMs ?? 1000;
    const signal = io.signal;
    let admitted = false;
    const onSigint = (): void => {
      log(io, 'confirm in the Nodes page');
    };
    if (!signal && typeof process.on === 'function') {
      process.on('SIGINT', onSigint);
    }
    try {
      while (!signal?.aborted) {
        const candidate = poll ? await poll() : null;
        if (candidate) {
          const payload: AdmitNodePayload = {
            authorization_bytes: enrollment.authorizationBytes,
            authorization_sig: enrollment.authorizationSig,
            certificate_bytes: candidate.certificateBytes,
            cert_sig: candidate.certSig,
          };
          const applied = await ctx.userKeys.signAndApply(user.id, rootKey, {
            type: 'admit-node',
            payload: encodeAdmitNodePayload(payload),
          });
          if (!applied.ok) {
            throw new Error(`admit-node failed: ${applied.error}`);
          }
          admitted = true;
          log(io, 'node admitted');
          break;
        }
        try {
          await sleep(interval, signal);
        } catch {
          log(io, 'confirm in the Nodes page');
          break;
        }
      }
    } finally {
      if (!signal && typeof process.off === 'function') {
        process.off('SIGINT', onSigint);
      }
    }

    return { token, joinCommand, admitted };
  });
}
