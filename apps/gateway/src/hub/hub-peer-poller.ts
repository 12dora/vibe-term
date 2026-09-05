/**
 * Hub 间状态探测。对端 GET /api/hub/status 可信，当且仅当：
 * 1. URL 经 TLS 认证（HubTrustStore 的 per-URL CA pin；无 pin 的 https 走系统 CA）；
 * 2. 返回的 32-hex hubNodeId 在本机 TMEX_HUB_PEERS allowlist 中，且与 mesh_hubs 行 id 一致。
 * 未授权的 URL / id 不能 fencing 本机。
 */
import { errorMessage } from '@tmex/shared';
import type { HubAdvertisement, HubMode } from '@tmex/shared/uplink';
import type { HubTrustStore } from '../auth/hub-trust-store';
import { type MeshHubRecord, type MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import { uplinkWebSocketTls } from '../mesh/uplink-client';
import { jitteredIntervalMs, joinHubPath } from '../mesh/uplink-pool';

export const HUB_PEER_POLL_START_DELAY_MS = 2_000;
export const HUB_PEER_POLL_INTERVAL_MS = 60_000;
export const HUB_PEER_POLL_FAST_INTERVAL_MS = 3_000;
export const HUB_PEER_POLL_FAST_WINDOW_MS = 180_000;
export const HUB_PEER_POLL_TIMEOUT_MS = 5_000;
export const HUB_PEER_POLL_JITTER = 0.2;
export const HUB_PEER_POLL_IMMEDIATE_JITTER_MS = 500;
export const HUB_PEER_POLL_FAIL_LIMIT = 3;
export const HUB_PEER_TLS_LOG_INTERVAL_MS = 10 * 60 * 1000;

const HUB_NODE_ID_HEX = /^[0-9a-f]{32}$/i;

export type HubWriterView = {
  hubNodeId: string;
  writerEpoch: number;
  reachable: boolean;
  observedAt: number;
  receivedAt?: number;
};

export type HubPeerStatusBody = {
  hubNodeId: string;
  publicUrl: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  name?: string;
  caFingerprint?: string | null;
  writerView?: HubWriterView;
};

export type HubPeerFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type HubPeerPollerOptions = {
  meshHubs: MeshHubStore;
  selfHubId: () => string | undefined;
  isAuthorized: (hubNodeId: string) => boolean;
  applyStatus: (hubNodeId: string, ad: HubAdvertisement) => void;
  onChanged?: () => void;
  now?: () => number;
  fetch?: HubPeerFetch;
  hubTrust?: HubTrustStore;
  startDelayMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  jitter?: number;
  failLimit?: number;
  autoPromote?: boolean;
  autoPromoteTimeoutMs?: number;
  selfMode?: () => HubMode;
  selfPriority?: () => number;
  onAutoPromote?: (operationId: string) => void | Promise<void>;
  attachedHubId?: () => string | undefined;
  attachedEpoch?: () => number | null | undefined;
  selfWriterEpoch?: () => number;
  onWriterLearned?: () => void;
  fastIntervalMs?: number;
  fastWindowMs?: number;
  immediateJitterMs?: number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
};

export const HUB_AUTO_PROMOTE_TIMEOUT_DEFAULT_MS = 600_000;

export type AutoPromoteHub = {
  hubNodeId: string;
  mode: HubMode;
  priority: number;
  writerEpoch?: number;
};

export function lowestPriorityStandbyId(hubs: AutoPromoteHub[]): string | null {
  const standbys = hubs.filter((hub) => hub.mode === 'standby');
  if (standbys.length === 0) return null;
  standbys.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.hubNodeId < b.hubNodeId) return -1;
    if (a.hubNodeId > b.hubNodeId) return 1;
    return 0;
  });
  return standbys[0]?.hubNodeId ?? null;
}

