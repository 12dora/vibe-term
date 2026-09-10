import { RELAY_CTL_MAX_NODES, type RelayQuota } from '@vibeterm/shared/relay';
import { RELAY_DEFAULT_QUOTA } from './types';

/**
 * `relay.list` 一帧最多带 `RELAY_CTL_MAX_NODES`（256）个节点，超出的看不见也连不通，
 * 所以节点数配额直接按清单容量封顶——配大了只会让运营者以为能装下。
 */
export const RELAY_QUOTA_MAX_NODES_LIMIT = RELAY_CTL_MAX_NODES;
export const RELAY_QUOTA_MAX_STREAMS_LIMIT = 65_536;
export const RELAY_QUOTA_MAX_BANDWIDTH = 10 * 1024 * 1024 * 1024;
/** 单文件上限的天花板；再大也没有实际意义，且要留住整数精度。 */
export const RELAY_QUOTA_MAX_FILE_BYTES = 1024 * 1024 * 1024 * 1024;

/** 「非法」与「不限（null）」必须分得开，用哨兵而不是 null 表示非法。 */
const INVALID = Symbol('invalid');

function optionalPositiveInt(value: unknown, limit: number): number | null | typeof INVALID {
  if (value === null || value === undefined) return null;
  return positiveInt(value, limit) ?? INVALID;
}

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
  const bandwidthBytesPerSec = optionalPositiveInt(
    rec.bandwidthBytesPerSec,
    RELAY_QUOTA_MAX_BANDWIDTH
  );
  if (bandwidthBytesPerSec === INVALID) return null;
  const maxFileBytes = optionalPositiveInt(rec.maxFileBytes, RELAY_QUOTA_MAX_FILE_BYTES);
  if (maxFileBytes === INVALID) return null;
  return { maxNodes, maxStreams, bandwidthBytesPerSec, maxFileBytes };
}

