import type { EventType, WebhookEvent } from '@tmex/shared';
import { getSiteSettings } from '../db';
import { telegramChannel } from './channels/telegram';
import type { NotificationChannel } from './channels/types';
import { webhookChannel } from './channels/webhook';
import { weixinChannel } from './channels/weixin';

export class EventNotifier {
  private bellThrottleMap = new Map<string, number>();
  private notificationThrottleMap = new Map<string, number>();
  private readonly channels = new Map<string, NotificationChannel>();

  constructor() {
    this.registerChannel(webhookChannel);
    this.registerChannel(telegramChannel);
    this.registerChannel(weixinChannel);
  }

  /** 注册通知渠道；重复 id 视为编程错误，直接抛错 */
  registerChannel(channel: NotificationChannel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`notification channel already registered: ${channel.id}`);
    }
    this.channels.set(channel.id, channel);
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

    const key = `${event.device.id}:${event.tmux?.paneId ?? '-'}:${event.eventType}`;
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
    const key = `${event.device.id}:${event.tmux?.paneId ?? '-'}:notification:${source}`;
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
