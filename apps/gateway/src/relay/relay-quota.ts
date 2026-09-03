import type { RelayQuota } from '@tmex/shared/relay';
import { RELAY_DEFAULT_QUOTA } from './types';

export const RELAY_QUOTA_MAX_NODES_LIMIT = 4096;
export const RELAY_QUOTA_MAX_STREAMS_LIMIT = 65_536;
export const RELAY_QUOTA_MAX_BANDWIDTH = 10 * 1024 * 1024 * 1024;

function positiveInt(value: unknown, limit: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > limit) return null;
  return value;
}

/** 宽松解析（用于读库）：字段缺失或越界时回落到默认配额。 */
export function parseRelayQuotaJson(raw: string | null): RelayQuota | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeRelayQuota(parsed) ?? null;
  } catch {
    return null;
  }
}

/** 严格解析（用于 HTTP 入参）：任何字段非法都返回 null，让调用方回 400。 */
export function normalizeRelayQuota(value: unknown): RelayQuota | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const maxNodes = positiveInt(rec.maxNodes, RELAY_QUOTA_MAX_NODES_LIMIT);
  const maxStreams = positiveInt(rec.maxStreams, RELAY_QUOTA_MAX_STREAMS_LIMIT);
  if (maxNodes === null || maxStreams === null) return null;
  const raw = rec.bandwidthBytesPerSec;
  let bandwidthBytesPerSec: number | null;
  if (raw === null || raw === undefined) {
    bandwidthBytesPerSec = null;
  } else {
    const parsed = positiveInt(raw, RELAY_QUOTA_MAX_BANDWIDTH);
    if (parsed === null) return null;
    bandwidthBytesPerSec = parsed;
  }
  return { maxNodes, maxStreams, bandwidthBytesPerSec };
}

export function serializeRelayQuota(quota: RelayQuota): string {
  return JSON.stringify({
    maxNodes: quota.maxNodes,
    maxStreams: quota.maxStreams,
    bandwidthBytesPerSec: quota.bandwidthBytesPerSec,
  });
}

export function effectiveRelayQuota(
  tenantQuota: RelayQuota | null,
  defaultQuota: RelayQuota
): RelayQuota {
  return tenantQuota ?? defaultQuota;
}

export function defaultRelayQuota(): RelayQuota {
  return { ...RELAY_DEFAULT_QUOTA };
}

export type RelaySleep = (ms: number) => Promise<void>;

const defaultSleep: RelaySleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 每租户带宽令牌桶：只延迟不丢帧。容量 = 1 秒的额度，突发不超过 1 秒速率。
 * `rate = null` 时不限速。
 */
export class RelayTokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private rate: number | null,
    private readonly now: () => number = Date.now,
    private readonly sleep: RelaySleep = defaultSleep
  ) {
    this.tokens = rate ?? 0;
    this.lastRefillAt = now();
  }

  setRate(rate: number | null): void {
    this.rate = rate;
    if (rate === null) return;
    this.tokens = Math.min(this.tokens, rate);
  }

  get rateBytesPerSec(): number | null {
    return this.rate;
  }

  /** 串行排队：多个流共享同一租户额度，先到先得。 */
  take(bytes: number): Promise<void> {
    if (this.rate === null || bytes <= 0) return Promise.resolve();
    const next = this.queue.then(() => this.consume(bytes));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async consume(bytes: number): Promise<void> {
    let remaining = bytes;
    while (remaining > 0) {
      const rate = this.rate;
      if (rate === null) return;
      this.refill(rate);
      if (this.tokens <= 0) {
        await this.sleep(Math.max(1, Math.ceil((1000 * Math.min(remaining, rate)) / rate)));
        continue;
      }
      const spend = Math.min(this.tokens, remaining);
      this.tokens -= spend;
      remaining -= spend;
    }
  }

  private refill(rate: number): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.lastRefillAt = now;
    this.tokens = Math.min(rate, this.tokens + (elapsed * rate) / 1000);
  }
}
