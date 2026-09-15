// 中继租户侧：切换主中继、摘单条、readmit-node 补签。不改 tenant-api.ts。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  type RootKey,
  buildRootReadmitAuthorization,
  decodeBase64url,
  encodeAdmitNodePayload,
} from '@vibeterm/shared/auth';
import type { CliContext } from './context';
import { CliError, NetworkError, NotFoundError, UsageError } from './errors';
import { httpStatusError, loginRequiredError } from './http';
import {
  type KeyLogAppendResult,
  appendKeyLog,
  assertKeyLogAppended,
  keyLogHead,
  signRecord,
  withRootKey,
} from './nodes-keylog';
import { assertRelayAck } from './nodes-relay';

export interface RelayPreparedPayload {
  payload: string;
  payloadHash?: string;
  alreadyCovered?: boolean;
}

export interface RelayReadmitEntry {
  nodeId: string;
  name: string | null;
  authorization_bytes: string;
  certificate_bytes: string;
  cert_sig: string;
}

export interface RelayReadmitPrepare {
  rootEpoch: number;
  entries: RelayReadmitEntry[];
}

export async function switchMeshRelay(ctx: CliContext, url: string): Promise<unknown> {
  const nodeId = await ctx.targetNodeId();
  return ctx.http.json(nodeId, 'POST', '/api/mesh/relay/switch', { url });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // 非 JSON
  }
  return {};
}

