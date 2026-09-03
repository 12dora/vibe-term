import {
  RELAY_CTL_MAX_BYTES,
  type RelayKeyLogRecordWire,
  relaySeqToWire,
} from '@tmex/shared/relay';
import { parseRelayEnvelopeJson } from './relay-key-log-store';
import type { RelayKeyLogRow } from './types';

/** 与 hub 的 key-log 分页同规矩：整帧 ≤64 KiB，超限就少发几条并置 has_more。 */
export const RELAY_KEY_LOG_PAGE_MAX_BYTES = RELAY_CTL_MAX_BYTES;

const te = new TextEncoder();

export function toRelayKeyLogWire(row: RelayKeyLogRow): RelayKeyLogRecordWire | null {
  const envelope = parseRelayEnvelopeJson(row.blob);
  if (!envelope) return null;
  return { seq: relaySeqToWire(row.seq), blob: envelope };
}

export function trimRelayKeyLogPage(
  rows: readonly RelayKeyLogRow[],
  hasMore: boolean,
  opts?: { type?: 'relay.keylog.res' | 'relay.keylog.push'; maxBytes?: number }
): { records: RelayKeyLogRecordWire[]; hasMore: boolean } {
  const maxBytes = opts?.maxBytes ?? RELAY_KEY_LOG_PAGE_MAX_BYTES;
  const type = opts?.type ?? 'relay.keylog.res';
  const wire: RelayKeyLogRecordWire[] = [];
  for (const row of rows) {
    const record = toRelayKeyLogWire(row);
    if (record) wire.push(record);
  }
  const n = wire.length;
  if (n === 0) return { records: wire, hasMore };
  const sizes = wire.map((record) => te.encode(JSON.stringify(record)).byteLength);
  if (frameBytes(type, sizes, n, hasMore) <= maxBytes) {
    return { records: wire, hasMore };
  }
  const envelope = envelopeBytes(type, true);
  let inner = 0;
  let chosen = 0;
  for (let i = 0; i < n - 1; i++) {
    const next = inner + sizes[i] + (i > 0 ? 1 : 0);
    if (envelope + next > maxBytes) break;
    inner = next;
    chosen = i + 1;
  }
  return { records: wire.slice(0, chosen), hasMore: true };
}

function envelopeBytes(type: string, hasMore: boolean): number {
  return te.encode(JSON.stringify({ t: type, records: [], has_more: hasMore })).byteLength;
}

function frameBytes(type: string, sizes: readonly number[], n: number, hasMore: boolean): number {
  let inner = 0;
  for (let i = 0; i < n; i++) {
    inner += sizes[i];
    if (i > 0) inner += 1;
  }
  return envelopeBytes(type, hasMore) + inner;
}
