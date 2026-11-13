import type { LinkSession } from '@vibeterm/shared/link';
import type { RelayUsageDelta } from './relay-metering';
import type { RelayRegistry } from './relay-registry';

export type MuxCounters = {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  openStreams: number;
  unacked: number;
};

export type TenantByteRates = {
  bytesInPerSec: number;
  bytesOutPerSec: number;
  bandwidthBytesPerSec: number;
};

export type LiveCounters = {
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
  membersOnline: number;
  activeStreams: number;
  admitted: number;
  tenantBytes: Map<string, RelayUsageDelta>;
  tenantAdmitted: Map<string, number>;
  memberBytes: Map<string, RelayUsageDelta>;
};

export type RateSnapshot = {
  bytesInPerSec: number;
  bytesOutPerSec: number;
  framesInPerSec: number;
  framesOutPerSec: number;
  bandwidthBytesPerSec: number;
  tenants: Map<string, TenantByteRates>;
  members: Map<string, { bytesInPerSec: number; bytesOutPerSec: number }>;
  cpuUtilizationPct: number | null;
};

export const EMPTY_MUX: MuxCounters = {
  framesIn: 0,
  framesOut: 0,
  bytesIn: 0,
  bytesOut: 0,
  openStreams: 0,
  unacked: 0,
};

export const EMPTY_RATES: RateSnapshot = {
  bytesInPerSec: 0,
  bytesOutPerSec: 0,
  framesInPerSec: 0,
  framesOutPerSec: 0,
  bandwidthBytesPerSec: 0,
  tenants: new Map(),
  members: new Map(),
  cpuUtilizationPct: null,
};

export function perSec(delta: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.max(0, delta) / (elapsedMs / 1000);
}

export function counterDelta(curr: number, prev: number): number {
  return curr < prev ? curr : curr - prev;
}

export function cpuUtilizationPct(
  prev: NodeJS.CpuUsage,
  next: NodeJS.CpuUsage,
  elapsedMs: number
): number | null {
  if (elapsedMs <= 0) return null;
  const micros = Math.max(0, next.user - prev.user) + Math.max(0, next.system - prev.system);
  return (micros / (elapsedMs * 1000)) * 100;
}

export function asLoadAvg(values: number[]): [number, number, number] | null {
  if (values.length < 3) return null;
  const a = values[0] ?? 0;
  const b = values[1] ?? 0;
  const c = values[2] ?? 0;
  if (a === 0 && b === 0 && c === 0) return null;
  return [a, b, c];
}

export function muxStatsOf(link: LinkSession): MuxCounters {
  const direct = (link as { stats?: () => MuxCounters }).stats;
  if (typeof direct === 'function') return direct.call(link);
  return EMPTY_MUX;
}

export function aggregateMux(registry: RelayRegistry, retired: MuxCounters): MuxCounters {
  const total = {
    framesIn: retired.framesIn,
    framesOut: retired.framesOut,
    bytesIn: retired.bytesIn,
    bytesOut: retired.bytesOut,
    openStreams: 0,
    unacked: 0,
  };
  for (const live of registry.all()) {
    const stats = muxStatsOf(live.link);
    total.framesIn += stats.framesIn;
    total.framesOut += stats.framesOut;
    total.bytesIn += stats.bytesIn;
    total.bytesOut += stats.bytesOut;
    total.openStreams += stats.openStreams;
    total.unacked += stats.unacked;
  }
  return total;
}

export function rateMap(
  current: Map<string, RelayUsageDelta>,
  previous: Map<string, RelayUsageDelta>,
  admitted: Map<string, number>,
  prevAdmitted: Map<string, number>,
  elapsedMs: number
): Map<string, TenantByteRates> {
  const out = new Map<string, TenantByteRates>();
  const keys = new Set([...current.keys(), ...admitted.keys()]);
  for (const key of keys) {
    const curr = current.get(key);
    const prev = previous.get(key);
    out.set(key, {
      bytesInPerSec: perSec(counterDelta(curr?.bytesIn ?? 0, prev?.bytesIn ?? 0), elapsedMs),
      bytesOutPerSec: perSec(counterDelta(curr?.bytesOut ?? 0, prev?.bytesOut ?? 0), elapsedMs),
      bandwidthBytesPerSec: perSec(
        counterDelta(admitted.get(key) ?? 0, prevAdmitted.get(key) ?? 0),
        elapsedMs
      ),
    });
  }
  return out;
}

export function memberRateMap(
  current: Map<string, RelayUsageDelta>,
  previous: Map<string, RelayUsageDelta>,
  elapsedMs: number
): Map<string, { bytesInPerSec: number; bytesOutPerSec: number }> {
  const out = new Map<string, { bytesInPerSec: number; bytesOutPerSec: number }>();
  for (const [key, curr] of current) {
    const prev = previous.get(key);
    out.set(key, {
      bytesInPerSec: perSec(counterDelta(curr.bytesIn, prev?.bytesIn ?? 0), elapsedMs),
      bytesOutPerSec: perSec(counterDelta(curr.bytesOut, prev?.bytesOut ?? 0), elapsedMs),
    });
  }
  return out;
}
