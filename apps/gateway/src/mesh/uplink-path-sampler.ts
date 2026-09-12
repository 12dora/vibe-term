import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { classifyRemoteAddress, hostFromWsUrl } from './address-class';
import { backoffDelayMs } from './ctl';
import { stamp } from './mesh-log';
import { PeerPathRttMemory } from './peer-path-rtt';
import { PORT_PROBE_DEADLINE_MS, type TcpProbeResult, probeTcpConnect } from './port-reach-probe';
import { RelayUplinkHeartbeat } from './relay-uplink-heartbeat';
import type { MeshScheduler } from './types';
import {
  UPLINK_DEGRADE_MAX_PER_HOUR,
  UPLINK_DEGRADE_RESULT_SAMPLES,
  type UplinkReraceBudget,
  decideUplinkDegrade,
  isUplinkHeartbeatSlow,
  uplinkReraceBudgetInWindow,
} from './uplink-degrade-policy';

export const UPLINK_PATH_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const UPLINK_PATH_SAMPLE_CONNECTS = 3;
export const UPLINK_PATH_RTT_TTL_MS = 30 * 60 * 1000;
export const UPLINK_PATH_RERACE_REASON = 'path-rerace';

export type UplinkPathProbeFn = (
  host: string,
  port: number,
  deadlineMs?: number
) => Promise<TcpProbeResult>;

export type UplinkHeartbeatSample = {
  url: string;
  rttMs: number;
  linkAgeMs: number;
  inFlightStreams: number;
  now: number;
  /** 每条上行连接一份，primary / secondary 同 host 也不能串台。 */
  clientId: string;
  /** 重赛时记下当前代；只有更大 generation 的心跳才结算 re-race_result。 */
  generation: number;
};

export type UplinkPathSamplerOptions = {
  scheduler: MeshScheduler;
  targets: () => readonly string[];
  probe?: UplinkPathProbeFn;
  intervalMs?: number;
  connects?: number;
  log?: (line: string) => void;
};

type PendingResult = { oldMs: number; samples: number; clientId: string; generation: number };

type HostWatch = {
  consecutiveSlow: number;
  lastReraceAt: number | null;
  reraces: UplinkReraceBudget;
  pending: PendingResult | null;
};

function roundMs(ms: number): number {
  return Math.round(ms);
}

export function uplinkPathSamplingEnabled(): boolean {
  return process.env.VIBETERM_UPLINK_PATH_SAMPLING?.trim().toLowerCase() !== 'off';
}

export function isUplinkPathRerace(reason: string | null | undefined): boolean {
  return reason === UPLINK_PATH_RERACE_REASON;
}

export function uplinkPathHostKey(url: string): string | null {
  return hostFromWsUrl(url);
}

export function uplinkTcpTarget(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!host) return null;
    if (classifyRemoteAddress(host) === 'lan') return null;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === 'http:' || parsed.protocol === 'ws:'
        ? 80
        : 443;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host, port };
  } catch {
    return null;
  }
}

export async function sleepAfterUplinkSession(
  scheduler: MeshScheduler,
  signal: AbortSignal,
  closeReason: string | null | undefined
): Promise<'ok' | 'stop'> {
  if (signal.aborted) return 'stop';
  if (isUplinkPathRerace(closeReason)) return 'ok';
  const delay = backoffDelayMs(0, 1_000, 60_000);
  try {
    await scheduler.sleep(delay, signal);
    return 'ok';
  } catch {
    return 'stop';
  }
}

export class UplinkPathSampler {
  readonly memory: PeerPathRttMemory;
  private readonly scheduler: MeshScheduler;
  private readonly targets: () => readonly string[];
  private readonly probe: UplinkPathProbeFn;
  private readonly intervalMs: number;
  private readonly connects: number;
  private readonly log: (line: string) => void;
  private readonly watch = new Map<string, HostWatch>();
  private timer: { clear: () => void } | null = null;
  private sampling = false;

