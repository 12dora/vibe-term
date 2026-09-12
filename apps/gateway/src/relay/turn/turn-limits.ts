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
export const DEFAULT_MAX_LIFETIME_SEC = 3600;
export const HOUSEKEEPING_MS = 1_000;
export const MAX_UDP_PACKET = 65_535;

export function grantLifetimeSec(requested: number | undefined, maxSec: number): number {
  if (requested === 0) return 0;
  const value = requested ?? DEFAULT_LIFETIME_SEC;
  return Math.min(Math.max(value, DEFAULT_LIFETIME_SEC), maxSec);
}
