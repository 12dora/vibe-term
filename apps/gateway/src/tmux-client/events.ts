import type { TmuxEventType } from '@tmex/shared';

export interface TmuxEvent {
  type: TmuxEventType;
  data: unknown;
}

export type TmuxSourceMetadataEvent =
  | { type: 'pane-title'; paneId: string; title: string }
  | { type: 'pane-current-path'; paneId: string; currentPath: string }
  | { type: 'pane-current-command'; paneId: string; currentCommand: string }
  | { type: 'session-renamed'; sessionId: string; name: string }
  | { type: 'session-window-changed'; sessionId: string; windowId: string }
  | { type: 'window-renamed'; windowId: string; name: string }
  | { type: 'window-pane-changed'; windowId: string; paneId: string }
  | { type: 'layout-change'; windowId: string; layout: string }
  | { type: 'window-close'; windowId: string };
