import {
  type RelayEnvelope,
  type RelayKeyLogEntry,
  openRelayKeyLogRecord,
} from '../../../shared/src/relay';
import {
  RELAY_REDEEM_RESPONSE_MAX_BYTES,
  joinRelayUrl,
  requestRelayJson,
} from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';

export type RelayKeyLogPageItem = { seq: number | string; blob: RelayEnvelope };

function seqOf(item: RelayKeyLogPageItem): bigint {
  return BigInt(item.seq);
}

/** 打开一页密钥日志块，按 seq 升序返回；seq 必须从 `firstSeq`（默认 1）起连续，否则拒绝整页。 */
export async function openRelayKeyLogPage(
  logKey: Uint8Array,
  items: readonly RelayKeyLogPageItem[],
  firstSeq = 1n
): Promise<RelayKeyLogEntry[]> {
  const sorted = [...items].sort((a, b) =>
    seqOf(a) < seqOf(b) ? -1 : seqOf(a) > seqOf(b) ? 1 : 0
  );
  const out: RelayKeyLogEntry[] = [];
  let expected = firstSeq;
  for (const item of sorted) {
    if (seqOf(item) !== expected) {
      throw new Error(`relay key log is not contiguous at seq ${String(item.seq)}`);
    }
    expected += 1n;
    out.push(await openRelayKeyLogRecord(logKey, item.blob));
  }
  return out;
}

export function parseRelayKeyLogPage(value: unknown): RelayKeyLogPageItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const seq = item.seq;
    if (typeof seq !== 'number' && typeof seq !== 'string') {
      throw new Error('relay key log entry missing seq');
    }
    if (!item.blob || typeof item.blob !== 'object') {
      throw new Error('relay key log entry missing blob');
    }
    return { seq, blob: item.blob as RelayEnvelope };
  });
}

const KEY_LOG_FETCH_PAGE = 64;

/** 用租户令牌分页拉 `fromSeq`（默认 1）起的整段密钥日志，逐块用 K_log 打开；seq 必须连续。 */
export async function fetchRelayKeyLog(input: {
  relayUrl: string;
  tenantId: string;
  headers: Record<string, string>;
  logKey: Uint8Array;
  fromSeq?: number;
  fetcher?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<RelayKeyLogEntry[]> {
  const firstSeq = input.fromSeq ?? 1;
  const items: RelayKeyLogPageItem[] = [];
  let next = firstSeq;
  for (;;) {
    const body = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(
        input.relayUrl,
        `/api/relay/tenants/${input.tenantId}/keylog?from_seq=${next}&limit=${KEY_LOG_FETCH_PAGE}`
      ),
      headers: input.headers,
      label: 'relay key log',
      maxBytes: RELAY_REDEEM_RESPONSE_MAX_BYTES,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const page = parseRelayKeyLogPage(body.key_log);
    items.push(...page);
    if (body.has_more !== true || page.length === 0) break;
    const last = page[page.length - 1];
    next = Number(last?.seq ?? next) + 1;
    if (!Number.isFinite(next) || next <= 0) break;
  }
  return openRelayKeyLogPage(input.logKey, items, BigInt(firstSeq));
}