  constructor(opts: UplinkPathSamplerOptions) {
    this.scheduler = opts.scheduler;
    this.targets = opts.targets;
    this.probe = opts.probe ?? probeTcpConnect;
    this.intervalMs = opts.intervalMs ?? UPLINK_PATH_SAMPLE_INTERVAL_MS;
    this.connects = opts.connects ?? UPLINK_PATH_SAMPLE_CONNECTS;
    this.log = opts.log ?? ((line) => console.info(stamp(line)));
    this.memory = new PeerPathRttMemory({
      now: () => this.scheduler.now(),
      ttlMs: UPLINK_PATH_RTT_TTL_MS,
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.scheduler.interval(() => {
      void this.sampleAll();
    }, this.intervalMs);
    void this.sampleAll();
  }

  stop(): void {
    this.timer?.clear();
    this.timer = null;
  }

  bestMs(hostOrUrl: string): number | null {
    const host = uplinkPathHostKey(hostOrUrl) ?? hostOrUrl;
    return this.memory.bestMs(host);
  }

  reraceCount(hostOrUrl: string): number {
    const host = uplinkPathHostKey(hostOrUrl) ?? hostOrUrl;
    const row = this.watch.get(host);
    if (!row) return 0;
    return uplinkReraceBudgetInWindow(row.reraces, this.scheduler.now()).count;
  }

  pathView(url: string): { pathBestMs?: number; reraces?: number } {
    const best = this.bestMs(url);
    const reraces = this.reraceCount(url);
    return {
      ...(best != null ? { pathBestMs: roundMs(best) } : {}),
      ...(reraces > 0 ? { reraces } : {}),
    };
  }

  /**
   * 先用已有参考判定是否劣化，再把本次心跳写入 `ws-secure`，避免当前样本把自己变成 best。
   * 返回 true 表示调用方应立刻以 `path-rerace` 关掉活链路。
   */
  onHeartbeat(sample: UplinkHeartbeatSample): boolean {
    const host = uplinkPathHostKey(sample.url);
    if (!host) return false;
    this.settlePending(host, sample);
    const watch = this.watchOf(host, sample.now);
    const bestKnownMs = this.memory.bestMs(host);
    if (bestKnownMs != null && isUplinkHeartbeatSlow(sample.rttMs, bestKnownMs)) {
      watch.consecutiveSlow += 1;
    } else {
      watch.consecutiveSlow = 0;
    }
    const decision = decideUplinkDegrade({
      heartbeatRttMs: sample.rttMs,
      consecutiveSlow: watch.consecutiveSlow,
      bestKnownMs,
      linkAgeMs: sample.linkAgeMs,
      inFlightStreams: sample.inFlightStreams,
      lastReraceAt: watch.lastReraceAt,
      reraces: watch.reraces,
      now: sample.now,
    });
    this.memory.record(host, { kind: 'ws-secure', rttMs: sample.rttMs, at: sample.now });
    if (!decision.rerace) return false;
    const budget = uplinkReraceBudgetInWindow(watch.reraces, sample.now);
    budget.count += 1;
    watch.reraces = budget;
    watch.lastReraceAt = sample.now;
    watch.consecutiveSlow = 0;
    watch.pending = {
      oldMs: decision.currentMs,
      samples: 0,
      clientId: sample.clientId,
      generation: sample.generation,
    };
    this.log(
      `[uplink] path re-race url=${host} cur_ms=${roundMs(decision.currentMs)} best_ms=${roundMs(decision.bestMs)} try=${budget.count}/${UPLINK_DEGRADE_MAX_PER_HOUR}`
    );
    return true;
  }

  async sampleAll(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const seen = new Set<string>();
      for (const url of this.targets()) {
        const target = uplinkTcpTarget(url);
        if (!target || seen.has(target.host)) continue;
        seen.add(target.host);
        await this.sampleHost(target.host, target.port);
      }
      this.memory.prune();
    } finally {
      this.sampling = false;
    }
  }

  private async sampleHost(host: string, port: number): Promise<void> {
    const results = await Promise.all(
      Array.from({ length: this.connects }, () =>
        this.probe(host, port, PORT_PROBE_DEADLINE_MS).catch(
          (): TcpProbeResult => ({ verdict: 'timeout', connectMs: null })
        )
      )
    );
    const at = this.scheduler.now();
    for (const result of results) {
      if (result.verdict === 'ok' && result.connectMs != null) {
        this.memory.record(host, { kind: 'tcp-connect', rttMs: result.connectMs, at });
      }
    }
  }

  private watchOf(host: string, now: number): HostWatch {
    const prev = this.watch.get(host);
    if (!prev) {
      const fresh: HostWatch = {
        consecutiveSlow: 0,
        lastReraceAt: null,
        reraces: { count: 0, windowStartedAt: now },
        pending: null,
      };
      this.watch.set(host, fresh);
      return fresh;
    }
    prev.reraces = uplinkReraceBudgetInWindow(prev.reraces, now);
    return prev;
  }

  private settlePending(host: string, sample: UplinkHeartbeatSample): void {
    const watch = this.watch.get(host);
    const pending = watch?.pending;
    if (!pending) return;
    if (pending.clientId !== sample.clientId) return;
    if (sample.generation <= pending.generation) return;
    pending.samples += 1;
    if (pending.samples < UPLINK_DEGRADE_RESULT_SAMPLES) return;
    const oldMs = pending.oldMs;
    watch.pending = null;
    this.log(
      `[uplink] path re-race_result url=${host} old_ms=${roundMs(oldMs)} new_ms=${roundMs(sample.rttMs)} better=${sample.rttMs < oldMs}`
    );
  }
}

let active: UplinkPathSampler | null = null;

export function activeUplinkPathSampler(): UplinkPathSampler | null {
  return active;
}

export function startUplinkPathSampling(opts: UplinkPathSamplerOptions): UplinkPathSampler | null {
  stopUplinkPathSampling();
  if (!uplinkPathSamplingEnabled()) return null;
  active = new UplinkPathSampler(opts);
  active.start();
  return active;
}

export function collectUplinkPathTargets(
  candidates: ReadonlyArray<{ publicUrl: string }>,
  relayRows: ReadonlyArray<{ url: string }>
): string[] {
  return [...relayRows.map((row) => row.url), ...candidates.map((row) => row.publicUrl)];
}

export function startUplinkPathSamplingFromCandidates(
  scheduler: MeshScheduler,
  hub: { candidates(): ReadonlyArray<{ publicUrl: string }> },
  relay?: { secrets: { relayRows(): ReadonlyArray<{ url: string }> } }
): UplinkPathSampler | null {
  return startUplinkPathSampling({
    scheduler,
    targets: () => collectUplinkPathTargets(hub.candidates(), relay?.secrets.relayRows() ?? []),
  });
}

export function stopUplinkPathSampling(): void {
  active?.stop();
  active = null;
}

export function considerUplinkPathRerace(sample: UplinkHeartbeatSample): boolean {
  if (!uplinkPathSamplingEnabled()) return false;
  return active?.onHeartbeat(sample) === true;
}

export function noteUplinkHeartbeatAndRerace(
  sample: UplinkHeartbeatSample,
  tearDown: (reason: string) => void
): void {
  if (considerUplinkPathRerace(sample)) {
    tearDown(UPLINK_PATH_RERACE_REASON);
  }
}

export function uplinkPathView(url: string): { pathBestMs?: number; reraces?: number } {
  return active?.pathView(url) ?? {};
}

export function resetUplinkPathSamplerForTest(): void {
  stopUplinkPathSampling();
}

export function trackCountedStream<T extends { closed: Promise<unknown> }>(
  set: Set<T>,
  stream: T
): T {
  if (set.has(stream)) return stream;
  set.add(stream);
  const drop = () => set.delete(stream);
  void stream.closed.then(drop, drop);
  return stream;
}

type CountedStream = { closed: Promise<unknown>; reset(reason?: string): void };

/** 已建立流 + 正在 openStream 的计数；重赛 in-flight 门用 established + pending。 */
export class UplinkStreamGate<T extends CountedStream = LinkStream> {
  readonly streams = new Set<T>();
  pendingOpen = 0;