export function shouldAutoPromote(input: {
  enabled: boolean;
  selfId: string;
  selfMode: HubMode;
  writerId: string | null;
  writerEpoch: number | null;
  writerUnreachableSince: number | null;
  now: number;
  timeoutMs: number;
  authorized: AutoPromoteHub[];
  peerWriterViews: ReadonlyMap<string, HubWriterView>;
  pollIntervalMs: number;
}): boolean {
  if (!input.enabled) return false;
  if (input.selfMode !== 'standby') return false;
  if (!input.writerId || input.writerId === input.selfId) return false;
  if (lowestPriorityStandbyId(input.authorized) !== input.selfId) return false;
  if (input.writerUnreachableSince == null) return false;
  if (input.now - input.writerUnreachableSince < input.timeoutMs) return false;
  const n = input.authorized.length;
  if (n < 2) return false;
  if (n === 2) return true;
  const others = input.authorized.filter(
    (hub) => hub.hubNodeId !== input.selfId && hub.hubNodeId !== input.writerId
  );
  if (others.length === 0) return false;
  const freshnessMs = 2 * input.pollIntervalMs;
  const unreachableVotes = others.filter((hub) => {
    const view = input.peerWriterViews.get(hub.hubNodeId);
    if (!view || view.reachable) return false;
    if (view.hubNodeId !== input.writerId) return false;
    if (input.writerEpoch == null || view.writerEpoch !== input.writerEpoch) return false;
    if (view.receivedAt == null) return false;
    return input.now - view.receivedAt <= freshnessMs;
  });
  return unreachableVotes.length > others.length / 2;
}

export function peerPollDelayMs(
  intervalMs = HUB_PEER_POLL_INTERVAL_MS,
  jitter = HUB_PEER_POLL_JITTER
): number {
  return jitteredIntervalMs(intervalMs, jitter);
}

