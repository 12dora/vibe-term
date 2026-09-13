// 用根钥签 enrollment / admit / revoke。根种子只在回调里活着，用完清零。

import { NODE_ID_PATTERN, SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  type KeyLogType,
  MIN_HUB_AUTH_RECORD_VERSION,
  type RootKey,
  buildAdmitHubPayload,
  buildKeyLogRecord,
  buildRenameNodePayload,
  bytesEqual,
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
import { FORCE_KEYLOG_HEADER } from '@vibeterm/shared/http/mesh-headers';
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
  sig: Uint8Array,
  options?: { force?: boolean }
): Promise<KeyLogAppendResult> {
  const headers = new Headers();
  if (options?.force) {
    headers.set(FORCE_KEYLOG_HEADER.name, '1');
    headers.set(FORCE_KEYLOG_HEADER.legacy, '1');
  }
  return ctx.http.json(
    SELF_NODE_ID,
    'POST',
    '/api/auth/keylog?hub=sync',
    { bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) },
    { headers }
  );
}

export function assertKeyLogAppended(result: KeyLogAppendResult, action: string): void {
  if (!result.ok) {
    throw new CliError(`${action} failed: ${result.code ?? 'rejected'}`);
  }
  if (result.hubAck !== true) {
    throw new CliError(`${action} was not confirmed by hub (${result.hubError ?? 'no ack'})`);
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

export async function admitPendingNode(
  ctx: CliContext,
  row: HubNodeRow,
  options?: { after?: (root: RootKey, mode: AuthMode) => Promise<void> }
): Promise<unknown> {
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
    assertKeyLogAppended(result, 'admit');
    if (options?.after) await options.after(root, mode);
    return result;
  });
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

export interface UnsupportedKeyLogNode {
  id: string;
  name: string;
  version: string | null;
}

export type AdmitHubAppendOutcome =
  | { kind: 'ok'; result: KeyLogAppendResult }
  | { kind: 'unsupportedNodes'; minVersion: string; nodes: UnsupportedKeyLogNode[] }
  | { kind: 'failed'; code: string };

function parseUnsupportedNodes(value: unknown): UnsupportedKeyLogNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: UnsupportedKeyLogNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const node = item as Partial<UnsupportedKeyLogNode>;
    if (typeof node.id !== 'string') continue;
    nodes.push({
      id: node.id,
      name: typeof node.name === 'string' ? node.name : node.id.slice(0, 8),
      version: typeof node.version === 'string' ? node.version : null,
    });
  }
  return nodes;
}

function envelopeCode(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.code === 'string') return body.code;
  if (typeof body.error === 'string') return body.error;
  return fallback;
}

async function appendKeyLogRaw(
  ctx: CliContext,
  bytes: Uint8Array,
  sig: Uint8Array,
  force: boolean
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (force) {
    headers[FORCE_KEYLOG_HEADER.name] = '1';
    headers[FORCE_KEYLOG_HEADER.legacy] = '1';
  }
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/auth/keylog?hub=sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) }),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // 非 JSON
  }
  return { status: response.status, body };
}

export async function admitHubViaKeyLog(
  ctx: CliContext,
  input: { hubNodeId: string; publicUrl: string | null; priority?: number | null; force?: boolean }
): Promise<AdmitHubAppendOutcome> {
  assertNodeHexId(input.hubNodeId);
  return withRootKey(ctx, async (root, mode) => {
    const head = await keyLogHead(ctx);
    const signed = signRecord(
      root,
      head,
      mode,
      'admit-hub',
      buildAdmitHubPayload({
        hubNodeId: hexToBytes(input.hubNodeId),
        publicUrl: input.publicUrl,
        priority: input.priority ?? null,
      })
    );
    const { status, body } = await appendKeyLogRaw(
      ctx,
      signed.bytes,
      signed.sig,
      input.force === true
    );
    if (status >= 200 && status < 300) {
      const result: KeyLogAppendResult = {
        ok: body.ok !== false,
        seq: typeof body.seq === 'number' || typeof body.seq === 'string' ? body.seq : undefined,
        hubAck: typeof body.hubAck === 'boolean' ? body.hubAck : undefined,
        hubError: typeof body.hubError === 'string' ? body.hubError : undefined,
        relayAck: typeof body.relayAck === 'boolean' ? body.relayAck : undefined,
        relayError: typeof body.relayError === 'string' ? body.relayError : undefined,
        code: typeof body.code === 'string' ? body.code : undefined,
      };
      if (result.hubAck !== true) {
        return { kind: 'failed', code: result.hubError || 'HUB_UNCONFIRMED' };
      }
      return { kind: 'ok', result };
    }
    const code = envelopeCode(body, 'KEY_LOG_REJECTED');
    if (code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) {
      return {
        kind: 'unsupportedNodes',
        minVersion:
          typeof body.minVersion === 'string' ? body.minVersion : MIN_HUB_AUTH_RECORD_VERSION,
        nodes: parseUnsupportedNodes(body.nodes),
      };
    }
    return { kind: 'failed', code };
  });
}
