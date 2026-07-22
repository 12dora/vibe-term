import type { PaneHistoryCursor } from './pane-history-reader';

export const DEFAULT_MAX_ACTIVE_PANES = 32;
export const DEFAULT_MAX_HOT_PANES = 8;
export const DEFAULT_ROUTE_GRACE_MS = 2_000;
export const DEFAULT_HOT_TTL_MS = 60_000;
export const DEFAULT_REPLAY_TTL_MS = 15_000;
export const DEFAULT_MAX_REPLAY_BYTES_PER_PANE = 2 * 1024 * 1024;
export const DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE = 512 * 1024;
export const DEFAULT_MAX_RETENTION_BYTES = 64 * 1024 * 1024;

export type PaneRetentionMode = 'active' | 'grace' | 'hot' | 'cold';
export type PaneSubscriptionRejectionReason = 'not_found' | 'resource_exhausted' | 'epoch_changed';
export type PaneReplayGapReason = 'pane_gap' | 'epoch_changed' | 'cache_evicted';

export interface PaneTerminalCursor {
  paneEpoch: Uint8Array;
  terminalSeq: bigint;
}

export interface PaneSubscriptionRequest {
  paneId: string;
  paneEpoch: Uint8Array;
  cursor: PaneTerminalCursor | null;
}

export interface PaneIdentity {
  paneId: string;
  paneEpoch: Uint8Array;
}

export interface PaneDataSegment extends PaneIdentity {
  seqStart: bigint;
  seqEnd: bigint;
  data: Uint8Array;
}

export interface PaneReplayGap extends PaneIdentity {
  reason: PaneReplayGapReason;
  expectedPaneEpoch: Uint8Array;
  expectedSeq: bigint;
  availableSeq: bigint;
}

export interface PaneReplayPlan extends PaneIdentity {
  segments: PaneDataSegment[];
  gap: PaneReplayGap | null;
  needsScreen: boolean;
}

export interface PaneSubscriptionRejection {
  paneId: string;
  paneEpoch: Uint8Array;
  reason: PaneSubscriptionRejectionReason;
}

export interface PaneSubscriptionApplyResult {
  generation: bigint;
  activePanes: PaneIdentity[];
  hotPanes: PaneIdentity[];
  rejected: PaneSubscriptionRejection[];
  replay: PaneReplayPlan[];
}

export interface PaneScreenCheckpoint extends PaneIdentity {
  baseSeq: bigint;
  rows: number;
  cols: number;
  modes: number;
  data: Uint8Array;
  historyCursor: PaneHistoryCursor | null;
  capturedAt: number;
}

export interface PaneHistoryPage extends PaneIdentity {
  seqStart: bigint;
  seqEnd: bigint;
  data: Uint8Array;
  nextCursor: PaneTerminalCursor | null;
  gap: PaneReplayGap | null;
}

export interface PaneRetentionStats {
  knownPanes: number;
  activePanes: number;
  gracePanes: number;
  hotPanes: number;
  coldPanes: number;
  replayBytes: number;
  checkpointBytes: number;
  retainedBytes: number;
  evictions: number;
  replayHits: number;
  replayMisses: number;
  rebases: number;
}

export interface PaneRetentionConsumerCallbacks {
  onData: (segment: PaneDataSegment) => void;
  onGap?: (gap: PaneReplayGap) => void;
}

export interface PaneRetentionOptions {
  maxActivePanes?: number;
  maxHotPanes?: number;
  routeGraceMs?: number;
  hotTtlMs?: number;
  replayTtlMs?: number;
  maxReplayBytesPerPane?: number;
  maxCheckpointBytesPerPane?: number;
  maxRetentionBytes?: number;
  now?: () => number;
  scheduleTimers?: boolean;
}

interface ReplayChunk {
  seqStart: bigint;
  seqEnd: bigint;
  data: Uint8Array;
  receivedAt: number;
}