export function stableImmediateJitterMs(
  seed: string,
  maxMs = HUB_PEER_POLL_IMMEDIATE_JITTER_MS
): number {
  if (maxMs <= 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (maxMs + 1);
}

export type FastPeerPollHub = {
  hubNodeId: string;
  mode: HubMode;
  writerEpoch?: number;
  priority?: number;
};

export function shouldFastPeerPoll(input: {
  selfMode: HubMode;
  selfId?: string;
  selfEpoch: number;
  attachedHubId?: string | null;
  now: number;
  fastWindowStartedAt: number;
  fastWindowMs: number;
  authorized: FastPeerPollHub[];
}): boolean {
  if (input.selfMode !== 'standby') return false;
  if (input.now - input.fastWindowStartedAt > input.fastWindowMs) return false;
  const self = input.selfId?.toLowerCase();
  const attached = input.attachedHubId?.toLowerCase() || null;
  if (!attached || (self && attached === self)) return true;
  const hasActiveAtLeastOurs = input.authorized.some(
    (hub) => hub.mode === 'active' && (hub.writerEpoch ?? 0) >= input.selfEpoch
  );
  if (!hasActiveAtLeastOurs) return true;
  const writerId = pickWriterHub(
    input.authorized.map((hub) => ({
      hubNodeId: hub.hubNodeId,
      mode: hub.mode,
      writerEpoch: hub.writerEpoch ?? 0,
      priority: hub.priority ?? 200,
    }))
  );
  return Boolean(writerId && attached !== writerId.toLowerCase());
}

export function shouldRequestUplinkProbe(input: {
  selfMode: HubMode;
  selfId?: string;
  selfEpoch: number;
  attachedHubId?: string | null;
  attachedEpoch: number;
  writerId: string | null;
  writerEpoch?: number;
  learnedActive: Array<{ hubNodeId: string; writerEpoch: number }>;
}): boolean {
  if (input.selfMode !== 'standby') return false;
  const minEpoch = Math.max(input.selfEpoch, input.attachedEpoch);
  const self = input.selfId?.toLowerCase();
  const qualifies = (id: string, epoch: number) => {
    if (self && id.toLowerCase() === self) return false;
    return epoch >= minEpoch;
  };
  if (input.learnedActive.some((hub) => qualifies(hub.hubNodeId, hub.writerEpoch))) return true;
  const attached = input.attachedHubId?.toLowerCase() || null;
  const writer = input.writerId?.toLowerCase() ?? null;
  if (self && attached === self && writer && writer !== self) {
    return qualifies(writer, input.writerEpoch ?? 0);
  }
  return false;
}

export class HubPeerPoller {
  private readonly meshHubs: MeshHubStore;
  private readonly selfHubId: () => string | undefined;
  private readonly isAuthorized: (hubNodeId: string) => boolean;
  private readonly applyStatus: (hubNodeId: string, ad: HubAdvertisement) => void;
  private readonly onChanged?: () => void;
  private readonly now: () => number;
  private readonly fetchImpl?: HubPeerFetch;
  private readonly hubTrust?: HubTrustStore;
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly jitter: number;
  private readonly failLimit: number;
  private readonly autoPromote: boolean;
  private readonly autoPromoteTimeoutMs: number;
  private readonly selfMode?: () => HubMode;
  private readonly selfPriority?: () => number;
  private readonly onAutoPromote?: (operationId: string) => void | Promise<void>;
  private attachedHubIdFn?: () => string | undefined;
  private attachedEpochFn?: () => number | null | undefined;
  private onWriterLearnedFn?: () => void;
  private readonly selfWriterEpoch?: () => number;
  private readonly fastIntervalMs: number;
  private readonly fastWindowMs: number;
  private readonly immediateJitterMs: number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (id: ReturnType<typeof setTimeout>) => void;
  private readonly failCounts = new Map<string, number>();
  private readonly lastTlsLogAt = new Map<string, number>();
  private readonly peerWriterViews = new Map<string, HubWriterView>();
  private writerView: HubWriterView | null = null;
  private writerUnreachableSince: number | null = null;
  private trackedWriterId: string | null = null;
  private trackedWriterEpoch: number | null = null;
  private autoPromoteInFlight = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private running = false;
  private fastWindowStartedAt = 0;
  private readonly stopAbort = new AbortController();

  constructor(opts: HubPeerPollerOptions) {
    this.meshHubs = opts.meshHubs;
    this.selfHubId = opts.selfHubId;
    this.isAuthorized = opts.isAuthorized;
    this.applyStatus = opts.applyStatus;
    this.onChanged = opts.onChanged;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch;
    this.hubTrust = opts.hubTrust;
    this.startDelayMs = opts.startDelayMs ?? HUB_PEER_POLL_START_DELAY_MS;
    this.intervalMs = opts.intervalMs ?? HUB_PEER_POLL_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? HUB_PEER_POLL_TIMEOUT_MS;
    this.jitter = opts.jitter ?? HUB_PEER_POLL_JITTER;
    this.failLimit = opts.failLimit ?? HUB_PEER_POLL_FAIL_LIMIT;
    this.autoPromote = opts.autoPromote ?? false;
    this.autoPromoteTimeoutMs = opts.autoPromoteTimeoutMs ?? HUB_AUTO_PROMOTE_TIMEOUT_DEFAULT_MS;
    this.selfMode = opts.selfMode;
    this.selfPriority = opts.selfPriority;
    this.onAutoPromote = opts.onAutoPromote;
    this.attachedHubIdFn = opts.attachedHubId;
    this.attachedEpochFn = opts.attachedEpoch;
    this.onWriterLearnedFn = opts.onWriterLearned;
    this.selfWriterEpoch = opts.selfWriterEpoch;
    this.fastIntervalMs = opts.fastIntervalMs ?? HUB_PEER_POLL_FAST_INTERVAL_MS;
    this.fastWindowMs = opts.fastWindowMs ?? HUB_PEER_POLL_FAST_WINDOW_MS;
    this.immediateJitterMs =
      opts.immediateJitterMs ??
      stableImmediateJitterMs(opts.selfHubId?.() ?? '', HUB_PEER_POLL_IMMEDIATE_JITTER_MS);
    this.setTimeoutImpl = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = opts.clearTimeout ?? ((id) => clearTimeout(id));
  }

  setDiscoveryHooks(hooks: {
    attachedHubId?: () => string | undefined;
    attachedEpoch?: () => number | null | undefined;
    onWriterLearned?: () => void;
  }): void {
    if (hooks.attachedHubId) this.attachedHubIdFn = hooks.attachedHubId;
    if (hooks.attachedEpoch) this.attachedEpochFn = hooks.attachedEpoch;
    if (hooks.onWriterLearned) this.onWriterLearnedFn = hooks.onWriterLearned;
  }

  localWriterView(): HubWriterView | null {
    return this.writerView;
  }

  start(): void {
    if (this.stopped || this.running) return;
    this.running = true;
    this.fastWindowStartedAt = this.now();
    this.beginPolling(this.startDelayMs);
  }

  noteRoleTransition(): void {
    if (this.stopped) return;
    this.fastWindowStartedAt = this.now();
    this.clearTimers();
    this.pollSoon();
  }

  refreshCadence(): void {
    if (this.stopped || !this.running) return;
    this.clearTimers();
    if (this.inFlight) {
      if (this.inFastPoll()) this.dirty = true;
      return;
    }
    if (this.inFastPoll()) this.pollSoon();
    else this.armInterval();
  }

  scheduleImmediatePoll(): void {
    if (this.stopped) return;
    this.pollSoon();
  }

  inFastPoll(): boolean {
    try {
      return shouldFastPeerPoll(this.fastPollInput());
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.dirty = false;
    if (!this.stopAbort.signal.aborted) this.stopAbort.abort();
    this.clearTimers();
  }

  pollNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    this.clearIntervalTimer();
    const run = this.runLoop();
    this.inFlight = run;
    return run;
  }

  private async runLoop(): Promise<void> {
    try {
      do {
        this.dirty = false;
        if (this.stopped) return;
        await this.pollAll();
      } while (this.dirty && !this.stopped);
    } catch {
      /* db closed after mesh.stop without hub.stop */
    } finally {
      this.inFlight = null;
      if (this.running && !this.stopped) this.armInterval();
    }
  }

  private beginPolling(delayMs: number): void {
    const wait = delayMs > 0 ? delayMs : this.immediateJitterMs;
    const begin = () => {
      this.startTimer = null;
      if (this.stopped) return;
      void this.pollNow();
    };
    if (wait <= 0) {
      begin();
      return;
    }
    this.startTimer = this.setTimeoutImpl(begin, wait);
    unrefTimer(this.startTimer);
  }

  private pollSoon(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (this.startTimer) {
      this.clearTimeoutImpl(this.startTimer);
      this.startTimer = null;
    }
    const delay = this.immediateJitterMs;
    if (delay <= 0) {
      void this.pollNow();
      return;
    }
    this.startTimer = this.setTimeoutImpl(() => {
      this.startTimer = null;
      if (this.stopped) return;
      void this.pollNow();
    }, delay);
    unrefTimer(this.startTimer);
  }

  private clearIntervalTimer(): void {
    if (!this.intervalTimer) return;
    this.clearTimeoutImpl(this.intervalTimer);
    this.intervalTimer = null;
  }

  private clearTimers(): void {
    if (this.startTimer) {
      this.clearTimeoutImpl(this.startTimer);
      this.startTimer = null;
    }
    this.clearIntervalTimer();
  }

  private armInterval(): void {
    if (this.stopped || !this.running) return;
    this.clearIntervalTimer();
    this.intervalTimer = this.setTimeoutImpl(
      () => {
        this.intervalTimer = null;
        if (this.stopped) return;
        void this.pollNow();
      },
      peerPollDelayMs(this.nextPollIntervalMs(), this.jitter)
    );
    unrefTimer(this.intervalTimer);
  }

  private nextPollIntervalMs(): number {
    return this.inFastPoll() ? this.fastIntervalMs : this.intervalMs;
  }

  private localSelfEpoch(): number {
    if (this.selfWriterEpoch) return this.selfWriterEpoch();
    const selfId = this.selfHubId();
    if (!selfId) return 1;
    try {
      return this.meshHubs.get(selfId)?.writerEpoch ?? 1;
    } catch {
      return 1;
    }
  }

  private fastPollInput() {
    return {
      selfMode: this.selfMode?.() ?? 'standby',
      selfId: this.selfHubId(),
      selfEpoch: this.localSelfEpoch(),
      attachedHubId: this.attachedHubIdFn?.(),
      now: this.now(),
      fastWindowStartedAt: this.fastWindowStartedAt,
      fastWindowMs: this.fastWindowMs,
      authorized: this.authorizedForPromote(),
    };
  }

  private peers(): MeshHubRecord[] {
    if (this.stopped) return [];
    try {
      const self = this.selfHubId()?.toLowerCase();
      return this.meshHubs.list().filter((row) => {
        const id = row.hubNodeId.toLowerCase();
        if (self && id === self) return false;
        if (!row.publicUrl) return false;
        return this.isAuthorized(id);
      });
    } catch {
      return [];
    }
  }

  private async pollAll(): Promise<void> {
    let changed = false;
    const learnedActive: Array<{ hubNodeId: string; writerEpoch: number }> = [];
    for (const row of this.peers()) {
      if (this.stopped) return;
      const result = await this.pollOne(row);
      if (!result) continue;
      changed = true;
      const rec = this.meshHubs.get(row.hubNodeId);
      if (rec?.mode === 'active') {
        learnedActive.push({ hubNodeId: rec.hubNodeId, writerEpoch: rec.writerEpoch });
      }
    }
    if (changed && !this.stopped) {
      try {
        this.onChanged?.();
      } catch {
        /* ignore */
      }
    }
    if (!this.stopped) this.maybeNotifyUplink(learnedActive);
    if (!this.stopped) await this.maybeAutoPromote();
  }

  private maybeNotifyUplink(
    learnedActive: Array<{ hubNodeId: string; writerEpoch: number }>
  ): void {
    if (!this.onWriterLearnedFn) return;
    const attachedHubId = this.attachedHubIdFn?.();
    const attachedEpoch = this.attachedEpochFn?.() ?? 0;
    const writerId = this.currentWriterId();
    const ok = shouldRequestUplinkProbe({
      selfMode: this.selfMode?.() ?? 'standby',
      selfId: this.selfHubId(),
      selfEpoch: this.localSelfEpoch(),
      attachedHubId,
      attachedEpoch,
      writerId,
      writerEpoch: writerId ? (this.meshHubs.get(writerId)?.writerEpoch ?? 0) : 0,
      learnedActive,
    });
    if (!ok) return;
    try {
      this.onWriterLearnedFn();
    } catch {
      /* ignore */
    }
  }

  private async pollOne(row: MeshHubRecord): Promise<boolean> {
    if (this.stopped) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    unrefTimer(timer);
    const onStop = () => ac.abort();
    this.stopAbort.signal.addEventListener('abort', onStop);
    if (this.stopAbort.signal.aborted) ac.abort();
    try {
      const res = await this.fetchStatus(row.publicUrl, ac.signal);
      if (this.stopped) return false;
      if (!res.ok) {
        return this.noteFailure(row, `http_${res.status}`);
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (err) {
        return this.noteFailure(row, err);
      }
      if (this.stopped) return false;
      const body = parsePeerStatusBody(raw);
      if (!body) return this.noteFailure(row, 'invalid_status_body');
      if (body.hubNodeId !== row.hubNodeId.toLowerCase()) {
        console.warn(
          `[hub] ignored peer status: hubNodeId mismatch url=${row.publicUrl} expected=${row.hubNodeId} got=${body.hubNodeId}`
        );
        return false;
      }
      this.failCounts.delete(row.hubNodeId);
      const ad: HubAdvertisement = {
        publicUrl: body.publicUrl,
        mode: body.mode,
        priority: body.priority,
        writerEpoch: body.writerEpoch,
      };
      if (body.caFingerprint !== undefined) ad.caFingerprint = body.caFingerprint;
      try {
        this.applyStatus(row.hubNodeId, ad);
      } catch {
        return false;
      }
      if (body.writerView) {
        this.peerWriterViews.set(row.hubNodeId, { ...body.writerView, receivedAt: this.now() });
      }
      this.noteWriterProbe(row.hubNodeId, true, body.writerEpoch);
      return true;
    } catch (err) {
      if (this.stopped) return false;
      return this.noteFailure(row, err);
    } finally {
      clearTimeout(timer);
      this.stopAbort.signal.removeEventListener('abort', onStop);
    }
  }

  private async fetchStatus(publicUrl: string, signal: AbortSignal): Promise<Response> {
    const url = joinHubPath(publicUrl, '/api/hub/status');
    const init: RequestInit = { method: 'GET', signal, redirect: 'error' };
    if (this.fetchImpl) return this.fetchImpl(url, init);
    let pinCa: string | null = null;
    try {
      pinCa = this.hubTrust?.get(publicUrl)?.caPem ?? null;
    } catch {
      pinCa = null;
    }
    const tls = uplinkWebSocketTls(pinCa ? [pinCa] : null);
    if (tls) Object.assign(init, tls);
    return fetch(url, init);
  }

  private noteFailure(row: MeshHubRecord, err: unknown): boolean {
    if (this.stopped) return false;
    if (isTlsError(err)) this.warnTls(row.publicUrl, err);
    this.noteWriterProbe(row.hubNodeId, false, row.writerEpoch);
    const next = (this.failCounts.get(row.hubNodeId) ?? 0) + 1;
    this.failCounts.set(row.hubNodeId, next);
    if (next < this.failLimit) return false;
    try {
      const existing = this.meshHubs.get(row.hubNodeId);
      if (!existing || !existing.online) return false;
      this.meshHubs.upsert({ ...existing, online: false }, this.now());
      return true;
    } catch {
      return false;
    }
  }

  private currentWriterId(): string | null {
    const recs = this.meshHubs.list().filter((row) => this.isAuthorized(row.hubNodeId));
    return pickWriterHub(recs);
  }

  private currentWriterEpoch(writerId: string | null): number | null {
    if (!writerId) return null;
    return this.meshHubs.get(writerId)?.writerEpoch ?? null;
  }

  private noteWriterProbe(hubNodeId: string, reachable: boolean, writerEpoch: number): void {
    const writerId = this.currentWriterId();
    if (!writerId || hubNodeId !== writerId) return;
    const epoch = this.currentWriterEpoch(writerId) ?? writerEpoch;
    if (this.trackedWriterId !== writerId || this.trackedWriterEpoch !== epoch) {
      this.trackedWriterId = writerId;
      this.trackedWriterEpoch = epoch;
      this.writerUnreachableSince = null;
    }
    const now = this.now();
    if (reachable) {
      this.writerUnreachableSince = null;
      this.writerView = {
        hubNodeId: writerId,
        writerEpoch: epoch,
        reachable: true,
        observedAt: now,
      };
      return;
    }
    if (this.writerUnreachableSince == null) this.writerUnreachableSince = now;
    this.writerView = {
      hubNodeId: writerId,
      writerEpoch: epoch,
      reachable: false,
      observedAt: now,
    };
  }

  private authorizedForPromote(): AutoPromoteHub[] {
    if (this.stopped) return [];
    const self = this.selfHubId()?.toLowerCase();
    const out: AutoPromoteHub[] = [];
    const seen = new Set<string>();
    let rows: MeshHubRecord[] = [];
    try {
      rows = this.meshHubs.list();
    } catch {
      return [];
    }
    for (const row of rows) {
      const id = row.hubNodeId.toLowerCase();
      if (!this.isAuthorized(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({
        hubNodeId: id,
        mode: row.mode,
        priority: row.priority,
        writerEpoch: row.writerEpoch,
      });
    }
    if (self && !seen.has(self) && this.isAuthorized(self)) {
      out.push({
        hubNodeId: self,
        mode: this.selfMode?.() ?? 'standby',
        priority: this.selfPriority?.() ?? 200,
        writerEpoch: this.selfWriterEpoch?.() ?? 1,
      });
    }
    return out;
  }

  private async maybeAutoPromote(): Promise<void> {
    if (this.autoPromoteInFlight || !this.autoPromote || !this.onAutoPromote) return;
    const self = this.selfHubId()?.toLowerCase();
    if (!self) return;
    const writerId = this.currentWriterId();
    const ok = shouldAutoPromote({
      enabled: true,
      selfId: self,
      selfMode: this.selfMode?.() ?? 'standby',
      writerId,
      writerEpoch: this.currentWriterEpoch(writerId),
      writerUnreachableSince: this.writerUnreachableSince,
      now: this.now(),
      timeoutMs: this.autoPromoteTimeoutMs,
      authorized: this.authorizedForPromote(),
      peerWriterViews: this.peerWriterViews,
      pollIntervalMs: this.intervalMs,
    });
    if (!ok) return;
    const operationId = `auto-${this.now()}`;
    this.autoPromoteInFlight = true;
    try {
      console.error(
        `[hub] auto-promote: writer unreachable for >=${this.autoPromoteTimeoutMs}ms; promoting self=${self} operationId=${operationId}`
      );
      await this.onAutoPromote(operationId);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[hub] auto-promote failed operationId=${operationId} err=${msg}`);
    } finally {
      this.autoPromoteInFlight = false;
    }
  }

  private warnTls(publicUrl: string, err: unknown): void {
    const now = this.now();
    const prev = this.lastTlsLogAt.get(publicUrl);
    if (prev !== undefined && now - prev < HUB_PEER_TLS_LOG_INTERVAL_MS) return;
    this.lastTlsLogAt.set(publicUrl, now);
    console.warn(`[hub] peer status TLS failed url=${publicUrl} err=${errorMessage(err)}`);
  }
}

function parsePeerStatusBody(raw: unknown): HubPeerStatusBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.hubNodeId !== 'string' || !HUB_NODE_ID_HEX.test(o.hubNodeId)) return null;
  if (typeof o.publicUrl !== 'string' || o.publicUrl.length === 0) return null;
  if (o.mode !== 'active' && o.mode !== 'standby') return null;
  if (typeof o.priority !== 'number' || !Number.isInteger(o.priority) || o.priority < 0) {
    return null;
  }
  if (typeof o.writerEpoch !== 'number' || !Number.isInteger(o.writerEpoch) || o.writerEpoch < 0) {
    return null;
  }
  const body: HubPeerStatusBody = {
    hubNodeId: o.hubNodeId.toLowerCase(),
    publicUrl: o.publicUrl,
    mode: o.mode,
    priority: o.priority,
    writerEpoch: o.writerEpoch,
  };
  if (typeof o.name === 'string' && o.name.trim()) body.name = o.name.trim();
  if (o.caFingerprint === null) body.caFingerprint = null;
  else if (typeof o.caFingerprint === 'string') body.caFingerprint = o.caFingerprint;
  const view = parseWriterView(o.writerView);
  if (view) body.writerView = view;
  return body;
}

function parseWriterView(raw: unknown): HubWriterView | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.hubNodeId !== 'string' || !HUB_NODE_ID_HEX.test(o.hubNodeId)) return undefined;
  if (typeof o.writerEpoch !== 'number' || !Number.isInteger(o.writerEpoch) || o.writerEpoch < 0) {
    return undefined;
  }
  if (typeof o.reachable !== 'boolean') return undefined;
  if (typeof o.observedAt !== 'number' || !Number.isFinite(o.observedAt)) return undefined;
  return {
    hubNodeId: o.hubNodeId.toLowerCase(),
    writerEpoch: o.writerEpoch,
    reachable: o.reachable,
    observedAt: o.observedAt,
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function isTlsError(err: unknown): boolean {
  const msg = errorMessage(err);
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const text = `${msg} ${code}`.toLowerCase();
  return (
    text.includes('tls') ||
    text.includes('cert') ||
    text.includes('ssl') ||
    text.includes('unable_to_verify') ||
    text.includes('err_tls')
  );
}