  count(pendingKeyLog = 0): number {
    return this.streams.size + this.pendingOpen + pendingKeyLog;
  }

  track(stream: T): T {
    return trackCountedStream(this.streams, stream);
  }

  async open(start: () => Promise<T>, accept?: () => boolean): Promise<T> {
    this.pendingOpen += 1;
    try {
      const stream = await start();
      if (accept && !accept()) {
        stream.reset('uplink-retiring');
        throw new Error('uplink is not online');
      }
      return this.track(stream);
    } finally {
      this.pendingOpen -= 1;
    }
  }
}

let pathClientSeq = 0;

export function createUplinkPathHeartbeat(input: {
  scheduler: MeshScheduler;
  intervalMs: number;
  sendPing: (link: LinkSession) => void;
  tearDown: (reason: string) => void;
  onTick?: () => void;
  onSample?: (rttMs: number) => void;
  url: () => string;
  linkAgeMs: () => number;
  inFlight: () => number;
  generation: () => number;
}): RelayUplinkHeartbeat {
  const clientId = `uplink:${++pathClientSeq}`;
  return new RelayUplinkHeartbeat({
    scheduler: input.scheduler,
    intervalMs: input.intervalMs,
    missedLimit: 3,
    sendPing: input.sendPing,
    onTimeout: input.tearDown,
    onTick: input.onTick,
    onRtt: (rttMs) => {
      input.onSample?.(rttMs);
      noteUplinkHeartbeatAndRerace(
        {
          url: input.url(),
          rttMs,
          linkAgeMs: input.linkAgeMs(),
          inFlightStreams: input.inFlight(),
          now: input.scheduler.now(),
          clientId,
          generation: input.generation(),
        },
        input.tearDown
      );
    },
  });
}
