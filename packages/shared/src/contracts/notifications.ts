// Webhook 与通知事件契约

import type { DeviceType } from './devices';

export type EventType =
  | 'terminal_bell'
  | 'terminal_notification'
  | 'tmux_window_close'
  | 'tmux_pane_close'
  | 'device_tmux_missing'
  | 'device_disconnect'
  | 'device_connection_error'
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

/**
 * `EventType` 的运行时集合。改动 `EventType` 时这里缺项会直接编译报错，
 * 跨节点通知转发的入站校验依赖它把线上字符串收敛回联合类型。
 */
const EVENT_TYPE_FLAGS: Record<EventType, true> = {
  terminal_bell: true,
  terminal_notification: true,
  tmux_window_close: true,
  tmux_pane_close: true,
  device_tmux_missing: true,
  device_disconnect: true,
  device_connection_error: true,
  session_created: true,
  session_closed: true,
  agent_confirmation_pending: true,
  agent_turn_finished: true,
  agent_error: true,
  watch_triggered: true,
  watch_model_unavailable: true,
  watch_rule_error: true,
};

export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENT_TYPE_FLAGS) as EventType[];

export function isEventType(value: unknown): value is EventType {
  // 用值比对而不是 `in`：`in` 会命中 `toString` 这类原型链键，把非法事件放进模板。
  return typeof value === 'string' && EVENT_TYPE_FLAGS[value as EventType] === true;
}
