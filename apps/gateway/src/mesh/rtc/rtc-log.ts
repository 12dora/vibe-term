import { AsyncLocalStorage } from 'node:async_hooks';
import { type LogLevel, logAt } from '../../log/level';
import { stamp } from '../mesh-log';
import { maskIceAddress, maskIceCandidate, parseIceCandidateType } from './ice';

export const RTC_LOG_PREFIX = '[mesh][rtc]';
export const RTC_LOG_CANDIDATE_INTERVAL_MS = 1_000;
export const RTC_DIAL_FAILED_LOG_INTERVAL_MS = 60_000;

const lastLogAt = new Map<string, number>();
const dialFailedAt = new Map<string, { at: number; suppressed: number }>();

export type IceTypeCountKey = 'host' | 'srflx' | 'prflx' | 'relay';
export type IceTypeCounts = Record<IceTypeCountKey, number>;

export type IceCandidateTrace = {
  local: Set<string>;
  remote: Set<string>;
  localCounts: IceTypeCounts;
  remoteCounts: IceTypeCounts;
};

export type RtcLogContext = {
  peer?: string;
  attempt?: string;
  epoch?: number;
};

const rtcLogContext = new AsyncLocalStorage<RtcLogContext>();

const TYPE_ORDER = ['host', 'srflx', 'prflx', 'relay'] as const;

export function emptyIceTypeCounts(): IceTypeCounts {
  return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}

export function createIceCandidateTrace(): IceCandidateTrace {
  return {
    local: new Set(),
    remote: new Set(),
    localCounts: emptyIceTypeCounts(),
    remoteCounts: emptyIceTypeCounts(),
  };
}

export function runWithRtcLogContext<T>(ctx: RtcLogContext, fn: () => T): T {
  return rtcLogContext.run(ctx, fn);
}

export function noteCandidate(
  trace: IceCandidateTrace,
  side: 'local' | 'remote',
  candidate: string
): string | null {
  const type = parseIceCandidateType(candidate);
  if (!type) return null;
  trace[side].add(type);
  if (type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay') {
    const counts = side === 'local' ? trace.localCounts : trace.remoteCounts;
    counts[type] += 1;
  }
  return type;
}

export function iceTypesOf(trace: IceCandidateTrace, side: 'local' | 'remote'): string[] {
  return TYPE_ORDER.filter((type) => trace[side].has(type));
}

export function formatRtcLog(event: string, fields: Record<string, unknown> = {}): string {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    bits.push(`${key}=${formatRtcField(value)}`);
  }
  return bits.length > 0
    ? `${RTC_LOG_PREFIX} ${event} ${bits.join(' ')}`
    : `${RTC_LOG_PREFIX} ${event}`;
}

const RTC_DEBUG_EVENTS = new Set<string>([
  'dial start',
  'signal send',
  'signal recv',
  'signal',
  'datachannel created',
  'datachannel received',
  'gathering',
  'selected pair',
  'upgrade retry',
  'dial race won',
]);

export function rtcLogLevel(event: string): LogLevel {
  return RTC_DEBUG_EVENTS.has(event) ? 'debug' : 'info';
}

function emitRtc(line: string, level: LogLevel): void {
  logAt(level, stamp(line));
}

function mergeRtcLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const ctx = rtcLogContext.getStore();
  if (!ctx) return fields;
  return { ...ctx, ...fields };
}

export function rtcLog(event: string, fields: Record<string, unknown> = {}): void {
  const merged = mergeRtcLogFields(fields);
  if (event === 'dial failed' && typeof merged.peer === 'string') {
    logDialFailed(merged.peer, merged);
    return;
  }
  emitRtc(formatRtcLog(event, merged), rtcLogLevel(event));
}

export function resetRtcLogStateForTest(): void {
  lastLogAt.clear();
  dialFailedAt.clear();
}

export function flushDialFailed(peer: string, fields: Record<string, unknown> = {}): void {
  const rec = dialFailedAt.get(peer);
  if (!rec || rec.suppressed <= 0) {
    dialFailedAt.delete(peer);
    return;
  }
  const count = rec.suppressed;
  dialFailedAt.delete(peer);
  emitRtc(formatRtcLog('dial failed', { peer, ...fields, count }), 'info');
}

function logDialFailed(peer: string, fields: Record<string, unknown>): void {
  const now = Date.now();
  const rec = dialFailedAt.get(peer) ?? { at: 0, suppressed: 0 };
  if (rec.at > 0 && now - rec.at < RTC_DIAL_FAILED_LOG_INTERVAL_MS) {
    rec.suppressed += 1;
    dialFailedAt.set(peer, rec);
    return;
  }
  const count = rec.suppressed + 1;
  rec.at = now;
  rec.suppressed = 0;
  dialFailedAt.set(peer, rec);
  emitRtc(formatRtcLog('dial failed', { ...fields, count }), 'info');
}

export function rtcLogRateLimited(
  key: string,
  event: string,
  fields: Record<string, unknown>,
  minIntervalMs = RTC_LOG_CANDIDATE_INTERVAL_MS
): void {
  const now = Date.now();
  const prev = lastLogAt.get(key) ?? 0;
  if (now - prev < minIntervalMs) return;
  lastLogAt.set(key, now);
  rtcLog(event, fields);
}

export function rtcLogIceFailed(peer: string, trace: IceCandidateTrace): void {
  rtcLog('ice failed', {
    peer,
    local_types: iceTypesOf(trace, 'local'),
    remote_types: iceTypesOf(trace, 'remote'),
  });
}

export function rtcLogCandidate(
  direction: 'send' | 'recv',
  peer: string,
  candidate: string,
  trace: IceCandidateTrace
): void {
  const side = direction === 'send' ? 'local' : 'remote';
  const type = noteCandidate(trace, side, candidate) ?? 'unknown';
  rtcLogRateLimited(`${peer}:${direction}:${type}`, 'signal', {
    peer,
    kind: 'candidate',
    dir: direction,
    candidate_type: type,
    addr: maskedCandidateAddr(candidate),
  });
}

function maskedCandidateAddr(candidate: string): string {
  const v4 = candidate.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (v4?.[0]) return maskIceAddress(v4[0]);
  const v6 = candidate.match(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i);
  if (v6?.[0]) return maskIceAddress(v6[0]);
  return maskIceCandidate(candidate);
}

function formatRtcField(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.join(',')}]`;
  return String(value);
}