function nestedErrorCode(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function codeOf(body: Record<string, unknown>): string | null {
  return typeof body.code === 'string' ? body.code : nestedErrorCode(body.error);
}

export async function removeRelayPrepare(
  ctx: CliContext,
  url: string
): Promise<RelayPreparedPayload> {
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/mesh/relay/remove/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await readJson(response);
  if (response.ok) {
    if (typeof body.payload !== 'string' || !body.payload) {
      throw new CliError('remove/prepare did not return a payload');
    }
    return body as unknown as RelayPreparedPayload;
  }
  if (codeOf(body) === 'RELAY_LAST') {
    throw new CliError(
      'cannot remove the last relay',
      1,
      'use vibeterm relay leave to leave all relays'
    );
  }
  throw httpStatusError(
    SELF_NODE_ID,
    '/api/mesh/relay/remove/prepare',
    response.status,
    JSON.stringify(body)
  );
}

export async function appendSetRelays(
  ctx: CliContext,
  payloadB64: string
): Promise<KeyLogAppendResult> {
  return withRootKey(ctx, async (root, mode) => {
    const head = await keyLogHead(ctx);
    const signed = signRecord(root, head, mode, 'set-relays', decodeBase64url(payloadB64));
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertRelayAck(result, 'set-relays');
    return result;
  });
}

export async function removeRelay(ctx: CliContext, url: string): Promise<KeyLogAppendResult> {
  const prepared = await removeRelayPrepare(ctx, url);
  return appendSetRelays(ctx, prepared.payload);
}

export async function fetchReadmitPrepare(ctx: CliContext): Promise<RelayReadmitPrepare> {
  return ctx.http.json<RelayReadmitPrepare>(SELF_NODE_ID, 'GET', '/api/mesh/relay/readmit/prepare');
}

function readmitPayload(entry: RelayReadmitEntry, rootEpoch: number, root: RootKey): Uint8Array {
  const rebuilt = buildRootReadmitAuthorization({
    authorizationBytes: decodeBase64url(entry.authorization_bytes),
    rootEpoch,
    rootKey: root,
  });
  return encodeAdmitNodePayload({
    authorization_bytes: rebuilt.authorization_bytes,
    authorization_sig: rebuilt.authorization_sig,
    certificate_bytes: decodeBase64url(entry.certificate_bytes),
    cert_sig: decodeBase64url(entry.cert_sig),
  });
}

export interface ReadmitCliResult {
  signed: number;
  failed: number;
  total: number;
  results: KeyLogAppendResult[];
}

export type RelayEnrollPasswordView = {
  known: boolean;
  password: string | null;
  passwordEpoch: number | null;
};

export type RelayRotateEnrollPasswordRequest = {
  url: string;
  current?: string;
  next: string | null;
  mode: 'keep' | 'kick';
};

const RELAY_PASSWORD_PATH = '/api/mesh/relay/password';

function extraNumber(body: Record<string, unknown>, key: string): number | undefined {
  const direct = body[key];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const nested = body.error;
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function membersOfflineError(body: Record<string, unknown>): CliError {
  const online = extraNumber(body, 'online');
  const admitted = extraNumber(body, 'admitted');
  const counted =
    online !== undefined && admitted !== undefined ? ` ${online}/${admitted} online` : '';
  return new CliError(
    `members are offline (relay_members_offline)${counted}`,
    1,
    undefined,
    'relay_members_offline'
  );
}

function rateLimitedError(body: Record<string, unknown>): CliError {
  const retry = extraNumber(body, 'retryAfterMs');
  return new CliError(
    `rate limited (relay_rate_limited)${retry !== undefined ? `; retry after ${retry}ms` : ''}`,
    1,
    undefined,
    'relay_rate_limited'
  );
}

const PASSWORD_CODE_ERRORS: Record<string, (body: Record<string, unknown>) => CliError> = {
  relay_password_invalid: () =>
    new CliError(
      'current enroll password is invalid (relay_password_invalid)',
      1,
      undefined,
      'relay_password_invalid'
    ),
  INVALID_URL: () => new UsageError('invalid relay url (INVALID_URL)'),
  MALFORMED: () => new UsageError('malformed enroll-password request (MALFORMED)'),
  relay_password_too_short: () =>
    new UsageError('enroll password must be at least 8 characters (relay_password_too_short)'),
  relay_password_unset: () =>
    new CliError(
      'enroll password is not set on the relay (relay_password_unset)',
      1,
      undefined,
      'relay_password_unset'
    ),
  relay_members_offline: membersOfflineError,
  relay_rate_limited: rateLimitedError,
  relay_unreachable: () => new NetworkError('relay unreachable (relay_unreachable)'),
};

function throwRelayPasswordError(
  status: number,
  body: Record<string, unknown>,
  raw: string
): never {
  const code = codeOf(body);
  if (status === 401 && (code === 'UNAUTHORIZED' || !code)) {
    throw loginRequiredError(SELF_NODE_ID, raw);
  }
  if (code === 'relay_not_attached' || (status === 404 && code !== 'INVALID_URL')) {
    throw new NotFoundError(
      `relay not attached (${code ?? '404'})`,
      'run: vibeterm nodes relay ls'
    );
  }
  const mapped = code ? PASSWORD_CODE_ERRORS[code] : undefined;
  if (mapped) throw mapped(body);
  if (status === 502) throw new NetworkError('relay unreachable (HTTP 502)');
  throw httpStatusError(SELF_NODE_ID, RELAY_PASSWORD_PATH, status, raw);
}

async function relayPasswordResponse(
  ctx: CliContext,
  init: { method: string; path: string; body?: unknown }
): Promise<Record<string, unknown>> {
  const response = await ctx.http.fetch(SELF_NODE_ID, init.path, {
    method: init.method,
    ...(init.body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(init.body),
        }),
  });
  const body = await readJson(response);
  if (response.ok) return body;
  throwRelayPasswordError(response.status, body, JSON.stringify(body));
}

export function enrollPasswordView(body: Record<string, unknown>): RelayEnrollPasswordView {
  return {
    known: body.known === true,
    password: typeof body.password === 'string' ? body.password : null,
    passwordEpoch: typeof body.passwordEpoch === 'number' ? body.passwordEpoch : null,
  };
}

export async function fetchEnrollPassword(
  ctx: CliContext,
  url: string
): Promise<Record<string, unknown>> {
  return relayPasswordResponse(ctx, {
    method: 'GET',
    path: `${RELAY_PASSWORD_PATH}?url=${encodeURIComponent(url)}`,
  });
}

export async function rotateEnrollPassword(
  ctx: CliContext,
  request: RelayRotateEnrollPasswordRequest
): Promise<Record<string, unknown>> {
  return relayPasswordResponse(ctx, {
    method: 'POST',
    path: RELAY_PASSWORD_PATH,
    body: request,
  });
}

export async function readmitStaleMembers(ctx: CliContext): Promise<ReadmitCliResult> {
  const prepared = await fetchReadmitPrepare(ctx);
  const entries = prepared.entries ?? [];
  if (entries.length === 0) return { signed: 0, failed: 0, total: 0, results: [] };
  return withRootKey(ctx, async (root, mode) => {
    const results: KeyLogAppendResult[] = [];
    for (const entry of entries) {
      let payload: Uint8Array;
      try {
        payload = readmitPayload(entry, prepared.rootEpoch, root);
      } catch (error) {
        throw new CliError(
          `readmit material for ${entry.nodeId} is malformed: ${error instanceof Error ? error.message : error}`
        );
      }
      const head = await keyLogHead(ctx);
      const signed = signRecord(root, head, mode, 'readmit-node', payload);
      const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
      assertKeyLogAppended(result, 'readmit');
      results.push(result);
    }
    return { signed: results.length, failed: 0, total: entries.length, results };
  });
}
