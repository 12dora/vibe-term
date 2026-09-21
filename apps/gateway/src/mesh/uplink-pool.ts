import { combineAbortSignals } from '@vibeterm/shared/async';
import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { RelayCaPinStore } from '../auth/relay-ca-pin-store';
import type { UserStore } from '../auth/user-store';
import { backoffDelayMs, defaultScheduler } from './ctl';
import { createDialWsFactory } from './dial-resolve';
import { stamp } from './mesh-log';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  PooledUplink,
  UplinkState,
  UplinkStatus,
} from './types';
import {
  UPLINK_BACKOFF_MAX_MS,
  UPLINK_BACKOFF_MIN_MS,
  type UplinkClientOptions,
  type UplinkWsFactory,
  isUplinkConnectCoolable,
  uplinkCandidateCooldownMs,
} from './uplink-constants';
import { isUplinkPathRerace, sleepAfterUplinkSession } from './uplink-path-sampler';
import { type UrlDiag, emptyUplinkDiag, mergeUplinkDiag } from './uplink-pool-diag';
import { defaultProbeHealthz } from './uplink-pool-http';
import { runPreferredProbe } from './uplink-pool-probe';
import { type UplinkSwitchResult, runUplinkSwitch, terminalErrorOf } from './uplink-pool-switch';
import { primaryTargetOf } from './uplink-pool-target';
import { normalizeUplinkEndpointUrl, redactUrl, sameUplinkUrl } from './uplink-pool-url';
import { UplinkRelayDrain, type UplinkRelayDrainReason } from './uplink-relay-drain';

export type { UplinkSwitchResult } from './uplink-pool-switch';
export {
  attachedUplinkHost,
  normalizeUplinkEndpointUrl,
  redactUrl,
  sameUplinkUrl,
} from './uplink-pool-url';
export {
  UPLINK_RTT_MIN_SAMPLES,
  UPLINK_RTT_SWITCH_MIN_MS,
  UPLINK_RTT_SWITCH_MIN_RATIO,
  isRttSwitchWorth,
} from './uplink-nearest-switch';

export { defaultProbeHealthz, joinUplinkPath } from './uplink-pool-http';
import type {
  UplinkCtlMessage,
  UplinkEnrollRedeemed,
  UplinkNodeList,
  UplinkRtcSignal,
} from './uplink-protocol';

export const UPLINK_POOL_FAIL_LIMIT = 3;
export const UPLINK_POOL_AUTH_DEADLINE_MS = 20_000;
export const UPLINK_POOL_PROBE_INTERVAL_MS = 60_000;
export const UPLINK_POOL_PROBE_TIMEOUT_MS = 5_000;
export const UPLINK_POOL_PROBE_JITTER = 0.2;
export const UPLINK_POOL_FAILBACK_DEBOUNCE_MS = 5_000;
export const UPLINK_POOL_RTT_PROBE_INTERVAL_MS = 300_000;
export const UPLINK_RTT_EWMA_ALPHA = 0.3;
export const UPLINK_RTT_SWITCH_DWELL_MS = 10 * 60 * 1000;
export const UPLINK_POOL_PROBE_NOW_DEBOUNCE_MS = 2_000;
export const UPLINK_POOL_FAIL_LOG_INTERVAL_MS = 60_000;

export type UplinkCandidate = {
  uplinkNodeId: string | null;
  publicUrl: string;
  priority: number;
  lastError?: string | null;
  lastErrorAt?: number | null;
  lastAttemptAt?: number | null;
  rttMs?: number | null;
  rttAt?: number | null;
  version?: string | null;
};

export type AttachedUplink = {
  publicUrl: string;
  since: number;
};

export type UplinkPoolNodeListMeta = {
  uplinkNodeId: string | null;
  generation: number;
};

export type CreatePooledUplink = (opts: UplinkClientOptions) => PooledUplink;

export type UplinkPoolOptions = {
  identity: MeshIdentity;
  userId: string | (() => string);
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  statusProvider: () => UplinkStatus;
  candidates: () => UplinkCandidate[];
  wsFactory?: UplinkWsFactory;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  createClient: CreatePooledUplink;
  caPins: RelayCaPinStore;
  probeHealthz?: (publicUrl: string, tlsCa: string[] | null, timeoutMs: number) => Promise<boolean>;
  probeJitter?: number;
  failbackDebounceMs?: number;
  probeNowDebounceMs?: number;
  rttProbeIntervalMs?: number;
  enablePeriodicRttProbe?: boolean;
  onNodeList?: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onKeyLogFork?: (event: KeyLogForkEvent) => void;
  failLimit?: number;
  authDeadlineMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  relayDrainRecheckMs?: number;
  relayDrainTimeoutMs?: number;
  dialCoordinator?: UplinkDialCoordinator;
};

export function jitteredIntervalMs(baseMs: number, jitter = UPLINK_POOL_PROBE_JITTER): number {
  const ratio = Math.min(Math.max(jitter, 0), 1);
  const delta = baseMs * ratio;
  return Math.max(1, Math.floor(baseMs - delta + Math.random() * (2 * delta)));
}

