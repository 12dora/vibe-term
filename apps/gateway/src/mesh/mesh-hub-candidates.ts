import type { UplinkCandidate } from './uplink-pool';

export function serializeHubCandidate(entry: string | UplinkCandidate): {
  caMismatch?: { advertised: string; pinned: string };
  publicUrl: string;
  lastError: string | null;
  lastAttemptAt: number | null;
  rttMs: number | null;
  rttAt: number | null;
} {
  if (typeof entry === 'string') {
    return { publicUrl: entry, lastError: null, lastAttemptAt: null, rttMs: null, rttAt: null };
  }
  return {
    publicUrl: entry.publicUrl,
    ...(entry.caMismatch ? { caMismatch: entry.caMismatch } : {}),
    lastError: entry.lastError ?? null,
    lastAttemptAt: entry.lastAttemptAt ?? null,
    rttMs: entry.rttMs ?? null,
    rttAt: entry.rttAt ?? null,
  };
}
