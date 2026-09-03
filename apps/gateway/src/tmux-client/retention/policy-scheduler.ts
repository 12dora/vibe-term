import type { RetentionKernel } from './kernel';
import { MinHeap } from './min-heap';
import type { PaneRetentionEvictionReason, PaneRetentionStats, PaneState } from './types';

interface ReplayHead {
  state: PaneState;
  receivedAt: number;
  rank: number;
  lastTouchedAt: number;
  createOrder: number;
}

function retentionRank(state: PaneState): number {
  if (state.mode === 'active') return 2;
  if (state.explicitHot) return 1;
  return 0;
}

function compareImplicitHotKeepOrder(left: PaneState, right: PaneState): number {
  return right.lastTouchedAt - left.lastTouchedAt || left.createOrder - right.createOrder;
}

function compareRetentionOrder(left: PaneState, right: PaneState): number {
  return (
    retentionRank(left) - retentionRank(right) ||
    left.lastTouchedAt - right.lastTouchedAt ||
    left.createOrder - right.createOrder
  );
}

function compareReplayHead(left: ReplayHead, right: ReplayHead): number {
  return (
    left.receivedAt - right.receivedAt ||
    left.rank - right.rank ||
    left.lastTouchedAt - right.lastTouchedAt ||
    left.createOrder - right.createOrder
  );
}

function replayHead(state: PaneState): ReplayHead | null {
  const chunk = state.replay[0];
  if (!chunk) return null;
  return {
    state,
    receivedAt: chunk.receivedAt,
    rank: retentionRank(state),
    lastTouchedAt: state.lastTouchedAt,
    createOrder: state.createOrder,
  };
}

export class RetentionPolicyScheduler {
  constructor(private readonly kernel: RetentionKernel) {}

  snapshotStats(): PaneRetentionStats {
    let activePanes = 0;
    let gracePanes = 0;
    let hotPanes = 0;
    let coldPanes = 0;
    let replayBytes = 0;
    let checkpointBytes = 0;
    let knownPanes = 0;
    for (const state of this.kernel.panes.values()) {
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
      evictions: this.kernel.evictions,
      evictionsByReason: { ...this.kernel.evictionsByReason },
      replayHits: this.kernel.replayHits,
      replayMisses: this.kernel.replayMisses,
      rebases: this.kernel.rebases,
    };
  }

  sweep(now = this.kernel.now()): void {
    if (this.kernel.disposed) return;
    for (const state of this.kernel.panes.values()) {
      this.trimPaneReplay(state, now);
      this.advanceModeDeadlines(state, now);
    }
    this.enforceBounds(now);
    this.scheduleNextDeadline(now);
  }

  refreshModes(now: number): void {
    const activeIds = this.unionPaneIds('active', -1);
    const hotIds = this.unionPaneIds('hot', -1);
    for (const state of this.kernel.panes.values()) {
      this.applySubscriptionMode(state, now, activeIds, hotIds);
    }
    this.enforceBounds(now);
    this.scheduleNextDeadline(now);
  }

  trimPaneReplay(state: PaneState, now: number): void {
    while (
      state.replay.length > 0 &&
      (state.replayBytes > this.kernel.maxReplayBytesPerPane ||
        now - (state.replay[0]?.receivedAt ?? now) > this.kernel.replayTtlMs)
    ) {
      const reason: PaneRetentionEvictionReason =
        state.replayBytes > this.kernel.maxReplayBytesPerPane ? 'replay_byte_limit' : 'replay_ttl';
      const removed = state.replay.shift();
      if (removed) {
        state.replayBytes -= removed.data.byteLength;
        this.kernel.adjustRetainedBytes(-removed.data.byteLength);
        this.recordEviction(reason);
      }
    }
  }

  enforceBounds(_now: number): void {
    this.enforceHotLimit();
    this.enforceRetentionLimit();
  }

  afterIngest(state: PaneState, now: number): void {
    if (this.kernel.retainedBytes > this.kernel.maxRetentionBytes) {
      this.sweep(now);
      return;
    }
    this.nudgePaneDeadline(state, now);
  }

  makeCold(state: PaneState, evictionReason: PaneRetentionEvictionReason | null): void {
    const bytes = this.kernel.paneRetainedBytes(state);
    const hadRetention = bytes > 0;
    state.mode = 'cold';
    state.explicitHot = false;
    state.graceUntil = null;
    state.hotUntil = null;
    state.replay = [];
    state.replayBytes = 0;
    state.checkpoint = null;
    this.kernel.adjustRetainedBytes(-bytes);
    this.kernel.syncHotIndex(state);
    if (evictionReason && hadRetention) this.recordEviction(evictionReason);
  }

  recordEviction(reason: PaneRetentionEvictionReason): void {
    this.kernel.evictions += 1;
    this.kernel.evictionsByReason[reason] += 1;
  }

  scheduleNextDeadline(now: number): void {
    if (!this.kernel.scheduleTimers || this.kernel.disposed) return;
    let deadline: number | null = null;
    for (const state of this.kernel.panes.values()) {
      deadline = earlierDeadline(deadline, this.paneDeadline(state));
    }
    this.armTimer(deadline, now);
  }

  nudgePaneDeadline(state: PaneState, now: number): void {
    if (!this.kernel.scheduleTimers || this.kernel.disposed) return;
    const deadline = this.paneDeadline(state);
    if (deadline === null) return;
    if (this.kernel.scheduledDeadline !== null && this.kernel.scheduledDeadline <= deadline) {
      return;
    }
    this.armTimer(deadline, now);
  }

  dispose(): void {
    if (this.kernel.timer) clearTimeout(this.kernel.timer);
    this.kernel.timer = null;
    this.kernel.scheduledDeadline = null;
  }

