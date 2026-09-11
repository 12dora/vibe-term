import { logAt } from '../../log/level';
import { stamp } from '../mesh-log';
import { parseTurnUri } from './ice';
import { formatRtcLog, rtcLog } from './rtc-log';
import {
  STUN_PROBE_INTERVAL_MS,
  STUN_PROBE_MIN_INTERVAL_MS,
  type StunProbeDeps,
  type StunProbeLoopDeps,
  type StunProbeResult,
  type StunProbeScheduler,
  probeStunServer,
} from './stun-probe';
import { stunListKey } from './stun-rank';
import { formatHostForIceUrl } from './stun-resolver';

export const TURN_PROBE_INTERVAL_MS = STUN_PROBE_INTERVAL_MS;
export const TURN_PROBE_MIN_INTERVAL_MS = STUN_PROBE_MIN_INTERVAL_MS;

export type TurnProbeResult = StunProbeResult;
export type TurnProbeRecord = TurnProbeResult & { probedAt: number };
export type TurnProbeLoopDeps = StunProbeLoopDeps;
export type TurnProbeHandle = { stop(after?: () => void): void };
export type TurnProbeRtc = {
  currentIceConfig(): { turn?: unknown; turnConfigured?: unknown };
};

type StunTarget = { hostname: string; port: number };
type ParseTurnProbe = StunTarget | 'unsupported' | null;

const ICE_SCHEME_RE = /^(stuns?|turns?):/i;

let session: MeshTurnProbe | null = null;
let loopDeps: TurnProbeLoopDeps = {};
let lastResults: TurnProbeRecord[] = [];

export function turnProbeSnapshot(): readonly TurnProbeRecord[] {
  return lastResults;
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

/** 从下发/本地 TURN 配置取出要探测的 URL（只取第一条）。 */
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

export function configuredTurnUrls(rtc: TurnProbeRtc): string[] {
  const ice = rtc.currentIceConfig();
  const configured = ice.turnConfigured !== undefined ? ice.turnConfigured : ice.turn;
  const url = turnUrlOf(configured);
  return url ? [url] : [];
}

export function startMeshTurnProbe(
  rtc: TurnProbeRtc,
  scheduler: StunProbeScheduler
): TurnProbeHandle {
  session?.stop();
  session = new MeshTurnProbe(rtc, scheduler, loopDeps);
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

class MeshTurnProbe {
  private lastKey: string | null = null;
  private lastCycleAt = 0;
  private inflight: Promise<void> | null = null;
  private queued: string[] | null = null;
  private pending: string[] | null = null;
  private tick: { clear: () => void } | null = null;
  private waitH: { clear: () => void } | null = null;
  private readonly ac = new AbortController();
  private stopped = false;
  private armed = false;

  constructor(
    private readonly rtc: TurnProbeRtc,
    private readonly scheduler: StunProbeScheduler,
    private readonly opts: TurnProbeLoopDeps
  ) {}

  start(): void {
    void this.runCycle(configuredTurnUrls(this.rtc));
    this.armTick();
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
    this.tick?.clear();
    this.waitH?.clear();
    this.tick = this.waitH = null;
    this.queued = this.pending = null;
  }

  sync(rtc: TurnProbeRtc): void {
    const urls = configuredTurnUrls(rtc);
    if (stunListKey(urls) === this.lastKey) return;
    const min = this.opts.minIntervalMs ?? TURN_PROBE_MIN_INTERVAL_MS;
    const elapsed = (this.opts.now ?? Date.now)() - this.lastCycleAt;
    if (this.lastCycleAt > 0 && elapsed < min) {
      this.armWait(urls, min - elapsed);
      return;
    }
    void this.runCycle(urls);
  }

  private armTick(): void {
    if (this.stopped || this.armed) return;
    this.armed = true;
    const rand = this.opts.random ?? Math.random;
    const ms = Math.round(TURN_PROBE_INTERVAL_MS * (1 + (rand() * 2 - 1) * 0.1));
    this.tick = this.scheduler.interval(() => {
      if (!this.stopped) void this.runCycle(configuredTurnUrls(this.rtc));
    }, ms);
  }

  private armWait(urls: string[], ms: number): void {
    if (this.stopped) return;
    this.pending = urls;
    this.waitH?.clear();
    this.waitH = this.scheduler.interval(() => {
      this.waitH?.clear();
      this.waitH = null;
      const next = this.pending ?? configuredTurnUrls(this.rtc);
      this.pending = null;
      if (!this.stopped && stunListKey(next) !== this.lastKey) void this.runCycle(next);
    }, ms);
  }

  private runCycle(urls: string[]): Promise<void> {
    if (this.inflight) {
      this.queued = urls;
      return this.inflight;
    }
    this.inflight = this.loop(urls)
      .catch(() => {})
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async loop(urls: string[]): Promise<void> {
    let current = urls;
    const clock = this.opts.now ?? Date.now;
    const probeAll =
      this.opts.probeAll ??
      ((list: readonly string[]) =>
        Promise.all(
          list.map((url) => probeTurnServer(url, { signal: this.ac.signal, now: this.opts.now }))
        ));
    for (;;) {
      if (this.stopped || this.ac.signal.aborted) return;
      this.lastKey = stunListKey(current);
      this.lastCycleAt = clock();
      if (process.env.NODE_ENV === 'test' && !this.opts.probeAll) return;
      let results: TurnProbeResult[];
      try {
        results = await probeAll(current);
      } catch {
        results = current.map((url) => ({ url, ok: false, rttMs: 0, error: 'error' }));
      }
      if (this.stopped) return;
      lastResults = results.map((row) => ({ ...row, probedAt: clock() }));
      try {
        logTurnProbeBatch(lastResults);
      } catch {}
      if (!this.queued) break;
      current = this.queued;
      this.queued = null;
      if (stunListKey(current) === this.lastKey) break;
      const min = this.opts.minIntervalMs ?? TURN_PROBE_MIN_INTERVAL_MS;
      const wait = min - (clock() - this.lastCycleAt);
      if (wait > 0) {
        this.armWait(current, wait);
        break;
      }
    }
  }
}

function nonempty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  for (const row of results) {
    rtcLog('turn probe', {
      url: row.url,
      skipped: row.skipped,
      ok: row.skipped ? undefined : row.ok,
      rtt_ms: row.ok ? row.rttMs : undefined,
      error: row.ok || row.skipped ? undefined : (row.error ?? 'error'),
      via: row.skipped ? undefined : row.via,
      fake_ip: row.skipped ? undefined : row.fakeIp,
    });
  }
  const attempted = results.filter((row) => !row.skipped);
  if (attempted.length > 0 && attempted.every((row) => !row.ok)) {
    logAt(
      'warn',
      stamp(formatRtcLog('turn unreachable', { url: attempted[0]?.url, all: attempted.length }))
    );
  }
}