interface PaneState {
  paneId: string;
  paneEpoch: Uint8Array;
  known: boolean;
  latestSeq: bigint;
  dirtyWhileCold: boolean;
  mode: PaneRetentionMode;
  explicitHot: boolean;
  graceUntil: number | null;
  hotUntil: number | null;
  lastTouchedAt: number;
  replay: ReplayChunk[];
  replayBytes: number;
  checkpoint: PaneScreenCheckpoint | null;
}

interface ConsumerState {
  id: number;
  callbacks: PaneRetentionConsumerCallbacks;
  generation: bigint | null;
  fingerprint: string | null;
  active: Map<string, PaneSubscriptionRequest>;
  hot: Map<string, PaneSubscriptionRequest>;
  closed: boolean;
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cloneIdentity(state: Pick<PaneState, 'paneId' | 'paneEpoch'>): PaneIdentity {
  return { paneId: state.paneId, paneEpoch: copyBytes(state.paneEpoch) };
}

function cloneRequest(request: PaneSubscriptionRequest): PaneSubscriptionRequest {
  return {
    paneId: request.paneId,
    paneEpoch: copyBytes(request.paneEpoch),
    cursor: request.cursor
      ? {
          paneEpoch: copyBytes(request.cursor.paneEpoch),
          terminalSeq: request.cursor.terminalSeq,
        }
      : null,
  };
}

function requestFingerprint(request: PaneSubscriptionRequest): string {
  const cursor = request.cursor
    ? `${bytesHex(request.cursor.paneEpoch)}:${request.cursor.terminalSeq}`
    : '-';
  return `${request.paneId}:${bytesHex(request.paneEpoch)}:${cursor}`;
}

function subscriptionFingerprint(
  active: readonly PaneSubscriptionRequest[],
  hot: readonly PaneSubscriptionRequest[]
): string {
  const activeParts = active.map(requestFingerprint).sort();
  const hotParts = hot.map(requestFingerprint).sort();
  return `a=${activeParts.join(',')}|h=${hotParts.join(',')}`;
}

function uniqueRequests(requests: readonly PaneSubscriptionRequest[]): PaneSubscriptionRequest[] {
  const result: PaneSubscriptionRequest[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.paneId)) continue;
    seen.add(request.paneId);
    result.push(request);
  }
  return result;
}

function safeCallback(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error('[tmux-client] pane retention consumer callback failed:', error);
  }
}

export class PaneSubscriptionGenerationConflictError extends Error {
  constructor(generation: bigint) {
    super(`subscription generation ${generation} was reused with different contents`);
    this.name = 'PaneSubscriptionGenerationConflictError';
  }
}

export class PaneRetentionConsumerLease {
  constructor(
    private readonly owner: PaneRetention,
    private readonly state: ConsumerState
  ) {}

  applySubscriptions(
    generation: bigint,
    activePanes: readonly PaneSubscriptionRequest[],
    hotPanes: readonly PaneSubscriptionRequest[]
  ): PaneSubscriptionApplyResult {
    return this.owner.applySubscriptions(this.state, generation, activePanes, hotPanes);
  }

  close(): void {
    this.owner.closeConsumer(this.state);
  }
}

export class PaneRetention {
  private readonly panes = new Map<string, PaneState>();
  private readonly consumers = new Map<number, ConsumerState>();
  private nextConsumerId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private evictions = 0;
  private replayHits = 0;
  private replayMisses = 0;
  private rebases = 0;

  readonly maxActivePanes: number;
  readonly maxHotPanes: number;
  readonly maxCheckpointBytesPerPane: number;

  private readonly routeGraceMs: number;
  private readonly hotTtlMs: number;
  private readonly replayTtlMs: number;
  private readonly maxReplayBytesPerPane: number;
  private readonly maxRetentionBytes: number;
  private readonly now: () => number;
  private readonly scheduleTimers: boolean;

