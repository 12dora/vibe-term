import type { wsBorsh } from '@tmex/shared';

import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../../tmux-client/device-session-runtime';
import type {
  PaneIdentity,
  PaneReplayGap,
  PaneRetentionConsumerLease,
} from '../../tmux-client/pane-retention';

export const CANONICAL_MAX_SCREEN_BYTES = 512 * 1024;
export const CANONICAL_MAX_HISTORY_PAGE_BYTES = 256 * 1024;
export const CANONICAL_MAX_PENDING_PANE_GAPS = 256;
export const CANONICAL_MAX_INPUT_DEDUP_IDS = 1_024;

export type CanonicalEvent = wsBorsh.CanonicalEvent;
export type CanonicalCommand = wsBorsh.CanonicalCommand;
export type CanonicalPaneTarget = wsBorsh.CanonicalPaneTarget;
export type CanonicalPaneSubscription = wsBorsh.CanonicalPaneSubscription;

export interface CanonicalFeedRuntime
  extends Pick<
    DeviceSessionRuntime,
    | 'getServerEpoch'
    | 'getMetadataSnapshot'
    | 'getPaneIdentity'
    | 'attachPaneConsumer'
    | 'subscribe'
    | 'readPaneHistory'
    | 'captureCanonicalScreen'
    | 'sendInputBytes'
    | 'resizePane'
  > {}

export type CanonicalSendResult = boolean | 'backpressured';

export function canonicalSendAccepted(result: CanonicalSendResult): boolean {
  return result === true || result === 'backpressured';
}

export function canonicalSendContinue(result: CanonicalSendResult): boolean {
  return result === true;
}

export interface CanonicalFeedSessionOptions {
  maxFrameBytes: number;
  sendEvent: (event: CanonicalEvent) => CanonicalSendResult;
  resolveRuntime: (deviceId: string) => Promise<CanonicalFeedRuntime | null>;
  initialDeviceIds?: () => Iterable<string>;
  onDeviceAttached?: (deviceId: string, runtime: CanonicalFeedRuntime) => void;
  onDeviceDetached?: (deviceId: string, runtime: CanonicalFeedRuntime) => void;
  resizePane?: (
    deviceId: string,
    paneId: string,
    cols: number,
    rows: number,
    runtime: CanonicalFeedRuntime
  ) => void;
  createEpoch?: () => Uint8Array;
  maxPendingPaneGaps?: number;
}

export interface CanonicalFeedSessionStats {
  attachedRuntimes: number;
  screenJobs: number;
  gatedPanes: number;
  pendingPaneGaps: number;
  pendingPaneGapLimit: number;
  streamGapPending: boolean;
  inputDedupIds: number;
  inputDedupLimit: number;
  paneDataDeliveries: number;
  paneDataBytes: number;
  paneDataDrops: number;
  paneDataDropBytes: number;
  pendingPaneGapOverflows: number;
  paneGapsSent: number;
  paneGapsByReason: Record<PaneReplayGap['reason'], number>;
  streamGapsSent: number;
  screenTransactionsStarted: number;
  screenTransactionsCompleted: number;
  screenTransactionsFailed: number;
  screenTransactionsCancelled: number;
}

export interface AttachedDevice {
  deviceId: string;
  runtime: CanonicalFeedRuntime;
  lease: PaneRetentionConsumerLease;
  detachListener: () => void;
  metadataNeedsRebase: boolean;
}

export interface ScreenJob {
  key: string;
  requestId: Uint8Array;
  cancelled: boolean;
}

export interface ResolvedTarget {
  device: AttachedDevice;
  pane: PaneIdentity;
  target: CanonicalPaneTarget;
}

export type { DeviceSessionRuntimeListener, PaneIdentity, PaneReplayGap };
