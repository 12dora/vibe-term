import type { EventType, WebhookEvent } from '@tmex/shared';
import { getSiteSettings } from '../../db';
import { telegramService } from '../../telegram/service';
import {
  buildBellRawView,
  buildConnectionErrorText,
  buildCredentialWarningText,
  buildGenericRawView,
  buildNotificationRawView,
  isCredentialWarningEvent,
} from './notification-format';
import {
  DEVICE_CONNECTION_ERROR_EVENT,
  type NotificationChannel,
  PUSH_CHANNEL_SKIPPED_LIFECYCLE_EVENTS,
} from './types';

function escapeTelegramHtmlText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeTelegramHtmlAttribute(input: string): string {
  return escapeTelegramHtmlText(input).replace(/"/g, '&quot;');
}

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram';

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    if (PUSH_CHANNEL_SKIPPED_LIFECYCLE_EVENTS.has(eventType)) {
      return;
    }
    const settings = getSiteSettings();

    if (eventType === 'terminal_bell') {
      if (!settings.enableBellPush) {
        return;
      }
      const bellMessage = this.formatTelegramBellMessage(event);
      await telegramService.sendToAuthorizedChats({ text: bellMessage, parseMode: 'HTML' });
      return;
    }

    if (!settings.enableNotificationPush) {
      return;
    }

    if (eventType === DEVICE_CONNECTION_ERROR_EVENT) {
      await telegramService.sendToAuthorizedChats({
        text: escapeTelegramHtmlText(buildConnectionErrorText(event)),
        parseMode: 'HTML',
      });
      return;
    }

    if (isCredentialWarningEvent(event)) {
      await telegramService.sendToAuthorizedChats({
        text: escapeTelegramHtmlText(buildCredentialWarningText(event)),
        parseMode: 'HTML',
      });
      return;
    }

    if (eventType === 'terminal_notification') {
      const notificationMessage = this.formatTelegramNotificationMessage(event);
      await telegramService.sendToAuthorizedChats({ text: notificationMessage, parseMode: 'HTML' });
      return;
    }

    const message = this.formatTelegramMessage(event, settings);
    await telegramService.sendToAuthorizedChats({ text: message, parseMode: 'HTML' });
  }

  private formatTelegramBellMessage(event: WebhookEvent): string {
    const view = buildBellRawView(event);
    const lines = [
      escapeTelegramHtmlText(view.title),
      ...view.paneMetaLines.map(escapeTelegramHtmlText),
    ];
    if (view.paneUrl) {
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(view.paneUrl)}">${escapeTelegramHtmlText(view.viewLinkLabel)}</a>`
      );
    }
    return lines.join('\n');
  }

  private formatTelegramNotificationMessage(event: WebhookEvent): string {
    const view = buildNotificationRawView(event);
    const lines: string[] = [];
    if (view.title) {
      lines.push(escapeTelegramHtmlText(view.title));
    }
    if (view.body) {
      lines.push(escapeTelegramHtmlText(view.body));
    }
    lines.push(...view.paneMetaLines.map(escapeTelegramHtmlText));
    if (view.paneUrl) {
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(view.paneUrl)}">${escapeTelegramHtmlText(view.footer)}</a>`
      );
    } else {
      lines.push('', escapeTelegramHtmlText(view.footer));
    }
    return lines.join('\n');
  }

  private formatTelegramMessage(
    event: WebhookEvent,
    settings: ReturnType<typeof getSiteSettings>
  ): string {
    const view = buildGenericRawView(event, settings);
    const lines = view.lines.map(escapeTelegramHtmlText);
    if (view.paneUrl) {
      lines.push(
        '',
        `<a href="${escapeTelegramHtmlAttribute(view.paneUrl)}">${escapeTelegramHtmlText(view.directLinkLabel)}</a>`
      );
    }
    return lines.join('\n');
  }
}

export const telegramChannel = new TelegramChannel();
