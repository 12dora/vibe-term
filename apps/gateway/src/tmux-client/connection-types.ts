import type { EventType, StateSnapshotPayload, WebhookEvent } from '@tmex/shared';

import type { TmuxEvent } from './events';
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
  onSnapshot: (payload: StateSnapshotPayload) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}