export function serializeRelayQuota(quota: RelayQuota): string {
  return JSON.stringify({
    maxNodes: quota.maxNodes,
    maxStreams: quota.maxStreams,
    bandwidthBytesPerSec: quota.bandwidthBytesPerSec,
    maxFileBytes: quota.maxFileBytes ?? null,
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

/** 每笔待发放请求的取消身份：一条流可以派生多个把手，各自独立取消。 */
type TakeOwner = { closed: boolean };

type PendingTake = {
  state: TokenStreamState;
  owner: TakeOwner;
  remaining: number;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type TokenStreamState = TakeOwner & {
  pending: PendingTake[];
  bypassPending: PendingTake[];
  queued: boolean;
  bypassQueued: boolean;
};

/** 轮转里下一笔该发放的请求，以及它走的是旁路道还是流队列。 */
type NextTake = { take: PendingTake; fromBypass: boolean };

export type RelayTokenHandle = {
  take(bytes: number): Promise<void>;
  /**
   * 走旁路道（仍受 ≤4 KiB 限制；更大的帧退回轮转）。
   * 旁路按流轮转，不进 bulk 队列；中继级总闸按租户预算调用。
   */
  takeBypass(bytes: number): Promise<void>;
  close(): void;
};

export type RelayTokenStream = RelayTokenHandle & {
  /** 派生一个可单独关闭的把手：关掉它只撤自己排队的请求，同流其他把手不受影响。 */
  createHandle(): RelayTokenHandle;
};

export type RelayTokenBucketOptions = {
  /** 关掉后 ≤4 KiB 的帧也进轮转队列。中继级总闸默认关掉；有界旁路改调 `takeBypass`。 */
  bypassSmallFrames?: boolean;
};

const CLOSED_MESSAGE = 'relay token stream closed';

const defaultSleep: RelaySleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 每租户带宽令牌桶：只延迟不丢帧。容量 = 1 秒的额度，突发不超过 1 秒速率。
 * 大帧按逻辑流轮转分配令牌；不超过 4 KiB 的帧默认走优先通道，避免被 bulk 流阻塞。
 * `rate = null` 时不限速。
 */
export class RelayTokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly states = new Set<TokenStreamState>();
  private readonly defaultStream = this.createState();
  private readonly ready: TokenStreamState[] = [];
  private readonly bypassReady: TokenStreamState[] = [];
  private readonly bypassSmallFrames: boolean;
  private draining = false;
  private lastGrantWasBypass = false;

  constructor(
    private rate: number | null,
    private readonly now: () => number = Date.now,
    private readonly sleep: RelaySleep = defaultSleep,
    options: RelayTokenBucketOptions = {}
  ) {
    this.tokens = rate ?? 0;
    this.lastRefillAt = now();
    this.bypassSmallFrames = options.bypassSmallFrames !== false;
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

  /** 还没发放完的请求笔数；泄漏回归测试靠它断言「关掉的把手不留队列」。 */
  get pendingCount(): number {
    let total = 0;
    for (const state of this.states) total += state.pending.length + state.bypassPending.length;
    return total;
  }

  createStream(): RelayTokenStream {
    const state = this.createState();
    return {
      take: (bytes) => this.takeFor(state, state, bytes),
      takeBypass: (bytes) => this.takeFor(state, state, bytes, true),
      close: () => this.closeStream(state),
      createHandle: () => this.createHandleFor(state),
    };
  }

  take(bytes: number): Promise<void> {
    return this.takeFor(this.defaultStream, this.defaultStream, bytes);
  }

  takeBypass(bytes: number): Promise<void> {
    return this.takeFor(this.defaultStream, this.defaultStream, bytes, true);
  }

  /** 停机：撤掉全部排队请求，含桶自带的默认流。 */
  cancelAll(reason: unknown = new Error('relay token bucket closed')): void {
    this.rejectAll(reason);
  }

  private createHandleFor(state: TokenStreamState): RelayTokenHandle {
    const owner: TakeOwner = { closed: false };
    return {
      take: (bytes) => this.takeFor(state, owner, bytes),
      takeBypass: (bytes) => this.takeFor(state, owner, bytes, true),
      close: () => this.closeOwner(state, owner),
    };
  }

  private takeFor(
    state: TokenStreamState,
    owner: TakeOwner,
    bytes: number,
    preferBypass = false
  ): Promise<void> {
    if (state.closed || owner.closed) return Promise.reject(new Error(CLOSED_MESSAGE));
    if (this.rate === null || bytes <= 0) return Promise.resolve();
    if (this.canBypass(bytes, preferBypass)) {
      return this.enqueueBypass(state, owner, bytes);
    }
    const pending = new Promise<void>((resolve, reject) => {
      state.pending.push({ state, owner, remaining: bytes, resolve, reject });
    });
    this.schedule(state);
    this.ensureDrain();
    return pending;
  }

  private canBypass(bytes: number, preferBypass: boolean): boolean {
    return (preferBypass || this.bypassSmallFrames) && bytes <= RELAY_TOKEN_BUCKET_BYPASS_BYTES;
  }

  private enqueueBypass(state: TokenStreamState, owner: TakeOwner, bytes: number): Promise<void> {
    const rate = this.rate;
    if (rate === null) return Promise.resolve();
    this.refill(rate);
    if (this.bypassReady.length === 0 && this.ready.length === 0 && this.tokens >= bytes) {
      this.tokens -= bytes;
      return Promise.resolve();
    }
    const pending = new Promise<void>((resolve, reject) => {
      state.bypassPending.push({ state, owner, remaining: bytes, resolve, reject });
    });
    this.scheduleBypass(state);
    this.ensureDrain();
    return pending;
  }

  private createState(): TokenStreamState {
    const state: TokenStreamState = {
      pending: [],
      bypassPending: [],
      queued: false,
      bypassQueued: false,
      closed: false,
    };
    this.states.add(state);
    return state;
  }

  private schedule(state: TokenStreamState): void {
    if (state.closed || state.queued || state.pending.length === 0) return;
    state.queued = true;
    this.ready.push(state);
  }

  private scheduleBypass(state: TokenStreamState): void {
    if (state.closed || state.bypassQueued || state.bypassPending.length === 0) return;
    state.bypassQueued = true;
    this.bypassReady.push(state);
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

  /**
   * 一轮只发放整块（`chunk`），攒不够就先睡。
   * 发放零头会毁掉轮转：谁分到零头谁就要等下一次补给才凑得齐一块，
   * 而下一次补给又整块给了对手——帧长正好等于轮转粒度时会锁成一边倒。
   */
  private async drain(): Promise<void> {
    while (this.hasPending()) {
      const rate = this.rate;
      if (rate === null) {
        this.resolveAll();
        return;
      }
      this.refill(rate);
      const next = this.nextTake();
      if (!next) {
        this.dropStale();
        continue;
      }
      const chunk = Math.min(rate, next.take.remaining, RELAY_TOKEN_BUCKET_BYPASS_BYTES);
      if (this.tokens < chunk) {
        await this.sleep(Math.max(1, Math.ceil(((chunk - this.tokens) * 1000) / rate)));
        continue;
      }
      this.grant(next, chunk);
    }
  }

  /** 队头的流已经没有待发放请求了（把手被关掉），把它从轮转里摘掉。 */
  private dropStale(): void {
    if (this.shouldServeBypass()) {
      const staleBypass = this.bypassReady.shift();
      if (staleBypass) staleBypass.bypassQueued = false;
      return;
    }
    const stale = this.ready.shift();
    if (stale) stale.queued = false;
  }

  private grant(next: NextTake, chunk: number): void {
    const take = next.take;
    this.tokens -= chunk;
    take.remaining -= chunk;
    if (next.fromBypass) {
      this.rotateBypass(take);
      return;
    }
    const state = this.ready.shift();
    if (state) state.queued = false;
    if (take.remaining <= 0) {
      take.state.pending.shift();
      take.resolve();
    }
    this.lastGrantWasBypass = false;
    if (state) this.schedule(state);
  }

  private rotateBypass(take: PendingTake): void {
    const state = this.bypassReady.shift();
    if (state) state.bypassQueued = false;
    if (take.remaining <= 0) {
      take.state.bypassPending.shift();
      take.resolve();
    }
    this.lastGrantWasBypass = true;
    if (state) this.scheduleBypass(state);
  }

  private resolveAll(): void {
    this.bypassReady.length = 0;
    this.ready.length = 0;
    for (const state of this.states) {
      state.queued = false;
      state.bypassQueued = false;
      for (const take of state.bypassPending.splice(0)) take.resolve();
      for (const take of state.pending.splice(0)) take.resolve();
    }
  }

  private rejectAll(reason: unknown): void {
    this.bypassReady.length = 0;
    this.ready.length = 0;
    for (const state of this.states) {
      state.queued = false;
      state.bypassQueued = false;
      for (const take of state.bypassPending.splice(0)) take.reject(reason);
      for (const take of state.pending.splice(0)) take.reject(reason);
    }
  }

  private hasPending(): boolean {
    return this.bypassReady.length > 0 || this.ready.length > 0;
  }

  private nextTake(): NextTake | undefined {
    if (this.shouldServeBypass()) {
      const take = this.bypassReady[0]?.bypassPending[0];
      return take ? { take, fromBypass: true } : undefined;
    }
    const take = this.ready[0]?.pending[0];
    return take ? { take, fromBypass: false } : undefined;
  }

  private shouldServeBypass(): boolean {
    return this.bypassReady.length > 0 && (this.ready.length === 0 || !this.lastGrantWasBypass);
  }

  private closeStream(state: TokenStreamState): void {
    if (state.closed) return;
    state.closed = true;
    this.states.delete(state);
    this.dropTakes(state, null);
  }

  private closeOwner(state: TokenStreamState, owner: TakeOwner): void {
    if (owner.closed) return;
    owner.closed = true;
    this.dropTakes(state, owner);
  }

  /** `owner` 为 null 时撤掉整条流的请求，否则只撤该把手自己那几笔。 */
  private dropTakes(state: TokenStreamState, owner: TakeOwner | null): void {
    const reason = new Error(CLOSED_MESSAGE);
    const owned = (take: PendingTake): boolean => owner === null || take.owner === owner;
    for (let i = state.pending.length - 1; i >= 0; i--) {
      const take = state.pending[i];
      if (!take || !owned(take)) continue;
      state.pending.splice(i, 1);
      take.reject(reason);
    }
    for (let i = state.bypassPending.length - 1; i >= 0; i--) {
      const take = state.bypassPending[i];
      if (!take || !owned(take)) continue;
      state.bypassPending.splice(i, 1);
      take.reject(reason);
    }
    if (state.queued && state.pending.length === 0) {
      const index = this.ready.indexOf(state);
      if (index >= 0) this.ready.splice(index, 1);
      state.queued = false;
    }
    if (state.bypassQueued && state.bypassPending.length === 0) {
      const index = this.bypassReady.indexOf(state);
      if (index >= 0) this.bypassReady.splice(index, 1);
      state.bypassQueued = false;
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
