// Webhook 与通知事件契约

import type { DeviceType } from './devices';

export type EventType =
  | 'terminal_bell'
  | 'terminal_notification'
  | 'tmux_window_close'
  | 'tmux_pane_close'
  | 'device_tmux_missing'
  | 'device_disconnect'
  | 'session_created'
  | 'session_closed'
  | 'agent_confirmation_pending'
  | 'agent_turn_finished'
  | 'agent_error'
  | 'watch_triggered'
  | 'watch_model_unavailable'
  | 'watch_rule_error';

export interface WebhookEndpoint {
  id: string;
  enabled: boolean;
  url: string;
  secret: string;
  eventMask: EventType[];
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEvent {
  eventType: EventType;
  timestamp: string;
  site: {
    name: string;
    url: string;
  };
  device: {
    id: string;
    name: string;
    type: DeviceType;
    host?: string;
  };
  tmux?: {
    sessionName?: string;
    windowId?: string;
    windowIndex?: number;
    paneId?: string;
    paneIndex?: number;
    paneUrl?: string;
    paneTitle?: string;
    paneCurrentCommand?: string;
  };
  payload?: Record<string, unknown>;
}
