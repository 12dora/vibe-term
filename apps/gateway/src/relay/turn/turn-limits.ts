export const DEFAULT_LIFETIME_SEC = 600;
export const PERMISSION_LIFETIME_MS = 300_000;
export const CHANNEL_LIFETIME_MS = 600_000;
export const NONCE_LIFETIME_MS = 3_600_000;
export const NONCE_GRACE_MS = 300_000;
export const UDP_PROTOCOL = 17;
export const CHANNEL_MIN = 0x4000;
export const CHANNEL_MAX = 0x7fff;
export const DEFAULT_MAX_ALLOCATIONS = 64;
export const DEFAULT_MAX_ALLOCATIONS_PER_USER = 32;

export function turnRelayRangeSize(range: { begin: number; end: number }): number {
  return range.end - range.begin + 1;
}

/** 默认配额封顶到中继段端口数，避免 64 配额打 49 口时提前 508。显式传入的配额不改。 */
export function clampTurnAllocations(
  range: { begin: number; end: number },
  caps: { maxAllocations?: number; maxAllocationsPerUser?: number } = {}
): { maxAllocations: number; maxAllocationsPerUser: number } {
  const size = turnRelayRangeSize(range);
  return {
    maxAllocations: caps.maxAllocations ?? Math.min(DEFAULT_MAX_ALLOCATIONS, size),
    maxAllocationsPerUser:
      caps.maxAllocationsPerUser ?? Math.min(DEFAULT_MAX_ALLOCATIONS_PER_USER, size),
  };
}
export const DEFAULT_MAX_LIFETIME_SEC = 3600;
export const HOUSEKEEPING_MS = 1_000;
export const MAX_UDP_PACKET = 65_535;
export const MAX_PERMISSIONS_PER_ALLOCATION = 32;
export const MAX_XOR_PEERS_PER_REQUEST = 16;
export const MAX_CHANNEL_DATA_PAYLOAD = MAX_UDP_PACKET - 4;
export const UNAUTH_PER_IP_RATE = 20;
export const UNAUTH_PER_IP_BURST = 40;
export const UNAUTH_GLOBAL_RATE = 2_000;
export const UNAUTH_GLOBAL_BURST = 2_000;
export const UNAUTH_IDLE_MS = 60_000;
export const UNAUTH_MAX_IPS = 4_096;

export function grantLifetimeSec(requested: number | undefined, maxSec: number): number {
  if (requested === 0) return 0;
  const value = requested ?? DEFAULT_LIFETIME_SEC;
  return Math.min(Math.max(value, DEFAULT_LIFETIME_SEC), maxSec);
}
