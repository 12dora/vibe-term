import type { EventType, WebhookEvent } from '@tmex/shared';

/** 通知渠道抽象：EventNotifier 节流后遍历分发给所有已注册渠道，各渠道自行决定是否发送。 */
export interface NotificationChannel {
  readonly id: string;
  notify(eventType: EventType, event: WebhookEvent): Promise<void>;
}

// 生命周期事件暂不进推送渠道（telegram/weixin）：这两个渠道只有 enableNotificationPush
// 粗粒度总开关（默认开），直接放行会让存量用户升级后凭空多出一批推送。待 per-event
// 订阅掩码落地后再对推送渠道开放；webhook 的 eventMask 已是显式订阅制、ws-broadcast
// 面向站内 UI，均不受此限制。
export const PUSH_CHANNEL_SKIPPED_LIFECYCLE_EVENTS: ReadonlySet<EventType> = new Set([
  'device_disconnect',
  'device_tmux_missing',
  'session_created',
  'session_closed',
  'tmux_window_close',
  'tmux_pane_close',
]);

// 设备连接错误走 EventNotifier，但不进生命周期 skip 名单，以便 Telegram/微信
// 受 enableNotificationPush / disabledNotificationChannels 门控。契约 EventType
// 尚未收录该值（G1a 并行改 contracts），推送路径用断言接入。
export const DEVICE_CONNECTION_ERROR_EVENT: EventType = 'device_connection_error';

export const CREDENTIAL_WARNING_KIND = 'credential_warning';