/** 池与 secondary 共享：同一 URL 同时只允许一条在途拨号，在线 secondary 可被 promote。 */
export class UplinkDialCoordinator {
  private readonly inflight = new Map<string, object>();
  private readonly standbys = new Map<
    string,
    { client: PooledUplink; yieldClient: () => void; owner: object }
  >();

  tryClaim(url: string, owner: object): boolean {
    const key = normalizeUplinkEndpointUrl(url);
    const cur = this.inflight.get(key);
    if (cur && cur !== owner) return false;
    this.inflight.set(key, owner);
    return true;
  }

  release(url: string, owner: object): void {
    const key = normalizeUplinkEndpointUrl(url);
    if (this.inflight.get(key) === owner) this.inflight.delete(key);
  }

  claimedBy(url: string): object | null {
    return this.inflight.get(normalizeUplinkEndpointUrl(url)) ?? null;
  }

  offerStandby(url: string, client: PooledUplink, yieldClient: () => void, owner: object): void {
    this.standbys.set(normalizeUplinkEndpointUrl(url), { client, yieldClient, owner });
  }

  dropStandby(url: string, client: PooledUplink): void {
    const key = normalizeUplinkEndpointUrl(url);
    if (this.standbys.get(key)?.client === client) this.standbys.delete(key);
  }

  takeOnline(url: string): PooledUplink | null {
    const key = normalizeUplinkEndpointUrl(url);
    const row = this.standbys.get(key);
    if (!row || row.client.state !== 'online') return null;
    this.standbys.delete(key);
    this.inflight.delete(key);
    row.yieldClient();
    return row.client;
  }

  dropOwner(owner: object): void {
    for (const [url, who] of [...this.inflight]) {
      if (who === owner) this.inflight.delete(url);
    }
    for (const [url, row] of [...this.standbys]) {
      if (row.owner === owner) this.standbys.delete(url);
    }
  }
}

export const defaultUplinkDialCoordinator = new UplinkDialCoordinator();

