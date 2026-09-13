import { canonicalHubUrl } from '@vibeterm/shared/auth';
import { normalizeTurnOk } from '@vibeterm/shared/relay';

export const TURN_REPORT_TTL_MS = 30 * 60 * 1_000;

export type MembersProbeSnapshot = { ok: number; total: number; updatedAt: number };

type TurnReport = { ok: boolean; at: number };

const turnReports = new Map<string, Map<string, TurnReport>>();
let nowFn: () => number = Date.now;

export function resetTurnReachForTest(now?: () => number): void {
  turnReports.clear();
  nowFn = now ?? Date.now;
}

export function setTurnReachNow(now: () => number): void {
  nowFn = now;
}

/** `relayKey` 是这份 list 来自哪条中继的规范 URL；缺席或无法归一化则丢弃。 */
export function ingestTurnOk(reporterId: string, turnOk: unknown, relayKey: string): void {
  const ok = normalizeTurnOk(turnOk);
  if (ok === undefined) return;
  const key = turnRelayKey(relayKey);
  if (!key) return;
  let bucket = turnReports.get(key);
  if (!bucket) {
    bucket = new Map();
    turnReports.set(key, bucket);
  }
  bucket.set(reporterId, { ok, at: nowFn() });
}

export function membersProbeSnapshot(
  relayKey?: string,
  opts?: { excludeId?: string }
): MembersProbeSnapshot | null {
  const freshAfter = nowFn() - TURN_REPORT_TTL_MS;
  const buckets = turnReportBuckets(relayKey);
  let ok = 0;
  let total = 0;
  let updatedAt = 0;
  const excludeId = opts?.excludeId;
  for (const [key, bucket] of buckets) {
    for (const [reporterId, row] of bucket) {
      if (row.at < freshAfter) {
        bucket.delete(reporterId);
        continue;
      }
      if (excludeId && reporterId === excludeId) continue;
      total += 1;
      if (row.ok) ok += 1;
      if (row.at > updatedAt) updatedAt = row.at;
    }
    if (bucket.size === 0) turnReports.delete(key);
  }
  if (total === 0) return null;
  return { ok, total, updatedAt };
}

function turnRelayKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return canonicalHubUrl(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function turnReportBuckets(relayKey?: string): Array<[string, Map<string, TurnReport>]> {
  if (relayKey === undefined) return [...turnReports.entries()];
  const key = turnRelayKey(relayKey);
  if (!key) return [];
  const bucket = turnReports.get(key);
  return bucket ? [[key, bucket]] : [];
}
