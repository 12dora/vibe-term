import type { PaneHistoryCursor } from '../pane-history-reader';

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
export type PaneRetentionEvictionReason =
  | 'replay_byte_limit'
  | 'replay_ttl'
  | 'hot_limit'
  | 'hot_ttl'
  | 'retention_limit_checkpoint'
  | 'retention_limit_replay'
  | 'epoch_changed';

export interface PaneRetentionLimits {
  maxActivePanes: number;
  maxHotPanes: number;
  routeGraceMs: number;
  hotTtlMs: number;
  replayTtlMs: number;
  maxReplayBytesPerPane: number;
  maxCheckpointBytesPerPane: number;
  maxRetentionBytes: number;
}

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
  evictionsByReason: Record<PaneRetentionEvictionReason, number>;
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

export interface ReplayChunk {
  seqStart: bigint;
  seqEnd: bigint;
  data: Uint8Array;
  receivedAt: number;
}

export interface PaneState {
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
  createOrder: number;
  replay: ReplayChunk[];
  replayBytes: number;
  checkpoint: PaneScreenCheckpoint | null;
}

export interface ConsumerState {
  id: number;
  callbacks: PaneRetentionConsumerCallbacks;
  generation: bigint | null;
  fingerprint: string | null;
  active: Map<string, PaneSubscriptionRequest>;
  hot: Map<string, PaneSubscriptionRequest>;
  closed: boolean;
}
