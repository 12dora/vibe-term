import { logAt } from '../../log/level';
import { stamp } from '../mesh-log';
import { maskIceAddress } from './ice';
import { failedAttemptedProbes } from './probe-loop';
import { formatRtcLog, rtcLog } from './rtc-log';
import type { StunProbeRecord } from './stun-probe-types';

export function logStunProbeBatch(results: readonly StunProbeRecord[]): void {
  for (const row of results) rtcLog('stun probe', stunProbeLogFields(row));
  const failed = failedAttemptedProbes(results);
  if (!failed) return;
  logAt('warn', stamp(formatRtcLog('stun unreachable', { all: failed.length })));
}

function stunProbeLogFields(row: StunProbeRecord): Record<string, unknown> {
  const skipped = Boolean(row.skipped);
  return {
    url: row.url,
    skipped: row.skipped,
    ok: skipped ? undefined : row.ok,
    rtt_ms: row.ok ? row.rttMs : undefined,
    mapped: row.mappedAddress ? maskIceAddress(row.mappedAddress) : undefined,
    error_response: row.errorResponse || undefined,
    error: row.ok || skipped ? undefined : (row.error ?? 'error'),
    via: skipped ? undefined : row.via,
    fake_ip: skipped ? undefined : row.fakeIp,
  };
}
