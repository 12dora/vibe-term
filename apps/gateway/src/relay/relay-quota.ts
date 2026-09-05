import { RELAY_CTL_MAX_NODES, type RelayQuota } from '@tmex/shared/relay';
import { RELAY_DEFAULT_QUOTA } from './types';

/**
 * `relay.list` 一帧最多带 `RELAY_CTL_MAX_NODES`（256）个节点，超出的看不见也连不通，
 * 所以节点数配额直接按清单容量封顶——配大了只会让运营者以为能装下。
 */
export const RELAY_QUOTA_MAX_NODES_LIMIT = RELAY_CTL_MAX_NODES;
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

export const RELAY_TOKEN_BUCKET_BYPASS_BYTES = 4 * 1024;

type PendingTake = {
  state: TokenStreamState;
  remaining: number;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type TokenStreamState = {
  pending: PendingTake[];
  queued: boolean;
  closed: boolean;
};

export type RelayTokenStream = {
  take(bytes: number): Promise<void>;
  close(): void;
};

const defaultSleep: RelaySleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 每租户带宽令牌桶：只延迟不丢帧。容量 = 1 秒的额度，突发不超过 1 秒速率。
 * 大帧按逻辑流轮转分配令牌；不超过 4 KiB 的帧走优先通道，避免被 bulk 流阻塞。
 * `rate = null` 时不限速。
 */
export class RelayTokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly defaultStream = this.createState();
  private readonly bypass: PendingTake[] = [];
  private readonly ready: TokenStreamState[] = [];
  private draining = false;
  private lastGrantWasBypass = false;

  constructor(
    private rate: number | null,
    private readonly now: () => number = Date.now,
    private readonly sleep: RelaySleep = defaultSleep
  ) {
    this.tokens = rate ?? 0;
    this.lastRefillAt = now();
  }

  setRate(rate: number | null): void {
    const previous = this.rate;
    this.rate = rate;
    if (rate === null) {
      this.resolveAll();
      return;
    }
    if (previous === null) {
      this.tokens = rate;
      this.lastRefillAt = this.now();
    }
    this.tokens = Math.min(this.tokens, rate);
  }

  get rateBytesPerSec(): number | null {
    return this.rate;
  }

  createStream(): RelayTokenStream {
    const state = this.createState();
    return {
      take: (bytes) => this.takeFor(state, bytes),
      close: () => this.closeStream(state),
    };
  }

  take(bytes: number): Promise<void> {
    return this.takeFor(this.defaultStream, bytes);
  }

  private takeFor(state: TokenStreamState, bytes: number): Promise<void> {
    if (state.closed) return Promise.reject(new Error('relay token stream closed'));
    if (this.rate === null || bytes <= 0) return Promise.resolve();
    if (bytes <= RELAY_TOKEN_BUCKET_BYPASS_BYTES) return this.takeBypass(state, bytes);
    const pending = new Promise<void>((resolve, reject) => {
      state.pending.push({ state, remaining: bytes, resolve, reject });
    });
    this.schedule(state);
    this.ensureDrain();
    return pending;
  }

  private takeBypass(state: TokenStreamState, bytes: number): Promise<void> {
    const rate = this.rate;
    if (rate === null) return Promise.resolve();
    this.refill(rate);
    if (this.bypass.length === 0 && this.ready.length === 0 && this.tokens >= bytes) {
      this.tokens -= bytes;
      return Promise.resolve();
    }
    const pending = new Promise<void>((resolve, reject) => {
      this.bypass.push({ state, remaining: bytes, resolve, reject });
    });
    this.ensureDrain();
    return pending;
  }

  private createState(): TokenStreamState {
    return { pending: [], queued: false, closed: false };
  }

  private schedule(state: TokenStreamState): void {
    if (state.closed || state.queued || state.pending.length === 0) return;
    state.queued = true;
    this.ready.push(state);
  }

  private ensureDrain(): void {
    if (this.draining || !this.hasPending()) return;
    this.draining = true;
    void this.drain()
      .catch((err) => this.rejectAll(err))
      .finally(() => {
        this.draining = false;
        this.ensureDrain();
      });
  }

  private async drain(): Promise<void> {
    while (this.hasPending()) {
      const rate = this.rate;
      if (rate === null) {
        this.resolveAll();
        return;
      }
      this.refill(rate);
      if (this.tokens <= 0) {
        const next = this.nextTake();
        if (!next) {
          const stale = this.ready.shift();
          if (stale) stale.queued = false;
          continue;
        }
        const demand = Math.min(rate, next.remaining, RELAY_TOKEN_BUCKET_BYPASS_BYTES);
        await this.sleep(Math.max(1, Math.ceil(((demand - this.tokens) * 1000) / rate)));
        continue;
      }
      const bypass = this.shouldServeBypass() ? this.bypass[0] : undefined;
      if (bypass) {
        const spend = Math.min(this.tokens, bypass.remaining);
        this.tokens -= spend;
        bypass.remaining -= spend;
        if (bypass.remaining <= 0) {
          this.bypass.shift();
          bypass.resolve();
        }
        this.lastGrantWasBypass = true;
        continue;
      }
      const state = this.ready.shift();
      if (!state) continue;
      state.queued = false;
      const take = state.pending[0];
      if (!take) continue;
      const spend = Math.min(this.tokens, take.remaining, RELAY_TOKEN_BUCKET_BYPASS_BYTES);
      this.tokens -= spend;
      take.remaining -= spend;
      if (take.remaining <= 0) {
        state.pending.shift();
        take.resolve();
      }
      this.lastGrantWasBypass = false;
      this.schedule(state);
    }
  }

  private resolveAll(): void {
    for (const take of this.bypass.splice(0)) take.resolve();
    for (const state of this.ready.splice(0)) {
      state.queued = false;
      for (const take of state.pending.splice(0)) take.resolve();
    }
  }

  private rejectAll(reason: unknown): void {
    for (const take of this.bypass.splice(0)) take.reject(reason);
    for (const state of this.ready.splice(0)) {
      state.queued = false;
      for (const take of state.pending.splice(0)) take.reject(reason);
    }
  }

  private hasPending(): boolean {
    return this.bypass.length > 0 || this.ready.length > 0;
  }

  private nextTake(): PendingTake | undefined {
    return this.shouldServeBypass() ? this.bypass[0] : this.ready[0]?.pending[0];
  }

  private shouldServeBypass(): boolean {
    return this.bypass.length > 0 && (this.ready.length === 0 || !this.lastGrantWasBypass);
  }

  private closeStream(state: TokenStreamState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.queued) {
      const index = this.ready.indexOf(state);
      if (index >= 0) this.ready.splice(index, 1);
      state.queued = false;
    }
    const reason = new Error('relay token stream closed');
    for (const take of state.pending.splice(0)) take.reject(reason);
    for (let i = this.bypass.length - 1; i >= 0; i--) {
      const take = this.bypass[i];
      if (take?.state !== state) continue;
      this.bypass.splice(i, 1);
      take.reject(reason);
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
