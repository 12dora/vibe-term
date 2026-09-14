import type { PooledUplink } from './types';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export const UPLINK_RTT_SWITCH_MIN_RATIO = 0.3;
export const UPLINK_RTT_SWITCH_MIN_MS = 15;
export const UPLINK_RTT_MIN_SAMPLES = 2;

export type NearestSwitchPlan = {
  attached: AttachedHub;
  live: PooledUplink;
  best: UplinkCandidate;
};

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