  constructor(options: PaneRetentionOptions = {}) {
    this.maxActivePanes = options.maxActivePanes ?? DEFAULT_MAX_ACTIVE_PANES;
    this.maxHotPanes = options.maxHotPanes ?? DEFAULT_MAX_HOT_PANES;
    this.routeGraceMs = options.routeGraceMs ?? DEFAULT_ROUTE_GRACE_MS;
    this.hotTtlMs = options.hotTtlMs ?? DEFAULT_HOT_TTL_MS;
    this.replayTtlMs = options.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS;
    this.maxReplayBytesPerPane = options.maxReplayBytesPerPane ?? DEFAULT_MAX_REPLAY_BYTES_PER_PANE;
    this.maxCheckpointBytesPerPane =
      options.maxCheckpointBytesPerPane ?? DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE;
    this.maxRetentionBytes = options.maxRetentionBytes ?? DEFAULT_MAX_RETENTION_BYTES;
    this.now = options.now ?? Date.now;
    this.scheduleTimers = options.scheduleTimers ?? true;
  }

  attachConsumer(callbacks: PaneRetentionConsumerCallbacks): PaneRetentionConsumerLease {
    if (this.disposed) throw new Error('pane retention is disposed');
    const state: ConsumerState = {
      id: this.nextConsumerId++,
      callbacks,
      generation: null,
      fingerprint: null,
      active: new Map(),
      hot: new Map(),
      closed: false,
    };
    this.consumers.set(state.id, state);
    return new PaneRetentionConsumerLease(this, state);
  }

  reconcilePanes(panes: readonly PaneIdentity[]): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    for (const pane of panes) {
      seen.add(pane.paneId);
      const state = this.panes.get(pane.paneId);
      if (!state) {
        this.panes.set(pane.paneId, this.createPane(pane.paneId, pane.paneEpoch, true));
        continue;
      }
      state.known = true;
      if (!bytesEqual(state.paneEpoch, pane.paneEpoch)) {
        this.rotatePaneEpoch(state, pane.paneEpoch);
      }
    }

