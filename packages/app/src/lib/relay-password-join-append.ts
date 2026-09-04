import { relayMemberFromRecord } from '../../../../apps/gateway/src/mesh/relay-key-log-sync';
import { decodeKeyLogRecord, encodeBase64url } from '../../../shared/src/auth';
import { RELAY_KEYLOG_SEQ_MISMATCH, sealRelayKeyLogRecord } from '../../../shared/src/relay';
import { RelayApiError, joinRelayUrl, requestRelayJson } from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';

export const RELAY_JOIN_APPEND_ATTEMPTS = 4;

export type JoinRecord = { bytes: Uint8Array; sig: Uint8Array };

export type AppendPairResult =
  | { ok: true }
  | { ok: false; kind: 'seq_mismatch' }
  | { ok: false; kind: 'member_ignored' }
  | { ok: false; kind: 'admit_failed'; error: unknown }
  | { ok: false; kind: 'meta_failed'; error: unknown };

function tenantHeaders(token: Uint8Array): Record<string, string> {
  return { 'x-tmex-relay-token': encodeBase64url(token) };
}

export function isRelaySeqMismatch(error: unknown): boolean {
  if (!(error instanceof RelayApiError)) return false;
  if (error.code === RELAY_KEYLOG_SEQ_MISMATCH || error.code === 'SEQ_MISMATCH') return true;
  return error.message.includes('SEQ_MISMATCH');
}

export async function appendOneJoinRecord(input: {
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  logKey: Uint8Array;
  record: JoinRecord;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const seq = decodeKeyLogRecord(input.record.bytes).seq;
  const blob = await sealRelayKeyLogRecord(input.logKey, input.record);
  const member = relayMemberFromRecord(input.record);
  return await requestRelayJson({
    fetcher: input.fetcher,
    url: joinRelayUrl(input.relayUrl, `/api/relay/tenants/${input.tenantId}/keylog`),
    method: 'POST',
    headers: tenantHeaders(input.token),
    body: {
      seq: Number(seq) <= Number.MAX_SAFE_INTEGER ? Number(seq) : seq.toString(),
      blob,
      ...(member ? { member } : {}),
    },
    label: 'relay key log append',
    timeoutMs: input.timeoutMs,
  });
}

/**
 * 先向中继追加 admit-node（带 sidecar）再追加 meta-key。
 * 仅第一条 SEQ_MISMATCH 由调用方整对重试；第一条已成功则不再重试第二条。
 */
export async function appendAdmitThenMeta(input: {
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  logKey: Uint8Array;
  admit: JoinRecord;
  meta: JoinRecord;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<AppendPairResult> {
  let admitBody: Record<string, unknown>;
  try {
    admitBody = await appendOneJoinRecord({ ...input, record: input.admit });
  } catch (error) {
    if (isRelaySeqMismatch(error)) return { ok: false, kind: 'seq_mismatch' };
    return { ok: false, kind: 'admit_failed', error };
  }
  if (admitBody.member_ignored === true) return { ok: false, kind: 'member_ignored' };
  try {
    await appendOneJoinRecord({ ...input, record: input.meta });
  } catch (error) {
    return { ok: false, kind: 'meta_failed', error };
  }
  return { ok: true };
}

export async function appendAdmitThenMetaRetrying(
  input: Omit<Parameters<typeof appendAdmitThenMeta>[0], 'admit' | 'meta'> & {
    load: () => Promise<{ admit: JoinRecord; meta: JoinRecord; nodeId: string }>;
    append?: typeof appendAdmitThenMeta;
  }
): Promise<AppendPairResult & { nodeId: string }> {
  const append = input.append ?? appendAdmitThenMeta;
  let nodeId = '';
  for (let attempt = 0; attempt < RELAY_JOIN_APPEND_ATTEMPTS; attempt++) {
    const pair = await input.load();
    nodeId = pair.nodeId;
    const result = await append({ ...input, admit: pair.admit, meta: pair.meta });
    if (result.ok) return { ok: true, nodeId };
    if (result.kind === 'seq_mismatch' && attempt + 1 < RELAY_JOIN_APPEND_ATTEMPTS) continue;
    return { ...result, nodeId };
  }
  return { ok: false, kind: 'admit_failed', error: new Error('exhausted'), nodeId };
}
