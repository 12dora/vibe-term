import {
  type ConsumerState,
  DEFAULT_HOT_TTL_MS,
  DEFAULT_MAX_ACTIVE_PANES,
  DEFAULT_MAX_CHECKPOINT_BYTES_PER_PANE,
  DEFAULT_MAX_HOT_PANES,
  DEFAULT_MAX_REPLAY_BYTES_PER_PANE,
  DEFAULT_MAX_RETENTION_BYTES,
  DEFAULT_REPLAY_TTL_MS,
  DEFAULT_ROUTE_GRACE_MS,
  type PaneRetentionEvictionReason,
  type PaneRetentionOptions,
  type PaneState,
} from './types';

export class RetentionKernel {
  readonly panes = new Map<string, PaneState>();
  readonly consumers = new Map<number, ConsumerState>();
  readonly implicitHots = new Map<string, PaneState>();
  readonly explicitHots = new Map<string, PaneState>();
  nextConsumerId = 1;
  nextCreateOrder = 0;
  retainedBytes = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  scheduledDeadline: number | null = null;
  disposed = false;
  evictions = 0;
  readonly evictionsByReason: Record<PaneRetentionEvictionReason, number> = {
    replay_byte_limit: 0,
    replay_ttl: 0,
    hot_limit: 0,
    hot_ttl: 0,
    retention_limit_checkpoint: 0,
    retention_limit_replay: 0,
    epoch_changed: 0,
  };
  replayHits = 0;
  replayMisses = 0;
  rebases = 0;

  readonly maxActivePanes: number;
  readonly maxHotPanes: number;
  readonly maxCheckpointBytesPerPane: number;
  readonly routeGraceMs: number;
  readonly hotTtlMs: number;
  readonly replayTtlMs: number;
  readonly maxReplayBytesPerPane: number;
  readonly maxRetentionBytes: number;
  readonly now: () => number;
  readonly scheduleTimers: boolean;

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

  syncHotIndex(state: PaneState): void {
    const implicit = state.mode === 'hot' && !state.explicitHot;
    const explicit = state.mode === 'hot' && state.explicitHot;
    if (implicit) this.implicitHots.set(state.paneId, state);
    else this.implicitHots.delete(state.paneId);
    if (explicit) this.explicitHots.set(state.paneId, state);
    else this.explicitHots.delete(state.paneId);
  }

  adjustRetainedBytes(delta: number): void {
    this.retainedBytes += delta;
    if (this.retainedBytes < 0) this.retainedBytes = 0;
  }

  paneRetainedBytes(state: PaneState): number {
    return state.replayBytes + (state.checkpoint?.data.byteLength ?? 0);
  }

  forgetPane(state: PaneState): void {
    this.adjustRetainedBytes(-this.paneRetainedBytes(state));
    this.implicitHots.delete(state.paneId);
    this.explicitHots.delete(state.paneId);
  }

  resetAccounting(): void {
    this.retainedBytes = 0;
    this.implicitHots.clear();
    this.explicitHots.clear();
    this.scheduledDeadline = null;
  }
}
