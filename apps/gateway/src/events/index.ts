import type { EventType, WebhookEvent } from '@vibeterm/shared';
import { config } from '../config';
import { getSiteSettings } from '../db';
import { meshForwardChannel } from './channels/mesh-forward';
import { telegramChannel } from './channels/telegram';
import type { NotificationChannel } from './channels/types';
import { webhookChannel } from './channels/webhook';
import { weixinChannel } from './channels/weixin';
import { wsBroadcastChannel } from './channels/ws-broadcast';

function parseDisabledChannelIds(csv: string): Set<string> {
  return new Set(
    csv
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

/**
 * 节流键的作用域：同一 pane 在不同节点上是两回事，汇聚机收下多台节点的事件后
 * 必须按 `nodeId:deviceId:paneId` 分桶，否则 B 的响铃会把 C 的压掉。
 * 本机事件没有 `payload.nodeId`，统一记为 `local`。
 */
export function eventThrottleScope(event: WebhookEvent): string {
  const raw = event.payload?.nodeId;
  const nodeId = typeof raw === 'string' && raw.trim() ? raw.trim() : 'local';
  return `${nodeId}:${event.device.id}:${event.tmux?.paneId ?? '-'}`;
}

export class EventNotifier {
  private bellThrottleMap = new Map<string, number>();
  private notificationThrottleMap = new Map<string, number>();
  private readonly channels = new Map<string, NotificationChannel>();

  constructor() {
    const envDisabled = parseDisabledChannelIds(config.disabledNotificationChannelsEnv);
    const builtinChannels = [
      webhookChannel,
      telegramChannel,
      weixinChannel,
      wsBroadcastChannel,
      meshForwardChannel,
    ];
    for (const channel of builtinChannels) {
      if (envDisabled.has(channel.id)) {
        continue;
      }
      this.registerChannel(channel);
    }
  }

  /** 注册通知渠道；重复 id 视为编程错误，直接抛错 */
  registerChannel(channel: NotificationChannel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`notification channel already registered: ${channel.id}`);
    }
    this.channels.set(channel.id, channel);
  }

  hasChannel(id: string): boolean {
    return this.channels.has(id);
  }

  async notify(
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ): Promise<void> {
    const fullEvent: WebhookEvent = {
      ...event,
      eventType,
      timestamp: new Date().toISOString(),
    };

    if (eventType === 'terminal_bell') {
      if (!this.shouldPassBellThrottle(fullEvent)) {
        return;
      }
    } else if (eventType === 'terminal_notification') {
      if (!this.shouldPassNotificationThrottle(fullEvent)) {
        return;
      }
    }

    const disabled = new Set(getSiteSettings().disabledNotificationChannels);
    const active = [...this.channels.values()].filter((channel) => !disabled.has(channel.id));
    await Promise.all(active.map((channel) => channel.notify(eventType, fullEvent)));
  }

  private shouldPassBellThrottle(event: WebhookEvent): boolean {
    const settings = getSiteSettings();
    const throttleMs = Math.max(0, settings.bellThrottleSeconds) * 1000;
    if (throttleMs === 0) {
      return true;
    }

    const key = `${eventThrottleScope(event)}:${event.eventType}`;
    const now = Date.now();
    const previous = this.bellThrottleMap.get(key) ?? 0;

    if (now - previous < throttleMs) {
      return false;
    }

    this.bellThrottleMap.set(key, now);
    return true;
  }

  private shouldPassNotificationThrottle(event: WebhookEvent): boolean {
    const settings = getSiteSettings();
    const throttleMs = Math.max(0, settings.notificationThrottleSeconds) * 1000;
    if (throttleMs === 0) {
      return true;
    }

    const source = typeof event.payload?.source === 'string' ? event.payload.source : 'unknown';
    const key = `${eventThrottleScope(event)}:notification:${source}`;
    const now = Date.now();
    const previous = this.notificationThrottleMap.get(key) ?? 0;

    if (now - previous < throttleMs) {
      return false;
    }

    this.notificationThrottleMap.set(key, now);
    return true;
  }
}

export const eventNotifier = new EventNotifier();