  unionPaneIds(kind: 'active' | 'hot', excludedConsumerId: number): Set<string> {
    const result = new Set<string>();
    for (const consumer of this.kernel.consumers.values()) {
      if (consumer.id === excludedConsumerId) continue;
      for (const paneId of consumer[kind].keys()) result.add(paneId);
    }
    return result;
  }

  private applySubscriptionMode(
    state: PaneState,
    now: number,
    activeIds: Set<string>,
    hotIds: Set<string>
  ): void {
    if (activeIds.has(state.paneId)) {
      state.mode = 'active';
      state.explicitHot = false;
      state.graceUntil = null;
      state.hotUntil = null;
      this.kernel.syncHotIndex(state);
      return;
    }
    if (hotIds.has(state.paneId)) {
      state.mode = 'hot';
      state.explicitHot = true;
      state.graceUntil = null;
      state.hotUntil = null;
      this.kernel.syncHotIndex(state);
      return;
    }
    if (state.mode === 'active' || (state.mode === 'hot' && state.explicitHot)) {
      state.mode = 'grace';
      state.explicitHot = false;
      state.graceUntil = now + this.kernel.routeGraceMs;
      state.hotUntil = null;
      state.lastTouchedAt = now;
      this.kernel.syncHotIndex(state);
    }
  }

  private advanceModeDeadlines(state: PaneState, now: number): void {
    if (state.mode === 'grace' && state.graceUntil !== null && now >= state.graceUntil) {
      state.mode = 'hot';
      state.graceUntil = null;
      state.hotUntil = now + this.kernel.hotTtlMs;
      state.explicitHot = false;
      this.kernel.syncHotIndex(state);
    }
    if (
      state.mode === 'hot' &&
      !state.explicitHot &&
      state.hotUntil !== null &&
      now >= state.hotUntil
    ) {
      this.makeCold(state, 'hot_ttl');
    }
  }

  private enforceHotLimit(): void {
    const available = Math.max(0, this.kernel.maxHotPanes - this.kernel.explicitHots.size);
    if (this.kernel.implicitHots.size <= available) return;
    const implicitHot = Array.from(this.kernel.implicitHots.values()).sort(
      compareImplicitHotKeepOrder
    );
    for (let index = available; index < implicitHot.length; index += 1) {
      const state = implicitHot[index];
      if (state) this.makeCold(state, 'hot_limit');
    }
  }

  private enforceRetentionLimit(): void {
    if (this.kernel.retainedBytes <= this.kernel.maxRetentionBytes) return;
    this.evictImplicitHotsForRetention();
    if (this.kernel.retainedBytes <= this.kernel.maxRetentionBytes) return;
    this.evictCheckpointsForRetention();
    if (this.kernel.retainedBytes <= this.kernel.maxRetentionBytes) return;
    this.evictOldestReplayChunks();
  }

  private evictImplicitHotsForRetention(): void {
    const implicit = Array.from(this.kernel.implicitHots.values()).sort(
      (left, right) =>
        left.lastTouchedAt - right.lastTouchedAt || left.createOrder - right.createOrder
    );
    for (const state of implicit) {
      if (this.kernel.retainedBytes <= this.kernel.maxRetentionBytes) return;
      this.makeCold(state, 'retention_limit_replay');
    }
  }

  private evictCheckpointsForRetention(): void {
    const withCheckpoint: PaneState[] = [];
    for (const state of this.kernel.panes.values()) {
      if (state.checkpoint) withCheckpoint.push(state);
    }
    withCheckpoint.sort(compareRetentionOrder);
    for (const state of withCheckpoint) {
      if (this.kernel.retainedBytes <= this.kernel.maxRetentionBytes) return;
      const checkpoint = state.checkpoint;
      if (!checkpoint) continue;
      this.kernel.adjustRetainedBytes(-checkpoint.data.byteLength);
      state.checkpoint = null;
      this.recordEviction('retention_limit_checkpoint');
    }
  }

  private evictOldestReplayChunks(): void {
    const heap = new MinHeap<ReplayHead>(compareReplayHead);
    for (const state of this.kernel.panes.values()) {
      const head = replayHead(state);
      if (head) heap.push(head);
    }
    while (this.kernel.retainedBytes > this.kernel.maxRetentionBytes && heap.size > 0) {
      const item = heap.pop();
      if (!item) break;
      const chunk = item.state.replay[0];
      if (!chunk || chunk.receivedAt !== item.receivedAt) {
        const refreshed = replayHead(item.state);
        if (refreshed) heap.push(refreshed);
        continue;
      }
      item.state.replay.shift();
      item.state.replayBytes -= chunk.data.byteLength;
      this.kernel.adjustRetainedBytes(-chunk.data.byteLength);
      this.recordEviction('retention_limit_replay');
      const next = replayHead(item.state);
      if (next) heap.push(next);
    }
  }

  private paneDeadline(state: PaneState): number | null {
    const modeDeadline = state.mode === 'grace' ? state.graceUntil : state.hotUntil;
    const oldest = state.replay[0];
    if (!oldest) return modeDeadline;
    const replayDeadline = oldest.receivedAt + this.kernel.replayTtlMs;
    return earlierDeadline(modeDeadline, replayDeadline);
  }

  private armTimer(deadline: number | null, now: number): void {
    if (this.kernel.timer) clearTimeout(this.kernel.timer);
    this.kernel.timer = null;
    this.kernel.scheduledDeadline = deadline;
    if (deadline === null) return;
    this.kernel.timer = setTimeout(
      () => {
        this.kernel.timer = null;
        this.kernel.scheduledDeadline = null;
        this.sweep(this.kernel.now());
      },
      Math.max(0, deadline - now)
    );
  }
}

function earlierDeadline(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}