    for (const [paneId, state] of this.panes) {
      if (!state.known || seen.has(paneId)) continue;
      this.panes.delete(paneId);
      for (const consumer of this.consumers.values()) {
        consumer.active.delete(paneId);
        consumer.hot.delete(paneId);
      }
    }
    this.refreshModes(this.now());
  }

  ingest(paneId: string, paneEpoch: Uint8Array, data: Uint8Array): PaneDataSegment | null {
    if (this.disposed || data.byteLength === 0) return null;
    const now = this.now();
    this.sweep(now);
    let state = this.panes.get(paneId);
    if (!state) {
      state = this.createPane(paneId, paneEpoch, false);
      this.panes.set(paneId, state);
    } else if (!bytesEqual(state.paneEpoch, paneEpoch)) {
      this.rotatePaneEpoch(state, paneEpoch);
    }

    const ownedData = copyBytes(data);
    const seqStart = state.latestSeq;
    const seqEnd = seqStart + BigInt(ownedData.byteLength);
    state.latestSeq = seqEnd;

    const retain = state.mode !== 'cold';
    if (retain) {
      state.replay.push({ seqStart, seqEnd, data: ownedData, receivedAt: now });
      state.replayBytes += ownedData.byteLength;
      this.trimPaneReplay(state, now);
    } else {
      state.dirtyWhileCold = true;
    }

    const segment: PaneDataSegment = {
      paneId,
      paneEpoch: copyBytes(state.paneEpoch),
      seqStart,
      seqEnd,
      data: ownedData,
    };
    for (const consumer of this.consumers.values()) {
      const request = consumer.active.get(paneId) ?? consumer.hot.get(paneId);
      if (!request || !bytesEqual(request.paneEpoch, state.paneEpoch)) continue;
      safeCallback(() => consumer.callbacks.onData(segment));
    }
    this.enforceBounds(now);
    return segment;
  }

  getLatestCursor(paneId: string): PaneTerminalCursor | null {
    const state = this.panes.get(paneId);
    if (!state?.known) return null;
    return { paneEpoch: copyBytes(state.paneEpoch), terminalSeq: state.latestSeq };
  }

  readReplay(paneId: string, cursor: PaneTerminalCursor): PaneReplayPlan | null {
    const state = this.panes.get(paneId);
    if (!state?.known) return null;
    return this.buildReplayPlan({ paneId, paneEpoch: state.paneEpoch, cursor });
  }

  getScreenCheckpoint(paneId: string): PaneScreenCheckpoint | null {
    const state = this.panes.get(paneId);
    const checkpoint = state?.checkpoint;
    if (!state?.known || !checkpoint || !bytesEqual(checkpoint.paneEpoch, state.paneEpoch)) {
      return null;
    }
    state.lastTouchedAt = this.now();
    return {
      ...checkpoint,
      paneEpoch: copyBytes(checkpoint.paneEpoch),
      data: copyBytes(checkpoint.data),
      historyCursor: checkpoint.historyCursor
        ? {
            paneEpoch: copyBytes(checkpoint.historyCursor.paneEpoch),
            historyEpoch: copyBytes(checkpoint.historyCursor.historyEpoch),
            beforeLine: checkpoint.historyCursor.beforeLine,
          }
        : null,
    };
  }

  storeScreenCheckpoint(checkpoint: PaneScreenCheckpoint): boolean {
    const state = this.panes.get(checkpoint.paneId);
    if (
      !state?.known ||
      !bytesEqual(state.paneEpoch, checkpoint.paneEpoch) ||
      checkpoint.baseSeq > state.latestSeq ||
      checkpoint.data.byteLength > this.maxCheckpointBytesPerPane
    ) {
      return false;
    }
    const now = this.now();
    state.checkpoint = {
      ...checkpoint,
      paneEpoch: copyBytes(checkpoint.paneEpoch),
      data: copyBytes(checkpoint.data),
      historyCursor: checkpoint.historyCursor
        ? {
            paneEpoch: copyBytes(checkpoint.historyCursor.paneEpoch),
            historyEpoch: copyBytes(checkpoint.historyCursor.historyEpoch),
            beforeLine: checkpoint.historyCursor.beforeLine,
          }
        : null,
      capturedAt: checkpoint.capturedAt,
    };
    state.lastTouchedAt = now;
    this.enforceBounds(now);
    return state.checkpoint !== null;
  }

  readHistory(
    paneId: string,
    beforeCursor: PaneTerminalCursor | null,
    byteLimit: number
  ): PaneHistoryPage | null {
    const state = this.panes.get(paneId);
    if (!state?.known) return null;
    const limit = Math.max(0, Math.min(byteLimit, this.maxReplayBytesPerPane));
    const beforeSeq = beforeCursor?.terminalSeq ?? state.latestSeq;
    const expectedEpoch = beforeCursor?.paneEpoch ?? state.paneEpoch;
    const identity = cloneIdentity(state);
    if (!bytesEqual(expectedEpoch, state.paneEpoch)) {
      return {
        ...identity,
        seqStart: state.latestSeq,
        seqEnd: state.latestSeq,
        data: new Uint8Array(),
        nextCursor: null,
        gap: this.createGap(state, 'epoch_changed', expectedEpoch, beforeSeq),
      };
    }
    const oldestSeq = state.replay[0]?.seqStart ?? state.latestSeq;
    if (beforeSeq > state.latestSeq || beforeSeq < oldestSeq) {
      return {
        ...identity,
        seqStart: state.latestSeq,
        seqEnd: state.latestSeq,
        data: new Uint8Array(),
        nextCursor: null,
        gap: this.createGap(
          state,
          beforeSeq > state.latestSeq ? 'pane_gap' : 'cache_evicted',
          expectedEpoch,
          beforeSeq
        ),
      };
    }

    const reverseParts: Uint8Array[] = [];
    let remaining = limit;
    let seqStart = beforeSeq;
    for (let index = state.replay.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = state.replay[index];
      if (!chunk || chunk.seqStart >= beforeSeq) continue;
      const upper = chunk.seqEnd > beforeSeq ? beforeSeq : chunk.seqEnd;
      if (upper <= chunk.seqStart) continue;
      const available = Number(upper - chunk.seqStart);
      const take = Math.min(available, remaining);
      const endOffset = Number(upper - chunk.seqStart);
      reverseParts.push(chunk.data.slice(endOffset - take, endOffset));
      remaining -= take;
      seqStart = upper - BigInt(take);
    }
    reverseParts.reverse();
    const totalBytes = reverseParts.reduce((total, part) => total + part.byteLength, 0);
    const data = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of reverseParts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    state.lastTouchedAt = this.now();
    return {
      ...identity,
      seqStart,
      seqEnd: beforeSeq,
      data,
      nextCursor:
        seqStart > oldestSeq
          ? { paneEpoch: copyBytes(state.paneEpoch), terminalSeq: seqStart }
          : null,
      gap: null,
    };
  }

  snapshotStats(): PaneRetentionStats {
    this.sweep(this.now());
    let activePanes = 0;
    let gracePanes = 0;
    let hotPanes = 0;
    let coldPanes = 0;
    let replayBytes = 0;
    let checkpointBytes = 0;
    let knownPanes = 0;
    for (const state of this.panes.values()) {
      if (!state.known) continue;
      knownPanes += 1;
      if (state.mode === 'active') activePanes += 1;
      else if (state.mode === 'grace') gracePanes += 1;
      else if (state.mode === 'hot') hotPanes += 1;
      else coldPanes += 1;
      replayBytes += state.replayBytes;
      checkpointBytes += state.checkpoint?.data.byteLength ?? 0;
    }
    return {
      knownPanes,
      activePanes,
      gracePanes,
      hotPanes,
      coldPanes,
      replayBytes,
      checkpointBytes,
      retainedBytes: replayBytes + checkpointBytes,
      evictions: this.evictions,
      replayHits: this.replayHits,
      replayMisses: this.replayMisses,
      rebases: this.rebases,
    };
  }

  sweep(now = this.now()): void {
    if (this.disposed) return;
    for (const state of this.panes.values()) {
      this.trimPaneReplay(state, now);
      if (state.mode === 'grace' && state.graceUntil !== null && now >= state.graceUntil) {
        state.mode = 'hot';
        state.graceUntil = null;
        state.hotUntil = now + this.hotTtlMs;
        state.explicitHot = false;
      }
      if (
        state.mode === 'hot' &&
        !state.explicitHot &&
        state.hotUntil !== null &&
        now >= state.hotUntil
      ) {
        this.makeCold(state, true);
      }
    }
    this.enforceBounds(now);
    this.scheduleNextDeadline(now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.consumers.clear();
    this.panes.clear();
  }

  applySubscriptions(
    consumer: ConsumerState,
    generation: bigint,
    requestedActive: readonly PaneSubscriptionRequest[],
    requestedHot: readonly PaneSubscriptionRequest[]
  ): PaneSubscriptionApplyResult {
    if (this.disposed || consumer.closed) throw new Error('pane retention consumer is closed');
    const activeRequests = uniqueRequests(requestedActive);
    const activeIds = new Set(activeRequests.map((request) => request.paneId));
    const hotRequests = uniqueRequests(requestedHot).filter(
      (request) => !activeIds.has(request.paneId)
    );
    const fingerprint = subscriptionFingerprint(activeRequests, hotRequests);

    if (consumer.generation !== null && generation < consumer.generation) {
      return this.currentApplyResult(consumer);
    }
    if (consumer.generation === generation) {
      if (consumer.fingerprint !== fingerprint) {
        throw new PaneSubscriptionGenerationConflictError(generation);
      }
      return this.currentApplyResult(consumer);
    }

    const now = this.now();
    this.sweep(now);
    const rejected: PaneSubscriptionRejection[] = [];
    const otherActive = this.unionPaneIds('active', consumer.id);
    const otherHot = this.unionPaneIds('hot', consumer.id);
    const prospectiveActive = new Set(otherActive);
    const prospectiveHot = new Set(otherHot);
    const acceptedActive = new Map<string, PaneSubscriptionRequest>();
    const acceptedHot = new Map<string, PaneSubscriptionRequest>();

    for (const request of activeRequests) {
      const state = this.panes.get(request.paneId);
      const rejection = this.validateRequest(state, request);
      if (rejection) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: rejection,
        });
        continue;
      }
      if (!prospectiveActive.has(request.paneId) && prospectiveActive.size >= this.maxActivePanes) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: 'resource_exhausted',
        });
        continue;
      }
      acceptedActive.set(request.paneId, cloneRequest(request));
      prospectiveActive.add(request.paneId);
    }

    for (const request of hotRequests) {
      const state = this.panes.get(request.paneId);
      const rejection = this.validateRequest(state, request);
      if (rejection) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: rejection,
        });
        continue;
      }
      if (!prospectiveHot.has(request.paneId) && prospectiveHot.size >= this.maxHotPanes) {
        rejected.push({
          paneId: request.paneId,
          paneEpoch: copyBytes(request.paneEpoch),
          reason: 'resource_exhausted',
        });
        continue;
      }
      acceptedHot.set(request.paneId, cloneRequest(request));
      prospectiveHot.add(request.paneId);
    }

    consumer.generation = generation;
    consumer.fingerprint = fingerprint;
    consumer.active = acceptedActive;
    consumer.hot = acceptedHot;
    for (const paneId of [...acceptedActive.keys(), ...acceptedHot.keys()]) {
      const state = this.panes.get(paneId);
      if (state) state.lastTouchedAt = now;
    }
    this.refreshModes(now);

    const replay: PaneReplayPlan[] = [];
    for (const request of [...acceptedActive.values(), ...acceptedHot.values()]) {
      replay.push(this.buildReplayPlan(request));
    }
    return {
      generation,
      activePanes: Array.from(acceptedActive.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      hotPanes: Array.from(acceptedHot.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      rejected,
      replay,
    };
  }

  closeConsumer(consumer: ConsumerState): void {
    if (consumer.closed) return;
    consumer.closed = true;
    this.consumers.delete(consumer.id);
    consumer.active.clear();
    consumer.hot.clear();
    this.refreshModes(this.now());
  }

  private createPane(paneId: string, paneEpoch: Uint8Array, known: boolean): PaneState {
    if (paneEpoch.byteLength !== 16) throw new Error('pane epoch must be 16 bytes');
    return {
      paneId,
      paneEpoch: copyBytes(paneEpoch),
      known,
      latestSeq: 0n,
      dirtyWhileCold: false,
      mode: 'cold',
      explicitHot: false,
      graceUntil: null,
      hotUntil: null,
      lastTouchedAt: this.now(),
      replay: [],
      replayBytes: 0,
      checkpoint: null,
    };
  }

  private rotatePaneEpoch(state: PaneState, paneEpoch: Uint8Array): void {
    const previousEpoch = state.paneEpoch;
    const previousSeq = state.latestSeq;
    state.paneEpoch = copyBytes(paneEpoch);
    state.latestSeq = 0n;
    state.dirtyWhileCold = false;
    state.replay = [];
    state.replayBytes = 0;
    state.checkpoint = null;
    state.mode = 'cold';
    state.explicitHot = false;
    state.graceUntil = null;
    state.hotUntil = null;
    for (const consumer of this.consumers.values()) {
      const request = consumer.active.get(state.paneId) ?? consumer.hot.get(state.paneId);
      if (!request) continue;
      consumer.active.delete(state.paneId);
      consumer.hot.delete(state.paneId);
      const gap: PaneReplayGap = {
        ...cloneIdentity(state),
        reason: 'epoch_changed',
        expectedPaneEpoch: copyBytes(previousEpoch),
        expectedSeq: previousSeq,
        availableSeq: 0n,
      };
      safeCallback(() => consumer.callbacks.onGap?.(gap));
    }
  }

  private validateRequest(
    state: PaneState | undefined,
    request: PaneSubscriptionRequest
  ): PaneSubscriptionRejectionReason | null {
    if (!state?.known) return 'not_found';
    if (!bytesEqual(state.paneEpoch, request.paneEpoch)) return 'epoch_changed';
    return null;
  }

  private currentApplyResult(consumer: ConsumerState): PaneSubscriptionApplyResult {
    return {
      generation: consumer.generation ?? 0n,
      activePanes: Array.from(consumer.active.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      hotPanes: Array.from(consumer.hot.values(), (request) => ({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
      })),
      rejected: [],
      replay: [],
    };
  }

  private buildReplayPlan(request: PaneSubscriptionRequest): PaneReplayPlan {
    const state = this.panes.get(request.paneId);
    if (!state?.known) {
      throw new Error(`accepted pane disappeared before replay: ${request.paneId}`);
    }
    const identity = cloneIdentity(state);
    if (!request.cursor) {
      this.replayMisses += 1;
      this.rebases += 1;
      return { ...identity, segments: [], gap: null, needsScreen: true };
    }
    const cursor = request.cursor;
    if (!bytesEqual(cursor.paneEpoch, state.paneEpoch)) {
      this.replayMisses += 1;
      this.rebases += 1;
      return {
        ...identity,
        segments: [],
        gap: this.createGap(state, 'epoch_changed', cursor.paneEpoch, cursor.terminalSeq),
        needsScreen: true,
      };
    }
    const oldestSeq = state.replay[0]?.seqStart ?? state.latestSeq;
    if (cursor.terminalSeq > state.latestSeq || cursor.terminalSeq < oldestSeq) {
      this.replayMisses += 1;
      this.rebases += 1;
      return {
        ...identity,
        segments: [],
        gap: this.createGap(
          state,
          cursor.terminalSeq > state.latestSeq ? 'pane_gap' : 'cache_evicted',
          cursor.paneEpoch,
          cursor.terminalSeq
        ),
        needsScreen: true,
      };
    }
    const segments: PaneDataSegment[] = [];
    for (const chunk of state.replay) {
      if (chunk.seqEnd <= cursor.terminalSeq) continue;
      const offset =
        cursor.terminalSeq > chunk.seqStart ? Number(cursor.terminalSeq - chunk.seqStart) : 0;
      const data = offset === 0 ? chunk.data : chunk.data.slice(offset);
      const seqStart = chunk.seqStart + BigInt(offset);
      segments.push({
        ...identity,
        seqStart,
        seqEnd: chunk.seqEnd,
        data,
      });
    }
    this.replayHits += 1;
    return { ...identity, segments, gap: null, needsScreen: false };
  }

  private createGap(
    state: PaneState,
    reason: PaneReplayGapReason,
    expectedPaneEpoch: Uint8Array,
    expectedSeq: bigint
  ): PaneReplayGap {
    return {
      ...cloneIdentity(state),
      reason,
      expectedPaneEpoch: copyBytes(expectedPaneEpoch),
      expectedSeq,
      availableSeq: state.latestSeq,
    };
  }

  private unionPaneIds(kind: 'active' | 'hot', excludedConsumerId: number): Set<string> {
    const result = new Set<string>();
    for (const consumer of this.consumers.values()) {
      if (consumer.id === excludedConsumerId) continue;
      for (const paneId of consumer[kind].keys()) result.add(paneId);
    }
    return result;
  }

  private refreshModes(now: number): void {
    const activeIds = this.unionPaneIds('active', -1);
    const hotIds = this.unionPaneIds('hot', -1);
    for (const state of this.panes.values()) {
      if (activeIds.has(state.paneId)) {
        state.mode = 'active';
        state.explicitHot = false;
        state.graceUntil = null;
        state.hotUntil = null;
        continue;
      }
      if (hotIds.has(state.paneId)) {
        state.mode = 'hot';
        state.explicitHot = true;
        state.graceUntil = null;
        state.hotUntil = null;
        continue;
      }
      if (state.mode === 'active' || (state.mode === 'hot' && state.explicitHot)) {
        state.mode = 'grace';
        state.explicitHot = false;
        state.graceUntil = now + this.routeGraceMs;
        state.hotUntil = null;
        state.lastTouchedAt = now;
      }
    }
    this.enforceBounds(now);
    this.scheduleNextDeadline(now);
  }

  private trimPaneReplay(state: PaneState, now: number): void {
    while (
      state.replay.length > 0 &&
      (state.replayBytes > this.maxReplayBytesPerPane ||
        now - (state.replay[0]?.receivedAt ?? now) > this.replayTtlMs)
    ) {
      const removed = state.replay.shift();
      if (removed) state.replayBytes -= removed.data.byteLength;
    }
  }

  private enforceBounds(now: number): void {
    const explicitHotCount = Array.from(this.panes.values()).filter(
      (state) => state.mode === 'hot' && state.explicitHot
    ).length;
    let availableImplicitHot = Math.max(0, this.maxHotPanes - explicitHotCount);
    const implicitHot = Array.from(this.panes.values())
      .filter((state) => state.mode === 'hot' && !state.explicitHot)
      .sort((left, right) => right.lastTouchedAt - left.lastTouchedAt);
    for (const state of implicitHot) {
      if (availableImplicitHot > 0) {
        availableImplicitHot -= 1;
      } else {
        this.makeCold(state, true);
      }
    }

    let retainedBytes = this.retainedBytes();
    if (retainedBytes <= this.maxRetentionBytes) return;
    const candidates = Array.from(this.panes.values()).sort((left, right) => {
      const leftRank = left.mode === 'active' ? 2 : left.explicitHot ? 1 : 0;
      const rightRank = right.mode === 'active' ? 2 : right.explicitHot ? 1 : 0;
      return leftRank - rightRank || left.lastTouchedAt - right.lastTouchedAt;
    });

    for (const state of candidates) {
      if (retainedBytes <= this.maxRetentionBytes) break;
      if (state.mode === 'hot' && !state.explicitHot) {
        retainedBytes -= state.replayBytes + (state.checkpoint?.data.byteLength ?? 0);
        this.makeCold(state, true);
      }
    }
    for (const state of candidates) {
      if (retainedBytes <= this.maxRetentionBytes) break;
      if (state.checkpoint) {
        retainedBytes -= state.checkpoint.data.byteLength;
        state.checkpoint = null;
        this.evictions += 1;
      }
    }
    while (retainedBytes > this.maxRetentionBytes) {
      const state = candidates
        .filter((candidate) => candidate.replay.length > 0)
        .sort((left, right) => {
          const leftTime = left.replay[0]?.receivedAt ?? now;
          const rightTime = right.replay[0]?.receivedAt ?? now;
          return leftTime - rightTime;
        })[0];
      const chunk = state?.replay.shift();
      if (!state || !chunk) break;
      state.replayBytes -= chunk.data.byteLength;
      retainedBytes -= chunk.data.byteLength;
      this.evictions += 1;
    }
  }

  private retainedBytes(): number {
    let bytes = 0;
    for (const state of this.panes.values()) {
      bytes += state.replayBytes + (state.checkpoint?.data.byteLength ?? 0);
    }
    return bytes;
  }

  private makeCold(state: PaneState, eviction: boolean): void {
    const hadRetention = state.replayBytes > 0 || state.checkpoint !== null;
    state.mode = 'cold';
    state.explicitHot = false;
    state.graceUntil = null;
    state.hotUntil = null;
    state.replay = [];
    state.replayBytes = 0;
    state.checkpoint = null;
    if (eviction && hadRetention) this.evictions += 1;
  }

  private scheduleNextDeadline(now: number): void {
    if (!this.scheduleTimers || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let deadline: number | null = null;
    for (const state of this.panes.values()) {
      const candidate = state.mode === 'grace' ? state.graceUntil : state.hotUntil;
      if (candidate !== null && (deadline === null || candidate < deadline)) deadline = candidate;
    }
    if (deadline === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.sweep(this.now());
      },
      Math.max(0, deadline - now)
    );
  }
}
