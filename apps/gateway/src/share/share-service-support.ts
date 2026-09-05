import { normalizeShareOrigin } from '@tmex/shared/share';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import type { ShareRecorderRuntime } from './share-recorder';
import { SHARE_ACCESS_TTL_MS } from './share-token';

export function accessExpiry(shareExpiresAt: number | null, now: number): number {
  const cap = now + SHARE_ACCESS_TTL_MS;
  return shareExpiresAt === null ? cap : Math.min(cap, shareExpiresAt);
}

export function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function normalizeDefaultOrigin(value: string | null): string | null {
  if (!value) return null;
  return normalizeShareOrigin(value);
}

export function defaultAcquireRuntime(deviceId: string): Promise<ShareRecorderRuntime> {
  return tmuxRuntimeRegistry.acquire(deviceId);
}

export function defaultReleaseRuntime(
  deviceId: string,
  runtime: ShareRecorderRuntime
): Promise<void> {
  return tmuxRuntimeRegistry.release(deviceId, runtime as object);
}
