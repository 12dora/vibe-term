import type { EventType, StateSnapshotPayload, WebhookEvent } from '@vibeterm/shared';

import type { TmuxEvent } from './events';
import type { TmuxSourceMetadataEvent } from './events';
import type { PromptMarker } from './pane-stream-parser';

export type LifecycleEventEmitter = (
  eventType: EventType,
  event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
) => void;

export interface TmuxConnectionOptions {
  deviceId: string;
  notifyEvent?: LifecycleEventEmitter;
  onEvent: (event: TmuxEvent) => void;
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onTerminalHistory: (
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClipboardWrite?: (paneId: string, text: string) => void;
  onSourceReady?: (serverEpoch: Uint8Array) => void;
  /** 宿主一跳（网关 ↔ tmux）往返样本：rttMs 为原始毫秒数，hop 见 DEVICE_LATENCY_HOP_*。 */
  onHostLatencySample?: (rttMs: number, hop: number) => void;
  onInputTransportInvalidated?: () => void;
  onInputTransportReady?: () => void;
  onSourceMetadata?: (event: TmuxSourceMetadataEvent) => void;
  beginMetadataReconcile?: () => bigint;
  onSnapshot: (payload: StateSnapshotPayload, baseRevision?: bigint) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}
