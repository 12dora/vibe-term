import { MeshProbeLoop, type ProbeLoopDeps, type ProbeScheduler } from './probe-loop';
export { STUN_PROBE_MIN_BIND_MS } from './stun-probe-budget';
export {
  STUN_MAGIC_COOKIE,
  encodeBindingRequest,
  parseStunMappedAddress,
  parseStunTarget,
} from './stun-probe-codec';
export {
  STUN_PROBE_CONCURRENCY,
  STUN_PROBE_RTO_MS,
  STUN_PROBE_TIMEOUT_MS,
  probeStunServer,
  probeStunServers,
} from './stun-probe-exchange';
import { probeStunServers } from './stun-probe-exchange';
export type {
  StunProbeDeps,
  StunProbeRecord,
  StunProbeResult,
  StunRinfo,
  StunUdpSocket,
} from './stun-probe-types';
import { logStunProbeBatch } from './stun-probe-report';
import type { StunProbeRecord, StunProbeResult } from './stun-probe-types';
export { rankStunByProbes } from './stun-rank';

export const STUN_PROBE_INTERVAL_MS = 10 * 60 * 1_000;
export const STUN_PROBE_MIN_INTERVAL_MS = 30_000;

export type StunProbeRtc = { currentIceConfig(): { stun: string[] } };
export type StunProbeScheduler = ProbeScheduler;
export type StunProbeLoopDeps = ProbeLoopDeps<StunProbeResult>;
export type StunProbeHandle = { stop(after?: () => void): void };

let session: MeshProbeLoop<StunProbeRtc, StunProbeResult> | null = null;
let loopDeps: StunProbeLoopDeps = {};

export function stunProbeSnapshot(): readonly StunProbeRecord[] {
  return session?.lastResults ?? [];
}

export function resetStunProbeForTest(): void {
  session?.stop();
  session = null;
  loopDeps = {};
}

export function setStunProbeLoopForTest(deps: StunProbeLoopDeps): void {
  loopDeps = deps;
}

export function withStunProbes<T extends { stun: string[]; turn: unknown } | null>(
  cfg: T
): { stun: string[]; turn: unknown; probes: StunProbeRecord[] } {
  const base = cfg ?? { stun: [], turn: null };
  return { stun: base.stun, turn: base.turn, probes: stunProbeSnapshot().slice() };
}

export function startMeshStunProbe(
  rtc: StunProbeRtc,
  scheduler: StunProbeScheduler
): StunProbeHandle {
  session?.stop();
  session = new MeshProbeLoop(rtc, scheduler, loopDeps, {
    intervalMs: STUN_PROBE_INTERVAL_MS,
    defaultMinIntervalMs: STUN_PROBE_MIN_INTERVAL_MS,
    urlsOf: (target) => target.currentIceConfig().stun,
    defaultProbeAll: (list, signal, now) => probeStunServers([...list], { signal, now }),
    logBatch: logStunProbeBatch,
  });
  session.start();
  return { stop: (after) => stopMeshStunProbe(after) };
}

export function stopMeshStunProbe(after?: () => void): void {
  session?.stop();
  after?.();
}

export function syncStunProbe(rtc: StunProbeRtc): void {
  session?.sync(rtc);
}
