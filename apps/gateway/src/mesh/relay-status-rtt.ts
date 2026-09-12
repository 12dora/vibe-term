import type { RelayStatusBlob } from '@vibeterm/shared/relay';

/** 心跳 RTT 变化达到这一比例且绝对值才触发重发（与 nearest-switch 同量级）。 */
export const RELAY_RTT_RESEND_MIN_RATIO = 0.2;
export const RELAY_RTT_RESEND_MIN_MS = 15;
/** 仅因 RTT 变化而重发 status blob 的下限间隔。 */
export const RELAY_RTT_RESEND_INTERVAL_MS = 60_000;

export function rttChangedMaterially(prev: number | null, next: number | null): boolean {
  if (next == null || !Number.isFinite(next) || next < 0) return false;
  if (prev == null || !Number.isFinite(prev) || prev < 0) return true;
  const delta = Math.abs(next - prev);
  return delta >= RELAY_RTT_RESEND_MIN_MS && delta >= RELAY_RTT_RESEND_MIN_RATIO * prev;
}

export function statusBlobWithoutRtt(blob: RelayStatusBlob): RelayStatusBlob {
  const { rtt_ms: _rtt, ...rest } = blob;
  return rest;
}
