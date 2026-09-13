import type { RelayTurnConfig } from '@vibeterm/shared/relay';
import { logAt } from '../../log/level';
import { stamp } from '../mesh-log';
import { parseTurnUri } from './ice';
import { configuredTurnUrls, flattenTurnConfigs } from './turn-config';

export { configuredTurnUrls, flattenTurnConfigs } from './turn-config';
import {
  MeshProbeLoop,
  type ProbeLoopDeps,
  type ProbeScheduler,
  failedAttemptedProbes,
} from './probe-loop';
import { formatRtcLog, rtcLog } from './rtc-log';
import {
  STUN_PROBE_INTERVAL_MS,
  STUN_PROBE_MIN_INTERVAL_MS,
  type StunProbeDeps,
  type StunProbeResult,
  probeStunServer,
} from './stun-probe';
import { formatHostForIceUrl } from './stun-resolver';

export const TURN_PROBE_INTERVAL_MS = STUN_PROBE_INTERVAL_MS;
export const TURN_PROBE_MIN_INTERVAL_MS = STUN_PROBE_MIN_INTERVAL_MS;
export const TURN_PROBE_CONCURRENCY = 2;

export type TurnProbeResult = StunProbeResult;
export type TurnProbeRecord = TurnProbeResult & { probedAt: number };
export type TurnProbeLoopDeps = ProbeLoopDeps<TurnProbeResult>;
export type TurnProbeHandle = { stop(after?: () => void): void };
export type TurnProbeRtc = {
  currentIceConfig(): { turn?: unknown; turnConfigured?: unknown };
};

type StunTarget = { hostname: string; port: number };
type ParseTurnProbe = StunTarget | 'unsupported' | null;

const ICE_SCHEME_RE = /^(stuns?|turns?):/i;

let session: MeshProbeLoop<TurnProbeRtc, TurnProbeResult> | null = null;
let loopDeps: TurnProbeLoopDeps = {};
let lastResults: TurnProbeRecord[] = [];

export function turnProbeSnapshot(): readonly TurnProbeRecord[] {
  return lastResults;
}

/** 每个 URL 取最后一条探测（含 ok / rttMs）。 */
export function turnProbeByUrl(
  probes: readonly TurnProbeRecord[] = lastResults
): Map<string, TurnProbeRecord> {
  const map = new Map<string, TurnProbeRecord>();
  for (const row of probes) map.set(row.url, row);
  return map;
}

export function latestTurnProbe(): TurnProbeRecord | null {
  return lastResults[lastResults.length - 1] ?? null;
}

export function resetTurnProbeForTest(): void {
  session?.stop();
  session = null;
  loopDeps = {};
  lastResults = [];
}

export function setTurnProbeLoopForTest(deps: TurnProbeLoopDeps): void {
  loopDeps = deps;
}

export function setTurnProbeSnapshotForTest(rows: readonly TurnProbeRecord[]): void {
  lastResults = rows.map((row) => ({ ...row }));
}

/** 从下发/本地 TURN 配置取出要探测的 URL（只取第一条，兼容旧调用）。 */
export function turnUrlOf(turn: unknown): string | null {
  if (typeof turn === 'string') return nonempty(turn);
  if (Array.isArray(turn)) return firstTurnUrl(turn);
  if (typeof turn !== 'object' || turn === null) return null;
  return turnUrlFromRecord(turn as Record<string, unknown>);
}

export function parseTurnProbeTarget(url: string): StunTarget | null {
  const parsed = parseTurnProbe(url);
  return parsed === 'unsupported' ? null : parsed;
}

/**
 * 向 TURN 的 host:port 发 STUN Binding（RFC 5389）。coturn 会应答 Binding，
 * 这只证明 UDP 可达，不能代替带凭证的 Allocate。
 */
export async function probeTurnServer(
  url: string,
  deps: StunProbeDeps = {}
): Promise<TurnProbeResult> {
  const parsed = parseTurnProbe(url);
  if (parsed === 'unsupported') {
    return { url, ok: false, rttMs: 0, skipped: 'unsupported-scheme' };
  }
  if (!parsed) return { url, ok: false, rttMs: 0, error: 'url' };
  const result = await probeStunServer(
    `stun:${formatHostForIceUrl(parsed.hostname)}:${parsed.port}`,
    deps
  );
  return { ...result, url };
}