export function watchPredicate(check: () => boolean, fire: () => void, everyMs = 25): () => void {
  let stopped = false;
  const id = setInterval(() => {
    if (stopped || !check()) return;
    stopped = true;
    clearInterval(id);
    fire();
  }, everyMs);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

export function pooledUplinkIfCapable(client: object): PooledUplink | null {
  const row = client as Partial<PooledUplink>;
  if (typeof row.connectWithLink !== 'function' || typeof row.requestCatchUpNow !== 'function') {
    return null;
  }
  return client as PooledUplink;
}

export function offerPooledStandby(
  coordinator: UplinkDialCoordinator,
  url: string,
  client: object,
  slot: { yielded: boolean; client: unknown; abort: AbortController },
  owner: object
): void {
  const pooled = pooledUplinkIfCapable(client);
  if (!pooled) return;
  coordinator.offerStandby(
    url,
    pooled,
    () => {
      slot.yielded = true;
      slot.client = null;
      slot.abort.abort();
    },
    owner
  );
}

export class UplinkPool {
  readonly identity: MeshIdentity;
  lastConnectError: { reason: string; at: number } | null = null;

  private readonly userIdOf: () => string;
  private readonly opts: UplinkPoolOptions;
  private readonly scheduler: MeshScheduler;
  private readonly createClient: CreatePooledUplink;
  private readonly failLimit: number;
  private readonly authDeadlineMs: number;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly probeJitter: number;
  private readonly failbackDebounceMs: number;
  private readonly probeNowDebounceMs: number;
  private readonly rttProbeIntervalMs: number;
  private readonly relayDrain: UplinkRelayDrain;
  private lastSessionReason = '';

  private live: PooledUplink | null = null;
  pending: PooledUplink | null = null;
  private attached: AttachedUplink | null = null;
  private generation = 0;
  private switchToken = 0;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private probe: { clear: () => void } | null = null;
  private probeInFlight = false;
  private rttProbe: { clear: () => void } | null = null;
  private rttProbeInFlight = false;
  private failbackDebounceAbort: AbortController | null = null;
  private failbackCoalesced = false;
  private coalescedDebounceMs: number;
  private failbackProbeDeadlineAt = 0;
  private lastFailbackProbeAt = 0;
  private wrapAttempt = 0;
  private lastDialUrl: string | null = null;
  private readonly diagByUrl = new Map<string, UrlDiag>();
  private readonly candLogAt = new Map<
    string,
    { index: number; error: string | null; transport: string; at: number }
  >();
  private readonly probeLogAt = new Map<string, number>();
  private wrapSleepAbort: AbortController | null = null;
  private readonly dialCoordinator: UplinkDialCoordinator;
  private readonly coolByUrl = new Map<string, { until: number; fails: number }>();
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private readonly attachedListeners: Array<(uplink: AttachedUplink) => void> = [];
  private readonly detachedListeners: Array<() => void> = [];
  private readonly nodeListListeners: Array<
    (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void
  > = [];
  private liveStateOff: (() => void) | null = null;

  constructor(opts: UplinkPoolOptions) {
    this.opts = opts;
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.createClient = opts.createClient;
    this.failLimit = opts.failLimit ?? UPLINK_POOL_FAIL_LIMIT;
    this.authDeadlineMs = opts.authDeadlineMs ?? UPLINK_POOL_AUTH_DEADLINE_MS;
    this.probeIntervalMs = opts.probeIntervalMs ?? UPLINK_POOL_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? UPLINK_POOL_PROBE_TIMEOUT_MS;
    this.probeJitter = opts.probeJitter ?? UPLINK_POOL_PROBE_JITTER;
    this.failbackDebounceMs = opts.failbackDebounceMs ?? UPLINK_POOL_FAILBACK_DEBOUNCE_MS;
    this.probeNowDebounceMs = opts.probeNowDebounceMs ?? UPLINK_POOL_PROBE_NOW_DEBOUNCE_MS;
    this.coalescedDebounceMs = this.failbackDebounceMs;
    this.rttProbeIntervalMs = opts.rttProbeIntervalMs ?? UPLINK_POOL_RTT_PROBE_INTERVAL_MS;
    this.dialCoordinator = opts.dialCoordinator ?? new UplinkDialCoordinator();
    this.relayDrain = new UplinkRelayDrain({
      scheduler: this.scheduler,
      recheckMs: opts.relayDrainRecheckMs,
      timeoutMs: opts.relayDrainTimeoutMs,
      log: (line) => this.logInfo(line),
    });
  }

  get userId(): string {
    return this.live?.userId ?? this.pending?.userId ?? this.userIdOf();
  }

  get state(): UplinkState {
    return this.live?.state ?? this.pending?.state ?? 'offline';
  }

  get link() {
    return this.live?.link ?? this.pending?.link ?? null;
  }

  get lastKeyLogHead() {
    return this.live?.lastKeyLogHead ?? this.pending?.lastKeyLogHead ?? null;
  }

  attachedUplink(): AttachedUplink | null {
    return this.attached;
  }

  /** 已挂上，否则正在拨 / 上次尝试的 URL；空闲或已 stop 才为 null。 */
  primaryTarget(): string | null {
    return primaryTargetOf(
      this.attached?.publicUrl,
      this.pending?.uplinkUrl ?? this.lastDialUrl,
      this.loop != null
    );
  }

  /** 候选由 `opts.candidates()` 惰性读库；重算 RTT / failback 探测节奏，不动在线客户端。 */
  refreshCandidates(): void {
    this.syncRttProbe();
    this.syncProbe();
  }

  candidates(): UplinkCandidate[] {
    return this.opts.candidates().map((row) => {
      const diag = this.diagByUrl.get(normalizeUplinkEndpointUrl(row.publicUrl));
      return {
        ...row,
        lastError: diag?.lastError ?? row.lastError ?? null,
        lastErrorAt: diag?.lastErrorAt ?? row.lastErrorAt ?? null,
        lastAttemptAt: diag?.lastAttemptAt ?? row.lastAttemptAt ?? null,
        rttMs: diag?.rttMs ?? row.rttMs ?? null,
        rttAt: diag?.rttAt ?? row.rttAt ?? null,
      };
    });
  }

  currentGeneration(): number {
    return this.generation;
  }

  liveClient(): PooledUplink | null {
    return this.live;
  }

  onAttached(cb: (uplink: AttachedUplink) => void): () => void {
    this.attachedListeners.push(cb);
    return () => {
      const idx = this.attachedListeners.indexOf(cb);
      if (idx >= 0) this.attachedListeners.splice(idx, 1);
    };
  }

  onDetached(cb: () => void): () => void {
    this.detachedListeners.push(cb);
    return () => {
      const idx = this.detachedListeners.indexOf(cb);
      if (idx >= 0) this.detachedListeners.splice(idx, 1);
    };
  }

  onNodeList(cb: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void): () => void {
    this.nodeListListeners.push(cb);
    return () => {
      const idx = this.nodeListListeners.indexOf(cb);
      if (idx >= 0) this.nodeListListeners.splice(idx, 1);
    };
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayDrain.setHandler(handler);
    const live = this.live;
    if (live) this.relayDrain.bind(live, () => this.live === live);
  }

  start(_connectOnce?: (signal: AbortSignal) => Promise<void>): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    this.loop = this.run(this.stopAbort.signal);
  }

  async connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void> {
    const client = this.requireLive();
    await client.connectWithLink(link, signal);
  }

  async stop(): Promise<void> {
    this.dialCoordinator.dropOwner(this);
    this.stopAbort?.abort();
    this.stopAbort = null;
    this.stopProbe();
    this.stopRttProbe();
    this.cancelFailbackDebounce();
    this.failbackCoalesced = false;
    const live = this.live;
    const pending = this.pending;
    this.live = null;
    this.pending = null;
    if (this.attached) {
      this.attached = null;
      this.emitDetached();
    }
    this.unbindLiveState();
    const loop = this.loop;
    this.loop = null;
    await pending?.stop();
    await live?.stop();
    await this.relayDrain.waitForRetiring();
    try {
      if (loop) await loop;
    } catch {
      /* cancelled */
    }
    this.emitState('offline');
  }

  sendCtl(msg: UplinkCtlMessage): void {
    this.requireLive().sendCtl(msg);
  }

  sendStatus(): void {
    this.live?.sendStatus();
  }

  sendStatusIfChanged(): boolean {
    return this.live?.sendStatusIfChanged() ?? false;
  }

  async openRelay(toNodeId: string): Promise<LinkStream> {
    const client = this.requireLive();
    return this.relayDrain.open(client, toNodeId, () => this.live === client);
  }

  relayStreamsInFlight(): number {
    return this.relayDrain.total(this.live);
  }

  waitForRelayStreamsToDrain(): Promise<void> {
    return this.relayDrain.waitForAll(() => this.live, this.stopAbort?.signal);
  }
  waitForLiveRelayDrain(reason: UplinkRelayDrainReason): Promise<void> {
    if (!this.live) return Promise.resolve();
    return this.relayDrain.waitForClient(this.live, reason, this.stopAbort?.signal);
  }
  queryKeyLogHead() {
    return this.requireLive().queryKeyLogHead();
  }

  queryKeyLogAt(seq: bigint, timeoutMs?: number) {
    return this.requireLive().queryKeyLogAt(seq, timeoutMs);
  }

  appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs?: number,
    generation?: number
  ) {
    return this.requireLive().appendAndAck(record, timeoutMs, generation);
  }

  requestProbeNow(): void {
    this.scheduleProbe(this.probeNowDebounceMs);
  }

  async switchTo(publicUrl: string, signal?: AbortSignal): Promise<UplinkSwitchResult> {
    return runUplinkSwitch(this, publicUrl, signal);
  }

  stopSignal(): AbortSignal | null {
    return this.stopAbort?.signal ?? null;
  }

  private requireLive(): PooledUplink {
    const live = this.live;
    if (!live) throw new Error('uplink is not online');
    return live;
  }

  private async sleepWrap(signal: AbortSignal, ms: number): Promise<'stop' | 'wake'> {
    this.wrapSleepAbort = new AbortController();
    const combined = combineAbortSignals(signal, this.wrapSleepAbort.signal);
    try {
      await this.scheduler.sleep(ms, combined);
      return 'wake';
    } catch {
      return signal.aborted ? 'stop' : 'wake';
    } finally {
      this.wrapSleepAbort = null;
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    this.syncRttProbe();
    while (!signal.aborted) {
      const cands = this.candidates();
      if (cands.length === 0) {
        if ((await this.sleepWrap(signal, UPLINK_BACKOFF_MAX_MS)) === 'stop') return;
        continue;
      }
      const session = await this.tryCandidates(cands, signal);
      if (signal.aborted) return;
      if (session) {
        this.wrapAttempt = 0;
        if (
          (await sleepAfterUplinkSession(this.scheduler, signal, this.lastSessionReason)) === 'stop'
        )
          return;
        continue;
      }
      const delay = backoffDelayMs(this.wrapAttempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
      this.wrapAttempt += 1;
      if ((await this.sleepWrap(signal, delay)) === 'stop') return;
    }
  }

  private async tryCandidates(cands: UplinkCandidate[], signal: AbortSignal): Promise<boolean> {
    const { ready, cooling } = this.splitCooledCandidates(cands);
    if (ready.length === 0 && cooling.length > 0) {
      const wait = this.msUntilCooldownExpiry(cooling);
      if (wait > 0 && (await this.sleepWrap(signal, wait)) === 'stop') return false;
      return this.dialCandidateQueue(cooling, signal);
    }
    return this.dialCandidateQueue(ready, signal);
  }

  private async dialCandidateQueue(
    cands: UplinkCandidate[],
    signal: AbortSignal
  ): Promise<boolean> {
    if (cands[0]) this.lastDialUrl = cands[0].publicUrl;
    for (let i = 0; i < cands.length; i += 1) {
      const cand = cands[i];
      if (!cand || signal.aborted) return false;
      if (await this.tryCandidate(cand, signal, i, cands.length)) return true;
      const next = cands[i + 1];
      if (next) {
        this.logCandidateEvent(next, i + 1, 'ws', this.lastErrorOf(next), 'failover');
      }
    }
    return false;
  }

  beginSwitch(): number {
    this.switchToken += 1;
    const stale = this.pending;
    this.pending = null;
    if (stale && stale !== this.live) void stale.stop();
    return this.switchToken;
  }

  isSwitchCurrent(token: number): boolean {
    return token === this.switchToken && !this.stopAbort?.signal.aborted;
  }

  async connectCandidate(
    client: PooledUplink,
    _cand: UplinkCandidate,
    signal: AbortSignal
  ): Promise<void> {
    await client.attemptConnect(signal);
  }

  private async tryCandidate(
    cand: UplinkCandidate,
    signal: AbortSignal,
    index = 0,
    total = 1
  ): Promise<boolean> {
    const acquired = this.acquireCandidateClient(cand);
    if (!acquired) return false;
    const deadline = new AbortController();
    const combined = combineAbortSignals(signal, deadline.signal) ?? deadline.signal;
    const deadlineStarted = this.scheduler.now();
    const sleeper = this.scheduler.sleep(this.authDeadlineMs, deadline.signal).then(
      () => {
        if (this.scheduler.now() - deadlineStarted < this.authDeadlineMs) return;
        if (!deadline.signal.aborted) deadline.abort();
      },
      () => {}
    );
    const token = this.beginSwitch();
    const { client } = acquired;
    this.pending = client;
    this.noteAttempt(cand);
    this.logCandidateEvent(cand, index, 'ws', this.lastErrorOf(cand), 'try', { total });
    try {
      const ok = await this.establishAcquiredCandidate(client, cand, {
        borrowed: acquired.borrowed,
        combined,
        token,
        signal,
        deadline,
        index,
      });
      if (!ok) this.coolAbandonedCandidate(cand, deadline.signal, signal);
      return ok;
    } finally {
      deadline.abort();
      await sleeper.catch(() => {});
      if (this.pending === client) this.pending = null;
      if (this.live === client) {
        this.persistTerminalError(client, cand.publicUrl);
        this.clearLive(client);
      }
      if (this.live !== client) {
        this.dialCoordinator.release(cand.publicUrl, this);
        try {
          await client.stop();
        } catch {
          /* ignore */
        }
      }
    }
  }

  private noteCandidateFailure(
    cand: UplinkCandidate,
    err: unknown,
    failures: number,
    index: number,
    transport: string
  ): void {
    const msg = errMessage(err);
    this.lastConnectError = { reason: msg, at: this.scheduler.now() };
    this.noteFailure(cand, msg);
    this.logCandidateFailed(cand, msg, failures, index, transport);
  }

  private acquireCandidateClient(
    cand: UplinkCandidate
  ): { client: PooledUplink; borrowed: boolean } | null {
    const taken = this.dialCoordinator.takeOnline(cand.publicUrl);
    if (taken) {
      this.dialCoordinator.tryClaim(cand.publicUrl, this);
      return { client: taken, borrowed: true };
    }
    if (!this.dialCoordinator.tryClaim(cand.publicUrl, this)) return null;
    return { client: this.spawn(cand), borrowed: false };
  }

  private async establishAcquiredCandidate(
    client: PooledUplink,
    cand: UplinkCandidate,
    ctx: {
      borrowed: boolean;
      combined: AbortSignal;
      token: number;
      signal: AbortSignal;
      deadline: AbortController;
      index: number;
    }
  ): Promise<boolean> {
    if (ctx.borrowed && client.state === 'online') {
      return this.promoteEstablished(client, cand, ctx);
    }
    let failures = 0;
    while (failures < this.failLimit && !ctx.combined.aborted) {
      try {
        await this.connectCandidate(client, cand, ctx.combined);
        return await this.promoteEstablished(client, cand, ctx);
      } catch (err) {
        if (!this.isSwitchCurrent(ctx.token)) return await this.followLiveSession(ctx.signal);
        failures += 1;
        this.noteCandidateFailure(cand, err, failures, ctx.index, 'ws');
        if (ctx.combined.aborted || failures >= this.failLimit) break;
      }
    }
    return false;
  }

  private async promoteEstablished(
    client: PooledUplink,
    cand: UplinkCandidate,
    ctx: { token: number; signal: AbortSignal; deadline: AbortController }
  ): Promise<boolean> {
    if (!this.isSwitchCurrent(ctx.token)) return await this.followLiveSession(ctx.signal);
    ctx.deadline.abort();
    await this.promote(client, cand, ctx.token);
    await this.rememberSessionEnd(client, ctx.signal);
    return true;
  }

  private splitCooledCandidates(cands: UplinkCandidate[]): {
    ready: UplinkCandidate[];
    cooling: UplinkCandidate[];
  } {
    const now = this.scheduler.now();
    const ready: UplinkCandidate[] = [];
    const cooling: UplinkCandidate[] = [];
    for (const cand of cands) {
      if (this.cooldownUntil(cand.publicUrl) > now) cooling.push(cand);
      else ready.push(cand);
    }
    return { ready, cooling };
  }

  private msUntilCooldownExpiry(cands: UplinkCandidate[]): number {
    const now = this.scheduler.now();
    let until = Number.POSITIVE_INFINITY;
    for (const cand of cands) {
      const at = this.cooldownUntil(cand.publicUrl);
      if (at < until) until = at;
    }
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, until - now);
  }

  private cooldownUntil(publicUrl: string): number {
    return this.coolByUrl.get(normalizeUplinkEndpointUrl(publicUrl))?.until ?? 0;
  }

  private coolAbandonedCandidate(
    cand: UplinkCandidate,
    deadline: AbortSignal,
    parent: AbortSignal
  ): void {
    const reason =
      deadline.aborted && !parent.aborted ? 'connect-timeout' : (this.lastErrorOf(cand) ?? '');
    if (!isUplinkConnectCoolable(reason)) return;
    const key = normalizeUplinkEndpointUrl(cand.publicUrl);
    const fails = (this.coolByUrl.get(key)?.fails ?? 0) + 1;
    this.coolByUrl.set(key, {
      until: this.scheduler.now() + uplinkCandidateCooldownMs(fails),
      fails,
    });
  }

  spawn(cand: UplinkCandidate): PooledUplink {
    const tlsCa = this.tlsCaFor(cand.publicUrl);
    const wsFactory = this.opts.wsFactory ?? defaultWsFactory(tlsCa);
    const client = this.createClient({
      uplinkUrl: cand.publicUrl,
      identity: this.opts.identity,
      userId: this.userIdOf,
      keyLogApplier: this.opts.keyLogApplier,
      userStore: this.opts.userStore,
      statusProvider: this.opts.statusProvider,
      wsFactory,
      tlsCa,
      scheduler: this.scheduler,
      pingIntervalMs: this.opts.pingIntervalMs,
      onNodeList: (list) => this.dispatchNodeList(client, list, cand.uplinkNodeId),
      onRtcSignal: (msg) => {
        if (this.live !== client) return;
        this.opts.onRtcSignal?.(msg);
      },
      onEnrollRedeemed: (msg) => {
        if (this.live !== client) return;
        this.opts.onEnrollRedeemed?.(msg);
      },
      onKeyLogFork: (event) => {
        if (this.live !== client) return;
        this.opts.onKeyLogFork?.(event);
      },
    });
    return client;
  }

  async promote(client: PooledUplink, cand: UplinkCandidate, token: number): Promise<void> {
    if (!this.isSwitchCurrent(token)) {
      await client.stop();
      return;
    }
    const old = this.live !== client ? this.live : null;
    this.generation += 1;
    this.pending = null;
    this.live = client;
    this.bindLiveState(client);
    this.relayDrain.bind(client, () => this.live === client);
    this.attached = {
      publicUrl: cand.publicUrl,
      since: this.scheduler.now(),
    };
    this.emitAttached(this.attached);
    this.emitState(client.state);
    this.noteSuccess(cand);
    client.sendStatusIfChanged();
    this.syncProbe();
    this.syncRttProbe();
    if (old) this.retireClient(old);
  }

  private retireClient(client: PooledUplink): void {
    this.relayDrain.retire(client, this.stopAbort?.signal);
  }

  private dispatchNodeList(
    client: PooledUplink,
    list: UplinkNodeList,
    uplinkNodeId: string | null
  ): void {
    if (this.live !== client) return;
    this.opts.onNodeList?.(list, {
      uplinkNodeId,
      generation: this.generation,
    });
    const meta = {
      uplinkNodeId,
      generation: this.generation,
    };
    for (const cb of this.nodeListListeners) {
      try {
        cb(list, meta);
      } catch {
        /* listener errors must not break the pool */
      }
    }
    this.syncProbe();
    this.syncRttProbe();
  }

  private async followLiveSession(signal: AbortSignal): Promise<boolean> {
    if (this.live?.state !== 'online') return false;
    await this.waitActiveSession(this.live, signal);
    return true;
  }

  private async waitActiveSession(
    origin: PooledUplink,
    signal: AbortSignal
  ): Promise<{ publicUrl: string; reason: string } | null> {
    let current = origin;
    let ended: { publicUrl: string; reason: string } | null = null;
    while (this.live && !signal.aborted) {
      current = this.live;
      await this.waitWhileLive(current, signal);
      const reason = terminalErrorOf(current);
      if (reason) {
        this.persistTerminalError(current, current.uplinkUrl);
        ended = { publicUrl: current.uplinkUrl, reason };
      }
      if (this.live === current) break;
    }
    return ended;
  }

  private async rememberSessionEnd(client: PooledUplink, signal: AbortSignal): Promise<void> {
    this.lastSessionReason =
      (await this.waitActiveSession(this.live ?? client, signal))?.reason ?? '';
  }
  private persistTerminalError(client: PooledUplink, publicUrl: string): void {
    const reason = terminalErrorOf(client);
    if (!reason || isUplinkPathRerace(reason)) return;
    this.noteFailure({ publicUrl }, reason);
  }
  private async waitWhileLive(client: PooledUplink, signal: AbortSignal): Promise<void> {
    if (this.live !== client || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const off = client.onStateChange((state) => {
        if (state === 'offline' || this.live !== client) finish();
      });
      if (signal.aborted || this.live !== client || client.state === 'offline') {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
      void client.waitUntilClosed(signal).then(finish);
    });
  }

  private clearLive(client: PooledUplink): void {
    if (this.live !== client) return;
    this.live = null;
    this.unbindLiveState();
    this.stopProbe();
    if (this.attached) {
      this.attached = null;
      this.emitDetached();
    }
    this.emitState('offline');
  }

  private bindLiveState(client: PooledUplink): void {
    this.unbindLiveState();
    this.liveStateOff = client.onStateChange((state) => {
      if (this.live === client) this.emitState(state);
    });
  }

  private unbindLiveState(): void {
    this.liveStateOff?.();
    this.liveStateOff = null;
  }

  private syncProbe(): void {
    this.stopProbe();
    const attached = this.attached;
    if (!attached) return;
    const idx = this.candidates().findIndex((row) =>
      sameUplinkUrl(row.publicUrl, attached.publicUrl)
    );
    if (idx <= 0) return;
    this.probe = this.scheduler.interval(
      () => {
        void this.probePreferred();
      },
      jitteredIntervalMs(this.probeIntervalMs, this.probeJitter)
    );
  }

  private stopProbe(): void {
    this.probe?.clear();
    this.probe = null;
  }

  private periodicRttEnabled(): boolean {
    return this.opts.enablePeriodicRttProbe ?? process.env.NODE_ENV !== 'test';
  }

  private syncRttProbe(): void {
    if (!this.periodicRttEnabled() || this.candidates().length < 2) {
      this.stopRttProbe();
      return;
    }
    if (this.rttProbe) return;
    this.rttProbe = this.scheduler.interval(
      () => {
        void this.probeAllCandidateRtts();
      },
      jitteredIntervalMs(this.rttProbeIntervalMs, this.probeJitter)
    );
  }

  private stopRttProbe(): void {
    this.rttProbe?.clear();
    this.rttProbe = null;
  }

  private async probeAllCandidateRtts(): Promise<void> {
    if (this.rttProbeInFlight) return;
    this.rttProbeInFlight = true;
    try {
      const cands = this.candidates();
      if (cands.length < 2) return;
      for (const cand of cands) {
        if (this.stopAbort?.signal.aborted) return;
        await this.probeHealthzTimed(cand.publicUrl);
      }
    } finally {
      this.rttProbeInFlight = false;
    }
  }

  private probeDelayRemaining(debounceMs: number): number {
    if (this.lastFailbackProbeAt <= 0) return 0;
    return Math.max(0, debounceMs - (this.scheduler.now() - this.lastFailbackProbeAt));
  }

  private cancelFailbackDebounce(): void {
    this.failbackDebounceAbort?.abort();
    this.failbackDebounceAbort = null;
    this.failbackProbeDeadlineAt = 0;
  }

  private noteProbeCoalesce(debounceMs: number): void {
    this.failbackCoalesced = true;
    this.coalescedDebounceMs = Math.min(this.coalescedDebounceMs, debounceMs);
  }

  private scheduleProbe(debounceMs: number): void {
    if (this.probeInFlight) {
      this.noteProbeCoalesce(debounceMs);
      return;
    }
    const now = this.scheduler.now();
    const delay = this.probeDelayRemaining(debounceMs);
    const deadline = now + delay;
    if (this.failbackDebounceAbort) {
      if (deadline >= this.failbackProbeDeadlineAt) return;
      this.cancelFailbackDebounce();
    }
    if (delay <= 0) {
      this.failbackProbeDeadlineAt = 0;
      void this.runFailbackProbe();
      return;
    }
    const ac = new AbortController();
    this.failbackDebounceAbort = ac;
    this.failbackProbeDeadlineAt = deadline;
    const stop = this.stopAbort?.signal;
    const combined = combineAbortSignals(stop, ac.signal) ?? ac.signal;
    void this.scheduler.sleep(delay, combined).then(
      () => {
        if (this.failbackDebounceAbort !== ac) return;
        this.failbackDebounceAbort = null;
        this.failbackProbeDeadlineAt = 0;
        void this.runFailbackProbe();
      },
      () => {
        if (this.failbackDebounceAbort !== ac) return;
        this.failbackDebounceAbort = null;
        this.failbackProbeDeadlineAt = 0;
      }
    );
  }

  private async runFailbackProbe(): Promise<void> {
    if (this.probeInFlight) {
      this.noteProbeCoalesce(this.failbackDebounceMs);
      return;
    }
    this.lastFailbackProbeAt = this.scheduler.now();
    await this.probePreferred();
  }

  private async probePreferred(): Promise<void> {
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      await runPreferredProbe({
        attachedUplink: () => this.attached,
        liveClient: () => this.live,
        candidates: () => this.candidates(),
        stopProbe: () => this.stopProbe(),
        probeHealthz: (url) => this.probeHealthzTimed(url),
        drainCount: (client) => this.relayDrain.inFlight(client),
        waitDrain: (client) =>
          this.relayDrain.waitForClient(client, 'switch-back', this.stopAbort?.signal),
        switchTo: (url) => this.switchTo(url),
        log: (line) => this.logInfo(line),
        lastErrorOf: (cand) => this.lastErrorOf(cand),
        logSwitchBack: (pref, i) => {
          this.logCandidateEvent(pref, i, 'ws', this.lastErrorOf(pref), 'switch-back');
        },
        now: () => this.scheduler.now(),
        probeLogAt: this.probeLogAt,
      });
    } finally {
      this.probeInFlight = false;
      if (this.failbackCoalesced) {
        this.failbackCoalesced = false;
        const debounce = this.coalescedDebounceMs;
        this.coalescedDebounceMs = this.failbackDebounceMs;
        this.scheduleProbe(debounce);
      }
    }
  }

  private tlsCaFor(publicUrl: string): string[] | null {
    try {
      const pin = this.opts.caPins.get(publicUrl);
      return pin?.caPem ? [pin.caPem] : null;
    } catch {
      return null;
    }
  }

  private async probeHealthzTimed(publicUrl: string): Promise<boolean> {
    if (this.stopAbort?.signal.aborted) return false;
    const probe = this.opts.probeHealthz ?? defaultProbeHealthz;
    const started = performance.now();
    let ok = false;
    try {
      ok = await probe(publicUrl, this.tlsCaFor(publicUrl), this.probeTimeoutMs);
    } catch {
      ok = false;
    }
    if (this.stopAbort?.signal.aborted) return false;
    if (ok) {
      this.noteRtt(publicUrl, Math.max(0, Math.round(performance.now() - started)));
    } else {
      this.patchDiag(publicUrl, { rttMs: null, rttAt: null, rttSamples: 0 });
    }
    return ok;
  }

  private patchDiag(publicUrl: string, patch: Partial<UrlDiag>): void {
    const key = normalizeUplinkEndpointUrl(publicUrl);
    this.diagByUrl.set(key, mergeUplinkDiag(this.diagByUrl.get(key) ?? emptyUplinkDiag(), patch));
  }

  private noteRtt(publicUrl: string, rttMs: number): void {
    const prev = this.diagByUrl.get(normalizeUplinkEndpointUrl(publicUrl)) ?? emptyUplinkDiag();
    const samples = prev.rttSamples + 1;
    const ewma =
      samples === 1 || prev.rttMs == null
        ? rttMs
        : Math.round(UPLINK_RTT_EWMA_ALPHA * rttMs + (1 - UPLINK_RTT_EWMA_ALPHA) * prev.rttMs);
    this.patchDiag(publicUrl, { rttMs: ewma, rttAt: this.scheduler.now(), rttSamples: samples });
  }

  noteAttempt(cand: UplinkCandidate): void {
    this.lastDialUrl = cand.publicUrl;
    this.patchDiag(cand.publicUrl, { lastAttemptAt: this.scheduler.now() });
  }

  noteFailure(cand: Pick<UplinkCandidate, 'publicUrl'>, msg: string): void {
    const at = this.scheduler.now();
    this.patchDiag(cand.publicUrl, { lastError: msg, lastErrorAt: at, lastAttemptAt: at });
  }

  private noteSuccess(cand: UplinkCandidate): void {
    this.lastConnectError = null;
    this.coolByUrl.delete(normalizeUplinkEndpointUrl(cand.publicUrl));
    this.patchDiag(cand.publicUrl, { lastError: null, lastErrorAt: null });
  }

  lastErrorOf(cand: UplinkCandidate): string | null {
    return this.diagByUrl.get(normalizeUplinkEndpointUrl(cand.publicUrl))?.lastError ?? null;
  }

  logCandidateFailed(
    cand: UplinkCandidate,
    msg: string,
    fails: number,
    index: number,
    transport: string
  ): void {
    this.logCandidateEvent(cand, index, transport, msg, 'failed', { fails });
  }

  logCandidateEvent(
    cand: UplinkCandidate,
    index: number,
    transport: string,
    error: string | null,
    kind: 'try' | 'failover' | 'switch-back' | 'failed',
    extra?: { fails?: number; total?: number }
  ): void {
    const origin = redactUrl(cand.publicUrl);
    const key = `${normalizeUplinkEndpointUrl(cand.publicUrl)}\0${kind}`;
    const now = this.scheduler.now();
    const stateError = kind === 'failed' ? error : null;
    const prev = this.candLogAt.get(key);
    if (
      prev &&
      prev.index === index &&
      prev.error === stateError &&
      prev.transport === transport &&
      now - prev.at < UPLINK_POOL_FAIL_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.candLogAt.set(key, { index, error: stateError, transport, at: now });
    if (kind === 'try') {
      this.logInfo(
        `[uplink] try url=${origin} idx=${index + 1}/${extra?.total ?? this.candidates().length} transport=${transport}`
      );
      return;
    }
    if (kind === 'failover') {
      this.logInfo(`[uplink] failover → url=${origin}`);
      return;
    }
    if (kind === 'switch-back') {
      this.logInfo(`[uplink] switch-back → url=${origin}`);
      return;
    }
    this.logInfo(
      `[uplink] candidate failed url=${origin} err=${error ?? ''} fails=${extra?.fails ?? 1}`
    );
  }

  /** 网络指纹变了：候选轮次退避按旧网络算的，重置并叫醒等待中的重连（PeerManager 触发）。 */
  resetBackoff(): void {
    this.wrapAttempt = 0;
    this.coolByUrl.clear();
    this.wakeWrapSleep();
  }

  private wakeWrapSleep(): void {
    const wake = this.wrapSleepAbort;
    if (!wake || wake.signal.aborted) return;
    wake.abort();
  }

  private logInfo(line: string): void {
    console.info(stamp(line));
  }

  private emitState(state: UplinkState): void {
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        /* listener errors must not break the pool */
      }
    }
  }

  private emitAttached(uplink: AttachedUplink): void {
    for (const cb of this.attachedListeners) {
      try {
        cb(uplink);
      } catch {
        /* ignore */
      }
    }
  }

  private emitDetached(): void {
    for (const cb of this.detachedListeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWsFactory(tlsCa: string[] | null): UplinkWsFactory {
  return createDialWsFactory(tlsCa);
}
