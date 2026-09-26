import { combineAbortSignals } from '@vibeterm/shared/async';
import { hostFromUrl } from '@vibeterm/shared/auth';
import { backoffDelayMs } from './ctl';
import { stamp } from './mesh-log';
import type { MeshScheduler } from './types';
import {
  UPLINK_BACKOFF_MAX_MS,
  UPLINK_BACKOFF_MIN_MS,
  UPLINK_CONNECT_LOG_INTERVAL_MS,
} from './uplink-client';
import { isUplinkPathRerace } from './uplink-path-sampler';
import { redactUrl } from './uplink-pool-url';

export type SecondaryRetrySlot = {
  url: string;
  abort: AbortController;
  attempt: number;
  wake: AbortController;
};

export type SecondaryRetryHost = {
  scheduler: MeshScheduler;
  failLogAt: Map<string, number>;
  onlineLogAt: Map<string, number>;
};

type RetryClient = {
  lastConnectError: { reason: string; at: number } | null;
};

export async function sleepAfterSecondaryFail(
  slot: SecondaryRetrySlot,
  host: SecondaryRetryHost
): Promise<boolean> {
  const delay = backoffDelayMs(slot.attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
  slot.attempt += 1;
  return (await sleepSecondarySlot(slot, host, delay)) === 'stop';
}

export function noteSecondaryConnectFail(
  slot: SecondaryRetrySlot,
  client: RetryClient,
  err: unknown,
  host: SecondaryRetryHost
): number | null {
  if (slot.abort.signal.aborted) return null;
  const reason = client.lastConnectError?.reason ?? secondaryFailReason(err);
  if (reason === 'aborted') return null;
  const delay = isUplinkPathRerace(reason)
    ? 0
    : backoffDelayMs(slot.attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
  logSecondaryConnectFailed(host, slot.url, slot.attempt + 1, reason, delay);
  return delay;
}

export function logSecondaryOnline(host: SecondaryRetryHost, url: string): void {
  host.failLogAt.delete(url);
  const now = host.scheduler.now();
  const prev = host.onlineLogAt.get(url) ?? Number.NEGATIVE_INFINITY;
  if (now - prev < UPLINK_CONNECT_LOG_INTERVAL_MS) return;
  host.onlineLogAt.set(url, now);
  console.info(stamp(`[uplink] secondary online url=${secondaryUrlLabel(url)}`));
}

export async function sleepBeforeSecondaryRetry(
  slot: SecondaryRetrySlot,
  closeReason: string,
  loggedDelay: number | null,
  host: SecondaryRetryHost
): Promise<boolean> {
  if (isUplinkPathRerace(closeReason)) {
    slot.attempt = 0;
    return false;
  }
  const delay =
    loggedDelay ?? backoffDelayMs(slot.attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
  slot.attempt += 1;
  return (await sleepSecondarySlot(slot, host, delay)) === 'stop';
}

async function sleepSecondarySlot(
  slot: SecondaryRetrySlot,
  host: SecondaryRetryHost,
  delay: number
): Promise<'stop' | 'retry'> {
  const wake = slot.wake;
  const signal = combineAbortSignals(slot.abort.signal, wake.signal);
  try {
    await host.scheduler.sleep(delay, signal);
    return 'retry';
  } catch {
    if (slot.abort.signal.aborted) return 'stop';
    slot.wake = new AbortController();
    return 'retry';
  }
}

function logSecondaryConnectFailed(
  host: SecondaryRetryHost,
  url: string,
  attempt: number,
  reason: string,
  nextRetryMs: number
): void {
  const now = host.scheduler.now();
  const prev = host.failLogAt.get(url) ?? Number.NEGATIVE_INFINITY;
  if (now - prev < UPLINK_CONNECT_LOG_INTERVAL_MS) return;
  host.failLogAt.set(url, now);
  console.warn(
    stamp(
      `[uplink] secondary connect failed url=${secondaryUrlLabel(url)} attempt=${attempt} reason=${reason} next_retry_ms=${nextRetryMs}`
    )
  );
}

function secondaryFailReason(err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : '';
  return msg || 'connect-failed';
}

function secondaryUrlLabel(url: string): string {
  try {
    return hostFromUrl(url);
  } catch {
    return redactUrl(url);
  }
}
