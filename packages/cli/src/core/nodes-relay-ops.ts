// 中继租户侧：切换主中继、摘单条、readmit-node 补签。不改 tenant-api.ts。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  type RootKey,
  buildRootReadmitAuthorization,
  decodeBase64url,
  encodeAdmitNodePayload,
} from '@vibeterm/shared/auth';
import type { CliContext } from './context';
import { CliError } from './errors';
import { httpStatusError } from './http';
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
  return ctx.http.json(SELF_NODE_ID, 'POST', '/api/mesh/relay/switch', { url });
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

function codeOf(body: Record<string, unknown>): string | null {
  return typeof body.code === 'string' ? body.code : null;
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
