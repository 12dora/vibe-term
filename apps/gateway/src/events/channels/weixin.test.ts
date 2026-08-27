import { beforeAll, describe, expect, test } from 'bun:test';
import type { WebhookEvent } from '@tmex/shared';
import { ensureSiteSettingsInitialized, updateSiteSettings } from '../../db';
import { runMigrations } from '../../db/migrate';
import { weixinService } from '../../weixin/service';
import { weixinChannel } from './weixin';

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

async function withMockSend(fn: (calls: Array<{ text: string }>) => Promise<void>): Promise<void> {
  const calls: Array<{ text: string }> = [];
  const original = weixinService.sendToAuthorizedUsers;
  weixinService.sendToAuthorizedUsers = async (params) => {
    calls.push(params);
  };
  try {
    await fn(calls);
  } finally {
    weixinService.sendToAuthorizedUsers = original;
  }
}

describe('WeixinChannel gating & formatting', () => {
  test('skips bell when enableBellPush is false', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableBellPush: false });
      await weixinChannel.notify('terminal_bell', makeEvent({ eventType: 'terminal_bell' }));
      expect(calls).toHaveLength(0);
    });
  });

  test('sends plain-text bell when enabled', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableBellPush: true });
      await weixinChannel.notify('terminal_bell', makeEvent({ eventType: 'terminal_bell' }));
      expect(calls).toHaveLength(1);
      const text = calls[0]?.text ?? '';
      expect(text).toContain('tmex');
      expect(text).toContain('mac');
      // 纯文本：不含 HTML 锚标签
      expect(text).not.toContain('<a href');
      expect(text).toContain('https://tmex.example.com/devices/dev-1/windows/%401/panes/%251');
      updateSiteSettings({ enableBellPush: false });
    });
  });

  test('does not HTML-escape pane title or process (plain text)', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableBellPush: true });
      await weixinChannel.notify(
        'terminal_bell',
        makeEvent({
          eventType: 'terminal_bell',
          tmux: {
            windowId: '@1',
            paneId: '%1',
            windowIndex: 7,
            paneIndex: 3,
            paneTitle: 'vim <main>',
            paneCurrentCommand: 'bash & nvim',
          },
        })
      );
      const text = calls[0]?.text ?? '';
      expect(text).toContain('vim <main>');
      expect(text).toContain('bash & nvim');
      expect(text).not.toContain('&lt;');
      expect(text).not.toContain('&amp;');
      updateSiteSettings({ enableBellPush: false });
    });
  });

  test('skips notification & generic events when notification push disabled', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableNotificationPush: false });
      await weixinChannel.notify(
        'terminal_notification',
        makeEvent({
          eventType: 'terminal_notification',
          payload: { title: 'Build', message: 'done' },
        })
      );
      await weixinChannel.notify('watch_rule_error', makeEvent({ eventType: 'watch_rule_error' }));
      expect(calls).toHaveLength(0);
    });
  });

  test('sends notification with title and body when enabled', async () => {
    await withMockSend(async (calls) => {
      updateSiteSettings({ enableNotificationPush: true });
      await weixinChannel.notify(
        'terminal_notification',
        makeEvent({
          eventType: 'terminal_notification',
          payload: { source: 'osc777', title: 'Build finished', message: 'All tests passed' },
        })
      );
      expect(calls).toHaveLength(1);
      const text = calls[0]?.text ?? '';
      expect(text).toContain('Build finished');
      expect(text).toContain('All tests passed');
      updateSiteSettings({ enableNotificationPush: false });
    });
  });

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
        await weixinChannel.notify(eventType, makeEvent({ eventType }));
      }
      expect(calls).toHaveLength(0);

      // 非生命周期的 generic 事件不受影响
      await weixinChannel.notify('watch_triggered', makeEvent({ eventType: 'watch_triggered' }));
      expect(calls).toHaveLength(1);
      updateSiteSettings({ enableNotificationPush: false });
    });
  });
});