export async function probeTurnServers(
  urls: readonly string[],
  deps: StunProbeDeps = {}
): Promise<TurnProbeResult[]> {
  const out: TurnProbeResult[] = [];
  for (let i = 0; i < urls.length; i += TURN_PROBE_CONCURRENCY) {
    const chunk = urls.slice(i, i + TURN_PROBE_CONCURRENCY);
    out.push(...(await Promise.all(chunk.map((url) => probeTurnServer(url, deps)))));
  }
  return out;
}

function rtcTurnConfig(rtc: TurnProbeRtc): unknown {
  const ice = rtc.currentIceConfig();
  return ice.turnConfigured !== undefined ? ice.turnConfigured : ice.turn;
}

export function startMeshTurnProbe(rtc: TurnProbeRtc, scheduler: ProbeScheduler): TurnProbeHandle {
  session?.stop();
  session = new MeshProbeLoop(rtc, scheduler, loopDeps, {
    intervalMs: TURN_PROBE_INTERVAL_MS,
    defaultMinIntervalMs: TURN_PROBE_MIN_INTERVAL_MS,
    urlsOf: (target) => configuredTurnUrls(rtcTurnConfig(target)),
    defaultProbeAll: (list, signal, now) => probeTurnServers(list, { signal, now }),
    applyResults: (records) => {
      lastResults = mergeLatestByUrl(lastResults, records);
    },
    logBatch: logTurnProbeBatch,
  });
  session.start();
  return { stop: (after) => stopMeshTurnProbe(after) };
}

export function stopMeshTurnProbe(after?: () => void): void {
  session?.stop();
  after?.();
}

export function syncTurnProbe(rtc: TurnProbeRtc): void {
  session?.sync(rtc);
}

function nonempty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeLatestByUrl(
  prev: readonly TurnProbeRecord[],
  next: readonly TurnProbeRecord[]
): TurnProbeRecord[] {
  const map = new Map<string, TurnProbeRecord>();
  for (const row of prev) map.set(row.url, row);
  for (const row of next) map.set(row.url, row);
  return [...map.values()];
}

function firstTurnUrl(items: readonly unknown[]): string | null {
  for (const item of items) {
    const url = turnUrlOf(item);
    if (url) return url;
  }
  return null;
}

function firstStringUrl(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (typeof item === 'string') {
      const url = nonempty(item);
      if (url) return url;
    }
  }
  return null;
}

function turnUrlFromRecord(rec: Record<string, unknown>): string | null {
  if (typeof rec.url === 'string') {
    const url = nonempty(rec.url);
    if (url) return url;
  }
  if (typeof rec.urls === 'string') return nonempty(rec.urls);
  if (Array.isArray(rec.urls)) return firstStringUrl(rec.urls);
  return hostnameTurnUrl(rec);
}

function hostnameTurnUrl(rec: Record<string, unknown>): string | null {
  if (typeof rec.hostname !== 'string' || rec.hostname.length === 0) return null;
  const port = typeof rec.port === 'number' && Number.isFinite(rec.port) ? rec.port : 3478;
  const scheme = rec.relayType === 'TurnTls' ? 'turns' : 'turn';
  const host = formatHostForIceUrl(rec.hostname);
  const transport = rec.relayType === 'TurnTcp' ? '?transport=tcp' : '';
  return `${scheme}:${host}:${port}${transport}`;
}

function parseTurnProbe(url: string): ParseTurnProbe {
  const trimmed = url.trim();
  const scheme = ICE_SCHEME_RE.exec(trimmed)?.[0]?.toLowerCase();
  if (!scheme) return null;
  if (scheme !== 'turn:') return 'unsupported';
  const parsed = parseTurnUri(trimmed);
  if (!parsed?.hostname || !Number.isFinite(parsed.port) || parsed.port <= 0) return null;
  if (parsed.relayType !== 'TurnUdp') return 'unsupported';
  return { hostname: parsed.hostname, port: parsed.port };
}

function logTurnProbeBatch(results: readonly TurnProbeRecord[]): void {
  for (const row of results) rtcLog('turn probe', turnProbeLogFields(row));
  const failed = failedAttemptedProbes(results);
  if (!failed) return;
  logAt(
    'warn',
    stamp(formatRtcLog('turn unreachable', { url: failed[0]?.url, all: failed.length }))
  );
}

function turnProbeLogFields(row: TurnProbeRecord): Record<string, unknown> {
  const skipped = Boolean(row.skipped);
  return {
    url: row.url,
    skipped: row.skipped,
    ok: skipped ? undefined : row.ok,
    rtt_ms: row.ok ? row.rttMs : undefined,
    error: row.ok || skipped ? undefined : (row.error ?? 'error'),
    via: skipped ? undefined : row.via,
    fake_ip: skipped ? undefined : row.fakeIp,
  };
}
