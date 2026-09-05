import { pickWriterHub } from '../auth/mesh-hub-store';
import { nodeVersionSupportsHubAuthRecords } from '../hub/hub-authorization';
import type { PooledUplink } from './types';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export const UPLINK_RTT_SWITCH_MIN_RATIO = 0.3;
export const UPLINK_RTT_SWITCH_MIN_MS = 15;
export const UPLINK_RTT_MIN_SAMPLES = 2;

type RttState = { ewma: number; samples: number };

export type NearestSwitchPlan = {
  attached: AttachedHub;
  live: PooledUplink;
  best: UplinkCandidate;
};

export function selectNearestUplink(input: {
  enabled: boolean;
  attached: AttachedHub | null;
  live: PooledUplink | null;
  now: number;
  lastSwitchAt: number;
  dwellMs: number;
  candidates: UplinkCandidate[];
  rttOf: (publicUrl: string) => RttState | null;
  sameUrl: (a: string, b: string) => boolean;
}): NearestSwitchPlan | null {
  if (!input.enabled) return null;
  const { attached, live } = input;
  if (!attached || live?.state !== 'online') return null;
  if (input.lastSwitchAt > 0 && input.now - input.lastSwitchAt < input.dwellMs) return null;
  const best = input.candidates[0];
  if (!best || input.sameUrl(best.publicUrl, attached.publicUrl)) return null;
  if (!hasRttImprovement(attached.publicUrl, best.publicUrl, input.rttOf)) return null;
  if (!canAttachNearest(best, input.candidates)) return null;
  return { attached, live, best };
}

export function isCurrentUplinkSession(
  live: PooledUplink | null,
  attached: AttachedHub | null,
  plan: NearestSwitchPlan,
  sameUrl: (a: string, b: string) => boolean
): boolean {
  return (
    live === plan.live &&
    plan.live.state === 'online' &&
    attached !== null &&
    sameUrl(attached.publicUrl, plan.attached.publicUrl)
  );
}

export function isRttSwitchWorth(currentMs: number, bestMs: number): boolean {
  if (!(currentMs > 0) || !(bestMs >= 0)) return false;
  const delta = currentMs - bestMs;
  if (delta < UPLINK_RTT_SWITCH_MIN_MS) return false;
  return delta / currentMs >= UPLINK_RTT_SWITCH_MIN_RATIO;
}

export function hubSupportsNearestAttach(version: string | null | undefined): boolean {
  return nodeVersionSupportsHubAuthRecords(version);
}

export function writerHubIdOf(candidates: UplinkCandidate[]): string | null {
  return pickWriterHub(
    candidates
      .filter((row): row is UplinkCandidate & { hubNodeId: string } => Boolean(row.hubNodeId))
      .map((row) => ({
        hubNodeId: row.hubNodeId,
        mode: row.mode,
        writerEpoch: row.writerEpoch,
        priority: row.priority,
      }))
  );
}

function hasRttImprovement(
  currentUrl: string,
  nextUrl: string,
  rttOf: (publicUrl: string) => RttState | null
): boolean {
  const current = rttOf(currentUrl);
  const next = rttOf(nextUrl);
  if (!current || !next) return false;
  if (current.samples < UPLINK_RTT_MIN_SAMPLES || next.samples < UPLINK_RTT_MIN_SAMPLES)
    return false;
  return isRttSwitchWorth(current.ewma, next.ewma);
}

function canAttachNearest(best: UplinkCandidate, candidates: UplinkCandidate[]): boolean {
  const isWriter = Boolean(best.hubNodeId) && best.hubNodeId === writerHubIdOf(candidates);
  return isWriter || hubSupportsNearestAttach(best.version);
}
