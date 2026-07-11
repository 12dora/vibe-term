import { beforeAll, describe, expect, test } from 'bun:test';
import type { WebhookEvent } from '@tmex/shared';
import { ensureSiteSettingsInitialized, updateSiteSettings } from '../../db';
import { runMigrations } from '../../db/migrate';
import { telegramService } from '../../telegram/service';
import { telegramChannel } from './telegram';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventType: 'terminal_bell',
    timestamp: new Date().toISOString(),
    site: { name: 'tmex', url: 'https://tmex.example.com' },
    device: { id: 'dev-1', name: 'mac', type: 'local' },
    tmux: { windowId: '@1', paneId: '%1', windowIndex: 7, paneIndex: 3 },
    ...overrides,
  };
}

async function withMockSend(
  fn: (calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }>) => Promise<void>
): Promise<void> {
  const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
  const original = telegramService.sendToAuthorizedChats;
  telegramService.sendToAuthorizedChats = async (params) => {
    calls.push(params);
  };
  try {
    await fn(calls);
  } finally {
    telegramService.sendToAuthorizedChats = original;
  }
}

describe('TelegramChannel lifecycle event gating', () => {
  test('skips lifecycle events even when notification push is enabled', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableNotificationPush: true });
      const lifecycle = [
        'device_disconnect',
        'device_tmux_missing',
        'session_created',
        'session_closed',
        'tmux_window_close',
        'tmux_pane_close',
      ] as const;
      for (const eventType of lifecycle) {
        await telegramChannel.notify(eventType, makeEvent({ eventType }));
      }
      expect(calls).toHaveLength(0);

      // 非生命周期的 generic 事件不受影响
      await telegramChannel.notify('watch_triggered', makeEvent({ eventType: 'watch_triggered' }));
      expect(calls).toHaveLength(1);
      updateSiteSettings({ enableNotificationPush: false });
    });
  });

  test('bell and terminal_notification keep sending as before', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableBellPush: true, enableNotificationPush: true });
      await telegramChannel.notify('terminal_bell', makeEvent({ eventType: 'terminal_bell' }));
      await telegramChannel.notify(
        'terminal_notification',
        makeEvent({
          eventType: 'terminal_notification',
          payload: { source: 'osc777', title: 'Build finished', message: 'All tests passed' },
        })
      );
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.parseMode === 'HTML')).toBe(true);
      expect(calls[1]?.text).toContain('Build finished');
      updateSiteSettings({ enableBellPush: false, enableNotificationPush: false });
    });
  });
});
