import type { EventType, WebhookEndpoint, WebhookEvent } from '@tmex/shared';
import { getAllWebhookEndpoints, getSiteSettings } from '../../db';
import { logAt } from '../../log/level';
import type { NotificationChannel } from './types';

export function webhookConfigRefreshLine(count: number): string | null {
  if (count <= 0) return null;
  return `[events] refreshed config: ${count} webhooks`;
}

export class WebhookChannel implements NotificationChannel {
  readonly id = 'webhook';

  private webhooks: WebhookEndpoint[] = [];
  private lastRefresh = 0;
  private readonly REFRESH_INTERVAL = 60_000;

  private refreshConfig(): void {
    const now = Date.now();
    if (now - this.lastRefresh < this.REFRESH_INTERVAL) return;

    this.webhooks = getAllWebhookEndpoints().filter((w) => w.enabled);
    this.lastRefresh = now;

    const line = webhookConfigRefreshLine(this.webhooks.length);
    if (!line) return;
    logAt('info', line);
  }

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    const settings = getSiteSettings();
    if (eventType === 'terminal_bell') {
      if (!settings.enableBellPush) return;
    } else if (!settings.enableNotificationPush) {
      return;
    }
    this.refreshConfig();
    const targets = this.webhooks.filter((w) => w.eventMask.includes(eventType));

    await Promise.all(
      targets.map(async (webhook) => {
        try {
          await this.sendWebhook(webhook, event);
        } catch (err) {
          console.error(`[webhook] failed to send to ${webhook.url}:`, err);
        }
      })
    );
  }

  private async sendWebhook(webhook: WebhookEndpoint, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify(event);
    const signature = await this.generateHmac(webhook.secret, body);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tmex-Signature': `sha256=${signature}`,
        'X-Tmex-Event': event.eventType,
        'X-Tmex-Timestamp': event.timestamp,
      },
      body,
    });

    if (!response.ok) {
      console.error(`[webhook] ${webhook.url} returned ${response.status}`);
    }
  }

  private async generateHmac(secret: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return Buffer.from(signature).toString('hex');
  }
}

export const webhookChannel = new WebhookChannel();
