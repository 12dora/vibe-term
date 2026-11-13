import {
  type RelayKeyLogEntry,
  type RelayKeyLogRecordWire,
  openRelayKeyLogRecord,
  relaySeqFromWire,
} from '@vibeterm/shared/relay';
import { stamp } from './mesh-log';

export type RelayOpenedKeyLogPage = {
  records: RelayKeyLogEntry[];
  /** 解不开的记录数（0 或 1：遇到第一条就停）。 */
  skipped: number;
  maxSeq: bigint;
};

/** 按 seq 排序后逐条解密，遇到第一条解不开的就停在那里（后面的链接不上）。 */
export async function openRelayKeyLogPage(
  key: Uint8Array,
  rows: readonly RelayKeyLogRecordWire[]
): Promise<RelayOpenedKeyLogPage> {
  const sorted = [...rows].sort((a, b) => {
    const as = relaySeqFromWire(a.seq);
    const bs = relaySeqFromWire(b.seq);
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
  const records: RelayKeyLogEntry[] = [];
  let skipped = 0;
  let maxSeq = 0n;
  for (const row of sorted) {
    const seq = relaySeqFromWire(row.seq);
    if (seq > maxSeq) maxSeq = seq;
    try {
      records.push(await openRelayKeyLogRecord(key, row.blob));
    } catch {
      // 解不开就跳过这一条：中继上的密文由（可能已被攻陷的）同租户节点写入，不能让它堵死同步
      console.warn(stamp(`[relay] key-log blob undecryptable seq=${String(row.seq)}`));
      skipped += 1;
      break;
    }
  }
  return { records, skipped, maxSeq };
}
