import type { EventType, WebhookEvent } from '@tmex/shared';
import { getSiteSettings } from '../../db';
import { weixinService } from '../../weixin/service';
import {
  buildBellRawView,
  buildGenericRawView,
  buildNotificationRawView,
} from './notification-format';
import { type NotificationChannel, PUSH_CHANNEL_SKIPPED_LIFECYCLE_EVENTS } from './types';

/**
 * 微信 (iLink) 渠道：纯文本推送（无 HTML）。
 * bell 走 enableBellPush，其余事件（含 terminal_notification）走 enableNotificationPush。
 * 实际发送语义为"半主动·最佳努力"，由 WeixinService 负责 context_token 缓存与失效标记。
 */
export class WeixinChannel implements NotificationChannel {
  readonly id = 'weixin';

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    if (PUSH_CHANNEL_SKIPPED_LIFECYCLE_EVENTS.has(eventType)) {
      return;
    }
    const settings = getSiteSettings();

    if (eventType === 'terminal_bell') {
      if (!settings.enableBellPush) {
        return;
      }
      await weixinService.sendToAuthorizedUsers({ text: this.formatBellMessage(event) });
      return;
    }

    if (!settings.enableNotificationPush) {
      return;
    }

    const text =
      eventType === 'terminal_notification'
        ? this.formatNotificationMessage(event)
        : this.formatGenericMessage(event, settings);
    await weixinService.sendToAuthorizedUsers({ text });
  }

  private formatBellMessage(event: WebhookEvent): string {
    const view = buildBellRawView(event);
    const lines = [view.title, ...view.paneMetaLines];
    if (view.paneUrl) {
      lines.push('', view.paneUrl);
    }
    return lines.join('\n');
  }

  private formatNotificationMessage(event: WebhookEvent): string {
    const view = buildNotificationRawView(event);
    const lines: string[] = [];
    if (view.title) {
      lines.push(view.title);
    }
    if (view.body) {
      lines.push(view.body);
    }
    lines.push(...view.paneMetaLines);
    lines.push('', view.footer);
    if (view.paneUrl) {
      lines.push(view.paneUrl);
    }
    return lines.join('\n');
  }

  private formatGenericMessage(
    event: WebhookEvent,
    settings: ReturnType<typeof getSiteSettings>
  ): string {
    const view = buildGenericRawView(event, settings);
    const lines = [...view.lines];
    if (view.paneUrl) {
      lines.push('', view.paneUrl);
    }
    return lines.join('\n');
  }
}

export const weixinChannel = new WeixinChannel();
