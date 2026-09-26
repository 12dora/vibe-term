// 用根钥签 enrollment / admit / revoke。根种子只在回调里活着，用完清零。

import { NODE_ID_PATTERN, SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  type KeyLogType,
  type RootKey,
  buildKeyLogRecord,
  buildRenameNodePayload,
  bytesEqual,
  decodeBase64url,
  deriveSeed,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@vibeterm/shared/auth';
import { type AuthMode, fetchAuthMode, noteDerivingKey } from './auth';
import type { CliContext } from './context';
import { AuthError, CliError, UsageError } from './errors';
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

export function assertKdfParamsFloor(params: {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}): void {
  if (
    params.memory_kib < ARGON2ID_MEMORY_KIB ||
    params.iterations < ARGON2ID_ITERATIONS ||
    params.parallelism < ARGON2ID_PARALLELISM
  ) {
    throw new AuthError(
      'auth mode advertised weaker argon2id parameters than this client accepts',
      'the entry may be malicious; refuse to derive'
    );
  }
}

export function assertRootMatchesMode(root: RootKey, mode: AuthMode): void {
  if (!mode.rootPublicKey) {
    root.seed.fill(0);
    throw new AuthError(
      'auth mode is missing rootPublicKey; cannot verify the password',
      'upgrade the entry or sign from the GUI'
    );
  }
  const expected = decodeBase64url(mode.rootPublicKey);
  if (!bytesEqual(root.publicKey, expected)) {
    root.seed.fill(0);
    throw new AuthError('wrong password', 'check VIBETERM_PASSWORD');
  }
}

export function assertNodeHexId(nodeId: string): void {
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new UsageError(`node id must be 32 lowercase hex chars: ${nodeId}`);
  }
}

export async function deriveRootFromMode(mode: AuthMode, password: string): Promise<RootKey> {
  if (!mode.uid || !mode.kdfParams || mode.rootEpoch === null || mode.rootEpoch === undefined) {
    throw new CliError('auth mode is missing uid/kdf/rootEpoch; cannot sign');
  }
  assertKdfParamsFloor(mode.kdfParams);
  noteDerivingKey();
  const seed = await deriveSeed(password, {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  try {
    const root = rootKeyFromSeed(seed);
    assertRootMatchesMode(root, mode);
    return root;
  } finally {
    seed.fill(0);
  }
}

export async function withRootKey<T>(
  ctx: CliContext,
  run: (root: RootKey, mode: AuthMode) => Promise<T>
): Promise<T> {
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (!mode || mode.mode !== 'mesh') {
    throw new CliError('this entry is not a mesh instance');
  }
  const password = await readAccountPassword();
  const root = await deriveRootFromMode(mode, password);
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

export async function keyLogHead(ctx: CliContext): Promise<{ seq: bigint; hash: Uint8Array }> {
  const payload = await ctx.http.json<KeyLogHeadJson>(SELF_NODE_ID, 'GET', '/api/auth/keylog/head');
  return { seq: BigInt(payload.seq), hash: decodeBase64url(payload.hash) };
}

export interface KeyLogAppendResult {
  ok: boolean;
  seq?: number | string;
  hubAck?: boolean;
  relayAck?: boolean;
  code?: string;
  hubError?: string;
  relayError?: string;
}

export async function appendKeyLog(
  ctx: CliContext,
  bytes: Uint8Array,
  sig: Uint8Array
): Promise<KeyLogAppendResult> {
  return ctx.http.json(SELF_NODE_ID, 'POST', '/api/auth/keylog?hub=sync', {
    bytes: encodeBase64url(bytes),
    sig: encodeBase64url(sig),
  });
}

export function assertKeyLogAppended(result: KeyLogAppendResult, action: string): void {
  if (!result.ok) {
    throw new CliError(`${action} failed: ${result.code ?? 'rejected'}`);
  }
  if (result.hubAck === false) {
    throw new CliError(`${action} failed: ${result.hubError ?? 'not applied'}`);
  }
}

export function signRecord(
  root: RootKey,
  head: { seq: bigint; hash: Uint8Array },
  mode: AuthMode,
  type: KeyLogType,
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

export async function revokeNode(
  ctx: CliContext,
  nodeId: string,
  reason: string
): Promise<unknown> {
  assertNodeHexId(nodeId);
  return withRootKey(ctx, async (root, mode) => {
    const head = await keyLogHead(ctx);
    const nodeBytes = hexToBytes(nodeId);
    const signed = signRecord(
      root,
      head,
      mode,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: nodeBytes, reason })
    );
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'revoke');
    return result;
  });
}

export async function renameNodeViaKeyLog(
  ctx: CliContext,
  nodeId: string,
  name: string
): Promise<KeyLogAppendResult> {
  assertNodeHexId(nodeId);
  let payload: Uint8Array;
  try {
    payload = buildRenameNodePayload({ nodeId: hexToBytes(nodeId), name });
  } catch {
    throw new UsageError(`invalid node name: ${name}`);
  }
  return withRootKey(ctx, async (root, mode) => {
    const head = await keyLogHead(ctx);
    const signed = signRecord(root, head, mode, 'rename-node', payload);
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'rename');
    return result;
  });
}
