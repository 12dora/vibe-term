import {
  type RelayEnvelope,
  type RelayKeyLogEntry,
  openRelayKeyLogRecord,
} from '../../../shared/src/relay';

export type RelayKeyLogPageItem = { seq: number | string; blob: RelayEnvelope };

function seqOf(item: RelayKeyLogPageItem): bigint {
  return BigInt(item.seq);
}

/** 打开一页密钥日志块，按 seq 升序返回；seq 必须从 1 起连续，否则拒绝整页。 */
export async function openRelayKeyLogPage(
  logKey: Uint8Array,
  items: readonly RelayKeyLogPageItem[]
): Promise<RelayKeyLogEntry[]> {
  const sorted = [...items].sort((a, b) =>
    seqOf(a) < seqOf(b) ? -1 : seqOf(a) > seqOf(b) ? 1 : 0
  );
  const out: RelayKeyLogEntry[] = [];
  let expected = 1n;
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
