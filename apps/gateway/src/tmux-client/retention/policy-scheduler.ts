import type { RetentionKernel } from './kernel';
import type { PaneRetentionEvictionReason, PaneRetentionStats, PaneState } from './types';

export class RetentionPolicyScheduler {
  constructor(private readonly kernel: RetentionKernel) {}

  snapshotStats(): PaneRetentionStats {
    this.sweep(this.kernel.now());
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
      if (state.mode === 'grace' && state.graceUntil !== null && now >= state.graceUntil) {
        state.mode = 'hot';
        state.graceUntil = null;
        state.hotUntil = now + this.kernel.hotTtlMs;
        state.explicitHot = false;
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
    this.enforceBounds(now);
    this.scheduleNextDeadline(now);
  }

  refreshModes(now: number): void {
    const activeIds = this.unionPaneIds('active', -1);
    const hotIds = this.unionPaneIds('hot', -1);
    for (const state of this.kernel.panes.values()) {
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
        state.graceUntil = now + this.kernel.routeGraceMs;
        state.hotUntil = null;
        state.lastTouchedAt = now;
      }
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
        this.recordEviction(reason);
      }
    }
  }

  enforceBounds(now: number): void {
    const explicitHotCount = Array.from(this.kernel.panes.values()).filter(
      (state) => state.mode === 'hot' && state.explicitHot
    ).length;
    let availableImplicitHot = Math.max(0, this.kernel.maxHotPanes - explicitHotCount);
    const implicitHot = Array.from(this.kernel.panes.values())
      .filter((state) => state.mode === 'hot' && !state.explicitHot)
      .sort((left, right) => right.lastTouchedAt - left.lastTouchedAt);
    for (const state of implicitHot) {
      if (availableImplicitHot > 0) {
        availableImplicitHot -= 1;
      } else {
        this.makeCold(state, 'hot_limit');
      }
    }

    let retainedBytes = this.retainedBytes();
    if (retainedBytes <= this.kernel.maxRetentionBytes) return;
    const candidates = Array.from(this.kernel.panes.values()).sort((left, right) => {
      const leftRank = left.mode === 'active' ? 2 : left.explicitHot ? 1 : 0;
      const rightRank = right.mode === 'active' ? 2 : right.explicitHot ? 1 : 0;
      return leftRank - rightRank || left.lastTouchedAt - right.lastTouchedAt;
    });

    for (const state of candidates) {
      if (retainedBytes <= this.kernel.maxRetentionBytes) break;
      if (state.mode === 'hot' && !state.explicitHot) {
        retainedBytes -= state.replayBytes + (state.checkpoint?.data.byteLength ?? 0);
        this.makeCold(state, 'retention_limit_replay');
      }
    }
    for (const state of candidates) {
      if (retainedBytes <= this.kernel.maxRetentionBytes) break;
      if (state.checkpoint) {
        retainedBytes -= state.checkpoint.data.byteLength;
        state.checkpoint = null;
        this.recordEviction('retention_limit_checkpoint');
      }
    }
    while (retainedBytes > this.kernel.maxRetentionBytes) {
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
      this.recordEviction('retention_limit_replay');
    }
  }

  makeCold(state: PaneState, evictionReason: PaneRetentionEvictionReason | null): void {
    const hadRetention = state.replayBytes > 0 || state.checkpoint !== null;
    state.mode = 'cold';
    state.explicitHot = false;
    state.graceUntil = null;
    state.hotUntil = null;
    state.replay = [];
    state.replayBytes = 0;
    state.checkpoint = null;
    if (evictionReason && hadRetention) this.recordEviction(evictionReason);
  }

  recordEviction(reason: PaneRetentionEvictionReason): void {
    this.kernel.evictions += 1;
    this.kernel.evictionsByReason[reason] += 1;
  }

  scheduleNextDeadline(now: number): void {
    if (!this.kernel.scheduleTimers || this.kernel.disposed) return;
    if (this.kernel.timer) clearTimeout(this.kernel.timer);
    this.kernel.timer = null;
    let deadline: number | null = null;
    for (const state of this.kernel.panes.values()) {
      const candidate = state.mode === 'grace' ? state.graceUntil : state.hotUntil;
      if (candidate !== null && (deadline === null || candidate < deadline)) deadline = candidate;
    }
    if (deadline === null) return;
    this.kernel.timer = setTimeout(
      () => {
        this.kernel.timer = null;
        this.sweep(this.kernel.now());
      },
      Math.max(0, deadline - now)
    );
  }

  dispose(): void {
    if (this.kernel.timer) clearTimeout(this.kernel.timer);
    this.kernel.timer = null;
  }

  unionPaneIds(kind: 'active' | 'hot', excludedConsumerId: number): Set<string> {
    const result = new Set<string>();
    for (const consumer of this.kernel.consumers.values()) {
      if (consumer.id === excludedConsumerId) continue;
      for (const paneId of consumer[kind].keys()) result.add(paneId);
    }
    return result;
  }

  private retainedBytes(): number {
    let bytes = 0;
    for (const state of this.kernel.panes.values()) {
      bytes += state.replayBytes + (state.checkpoint?.data.byteLength ?? 0);
    }
    return bytes;
  }
}
