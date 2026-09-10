// 用根钥签 enrollment / admit / revoke。根种子只在回调里活着，用完清零。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  type RootKey,
  buildKeyLogRecord,
  createEnrollment,
  decodeBase64url,
  deriveSeed,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeJoinToken,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@vibeterm/shared/auth';
import { type AuthMode, fetchAuthMode } from './auth';
import type { CliContext } from './context';
import { AuthError, CliError, UsageError } from './errors';
import { type HubNodeRow, isTrustedHubUrl, joinCommand, resolveHubNodeId } from './nodes-hub';
import { isInteractive, promptHidden } from './prompt';

export async function readAccountPassword(): Promise<string> {
  const fromEnv = process.env.VIBETERM_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!isInteractive()) {
    throw new AuthError(
      'a password is required to sign this operation and stdin is not a terminal',
      'set VIBETERM_PASSWORD'
    );
  }
  const value = await promptHidden('Password: ');
  if (!value) throw new UsageError('password is empty');
  return value;
}

async function deriveRoot(mode: AuthMode, password: string): Promise<RootKey> {
  if (!mode.uid || !mode.kdfParams || mode.rootEpoch === null || mode.rootEpoch === undefined) {
    throw new CliError('auth mode is missing uid/kdf/rootEpoch; cannot sign');
  }
  const seed = await deriveSeed(password, {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  try {
    return rootKeyFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

async function withRootKey<T>(
  ctx: CliContext,
  run: (root: RootKey, mode: AuthMode) => Promise<T>
): Promise<T> {
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (!mode || mode.mode !== 'mesh') {
    throw new CliError('this entry is not a mesh instance');
  }
  const password = await readAccountPassword();
  const root = await deriveRoot(mode, password);
  try {
    return await run(root, mode);
  } finally {
    root.seed.fill(0);
  }
}

interface KeyLogHeadJson {
  seq: number | string;
  hash: string;
  rootEpoch?: number;
}

async function keyLogHead(ctx: CliContext): Promise<{ seq: bigint; hash: Uint8Array }> {
  const payload = await ctx.http.json<KeyLogHeadJson>(SELF_NODE_ID, 'GET', '/api/auth/keylog/head');
  return { seq: BigInt(payload.seq), hash: decodeBase64url(payload.hash) };
}

async function appendKeyLog(
  ctx: CliContext,
  bytes: Uint8Array,
  sig: Uint8Array
): Promise<{ ok: boolean; hubAck?: boolean; code?: string; hubError?: string }> {
  return ctx.http.json(SELF_NODE_ID, 'POST', '/api/auth/keylog?hub=sync', {
    bytes: encodeBase64url(bytes),
    sig: encodeBase64url(sig),
  });
}

function signRecord(
  root: RootKey,
  head: { seq: bigint; hash: Uint8Array },
  mode: AuthMode,
  type: 'admit-node' | 'revoke-node',
  payload: Uint8Array
): { bytes: Uint8Array; sig: Uint8Array } {
  const record = buildKeyLogRecord(head, mode.rootEpoch as number, {
    uid: mode.uid as string,
    type,
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  return { bytes, sig: signKeyLogRecordWithRoot(root, bytes) };
}

export interface CreatedEnrollmentResult {
  id: string;
  expiresAt: number;
  joinToken: string;
  joinCommand: string | null;
  publicUrl: string | null;
  caFingerprint: string | null;
}

export async function createSignedEnrollment(
  ctx: CliContext,
  options: { ttlMs: number; name?: string; hubPublicUrl?: string | null }
): Promise<CreatedEnrollmentResult> {
  return withRootKey(ctx, async (root, mode) => {
    const now = Date.now();
    const enrollment = await createEnrollment(root, {
      uid: mode.uid as string,
      rootEpoch: mode.rootEpoch as number,
      now,
      ttlMs: options.ttlMs,
    });
    try {
      const head = await keyLogHead(ctx);
      const hubId = await resolveHubNodeId(ctx);
      const created = await ctx.http.json<{
        ok?: boolean;
        id: string;
        expires_at: number;
        public_url?: string | null;
        ca_fingerprint?: string | null;
      }>(hubId, 'POST', '/api/hub/enrollments', {
        enroll_pk: encodeBase64url(enrollment.enrollPk),
        authorization: encodeBase64url(enrollment.authorizationBytes),
        authorization_sig: encodeBase64url(enrollment.authorizationSig),
        exp: now + options.ttlMs,
      });
      const rootPk = mode.rootPublicKey ? decodeBase64url(mode.rootPublicKey) : root.publicKey;
      const token = encodeJoinToken(
        enrollment.enrollSk,
        rootPk,
        head.hash,
        created.ca_fingerprint ?? null
      );
      const publicUrl = created.public_url ?? options.hubPublicUrl ?? mode.hubPublicUrl ?? null;
      return {
        id: created.id,
        expiresAt: created.expires_at,
        joinToken: token,
        joinCommand:
          publicUrl && isTrustedHubUrl(publicUrl)
            ? joinCommand(publicUrl, token, options.name)
            : null,
        publicUrl,
        caFingerprint: created.ca_fingerprint ?? null,
      };
    } finally {
      enrollment.enrollSk.fill(0);
    }
  });
}

export async function admitPendingNode(ctx: CliContext, row: HubNodeRow): Promise<unknown> {
  if (!row.authorization || !row.authorization_sig || !row.certificate || !row.cert_sig) {
    throw new CliError(
      `node ${row.id} is pending but hub did not send admit material`,
      1,
      'refresh later or admit from the GUI'
    );
  }
  return withRootKey(ctx, async (root, mode) => {
    const head = await keyLogHead(ctx);
    const signed = signRecord(
      root,
      head,
      mode,
      'admit-node',
      encodeAdmitNodePayload({
        authorization_bytes: decodeBase64url(row.authorization as string),
        authorization_sig: decodeBase64url(row.authorization_sig as string),
        certificate_bytes: decodeBase64url(row.certificate as string),
        cert_sig: decodeBase64url(row.cert_sig as string),
      })
    );
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    if (!result.ok) {
      throw new CliError(`admit failed: ${result.code ?? 'rejected'}`);
    }
    if (result.hubAck !== true) {
      throw new CliError(`admit was not confirmed by hub (${result.hubError ?? 'no ack'})`);
    }
    return result;
  });
}

export async function revokeNode(
  ctx: CliContext,
  nodeId: string,
  reason: string
): Promise<unknown> {
  return withRootKey(ctx, async (root, mode) => {
    const head = await keyLogHead(ctx);
    const nodeBytes = hexToBytes(nodeId);
    if (nodeBytes.length !== 16) throw new UsageError(`node id must be 32 hex chars: ${nodeId}`);
    const signed = signRecord(
      root,
      head,
      mode,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: nodeBytes, reason })
    );
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    if (!result.ok) {
      throw new CliError(`revoke failed: ${result.code ?? 'rejected'}`);
    }
    if (result.hubAck !== true) {
      throw new CliError(`revoke was not confirmed by hub (${result.hubError ?? 'no ack'})`);
    }
    return result;
  });
}
