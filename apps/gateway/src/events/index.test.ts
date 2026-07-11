import { beforeAll, describe, expect, test } from 'bun:test';
import type { EventType, WebhookEvent } from '@tmex/shared';
import type { Server } from 'bun';
import { handleApiRequest } from '../api/index';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { telegramService } from '../telegram/service';
import { weixinService } from '../weixin/service';
import { registerEventNotifyBroadcaster } from './broadcaster';
import type { NotificationChannel } from './channels/types';
import { EventNotifier, eventNotifier } from './index';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

function recordingChannel(id: string): {
  channel: NotificationChannel;
  calls: Array<{ eventType: EventType; event: WebhookEvent }>;
} {
  const calls: Array<{ eventType: EventType; event: WebhookEvent }> = [];
  return {
    channel: {
      id,
      notify: async (eventType, event) => {
        calls.push({ eventType, event });
      },
    },
    calls,
  };
}

const baseEvent = {
  site: { name: 'tmex', url: 'https://tmex.example.com' },
  device: { id: 'device-reg', name: 'dev-reg', type: 'local' as const },
  tmux: { windowId: '@1', paneId: '%1', windowIndex: 1, paneIndex: 1 },
};

describe('EventNotifier channel registry', () => {
  test('registered custom channel receives notifications', async () => {
    const notifier = new EventNotifier();
    const { channel, calls } = recordingChannel('custom-a');
    notifier.registerChannel(channel);

    await notifier.notify('watch_rule_error', {
      ...baseEvent,
      payload: { message: 'boom' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.eventType).toBe('watch_rule_error');
    expect(calls[0]?.event.payload?.message).toBe('boom');
  });

  test('registering duplicate channel id throws', () => {
    const notifier = new EventNotifier();
    const { channel } = recordingChannel('custom-dup');
    notifier.registerChannel(channel);
    expect(() => notifier.registerChannel(recordingChannel('custom-dup').channel)).toThrow(
      'custom-dup'
    );
    expect(() => notifier.registerChannel(recordingChannel('webhook').channel)).toThrow('webhook');
  });

  test('channels listed in disabledNotificationChannels are skipped', async () => {
    const notifier = new EventNotifier();
    const blocked = recordingChannel('custom-blocked');
    const allowed = recordingChannel('custom-allowed');
    notifier.registerChannel(blocked.channel);
    notifier.registerChannel(allowed.channel);

    try {
      updateSiteSettings({ disabledNotificationChannels: ['custom-blocked'] });

      await notifier.notify('watch_rule_error', {
        ...baseEvent,
        payload: { message: 'filtered' },
      });

      expect(blocked.calls).toHaveLength(0);
      expect(allowed.calls).toHaveLength(1);
    } finally {
      updateSiteSettings({ disabledNotificationChannels: [] });
    }
  });

  test('PATCH /api/settings/site persists disabled channels and takes effect', async () => {
    const fakeServer = {} as unknown as Server<unknown>;
    const notifier = new EventNotifier();
    const restBlocked = recordingChannel('rest-blocked');
    notifier.registerChannel(restBlocked.channel);

    try {
      const patchRes = await handleApiRequest(
        new Request('http://localhost/api/settings/site', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            disabledNotificationChannels: ['rest-blocked', ' rest-blocked ', ''],
          }),
        }),
        fakeServer
      );
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as {
        settings: { disabledNotificationChannels: string[] };
      };
      expect(patched.settings.disabledNotificationChannels).toEqual(['rest-blocked']);
      expect(getSiteSettings().disabledNotificationChannels).toEqual(['rest-blocked']);

      await notifier.notify('watch_rule_error', {
        ...baseEvent,
        payload: { message: 'rest filtered' },
      });
      expect(restBlocked.calls).toHaveLength(0);

      const getRes = await handleApiRequest(
        new Request('http://localhost/api/settings/site', { method: 'GET' }),
        fakeServer
      );
      const fetched = (await getRes.json()) as {
        settings: { disabledNotificationChannels: string[] };
      };
      expect(fetched.settings.disabledNotificationChannels).toEqual(['rest-blocked']);
    } finally {
      updateSiteSettings({ disabledNotificationChannels: [] });
    }
  });

  test('PATCH /api/settings/site rejects non string array', async () => {
    const fakeServer = {} as unknown as Server<unknown>;
    const res = await handleApiRequest(
      new Request('http://localhost/api/settings/site', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledNotificationChannels: [1, 2] }),
      }),
      fakeServer
    );
    expect(res.status).toBe(400);
  });
});

describe('TMEX_DISABLED_NOTIFICATION_CHANNELS env disable', () => {
  const ENV_KEY = 'TMEX_DISABLED_NOTIFICATION_CHANNELS';
  const BUILTIN_IDS = ['webhook', 'telegram', 'weixin', 'ws-broadcast'];

  test('未设 env 时注册全部内建 channel', () => {
    const original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    try {
      const notifier = new EventNotifier();
      for (const id of BUILTIN_IDS) {
        expect(notifier.hasChannel(id)).toBe(true);
      }
    } finally {
      if (original !== undefined) process.env[ENV_KEY] = original;
    }
  });

  test('CSV 点名的内建 channel 跳过注册，未点名的照常', () => {
    process.env[ENV_KEY] = ' webhook , telegram ,,';
    try {
      const notifier = new EventNotifier();
      expect(notifier.hasChannel('webhook')).toBe(false);
      expect(notifier.hasChannel('telegram')).toBe(false);
      expect(notifier.hasChannel('weixin')).toBe(true);
      expect(notifier.hasChannel('ws-broadcast')).toBe(true);
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  test('ws-broadcast 可被显式点名禁用', () => {
    process.env[ENV_KEY] = 'ws-broadcast';
    try {
      const notifier = new EventNotifier();
      expect(notifier.hasChannel('ws-broadcast')).toBe(false);
      expect(notifier.hasChannel('webhook')).toBe(true);
      expect(notifier.hasChannel('telegram')).toBe(true);
      expect(notifier.hasChannel('weixin')).toBe(true);
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  test('被禁 channel 完全不存在（可重新注册同 id，非运行时过滤）', async () => {
    process.env[ENV_KEY] = 'webhook,telegram,weixin,ws-broadcast';
    try {
      const notifier = new EventNotifier();
      const replacement = recordingChannel('webhook');
      expect(() => notifier.registerChannel(replacement.channel)).not.toThrow();

      await notifier.notify('watch_rule_error', {
        ...baseEvent,
        payload: { message: 'env disabled' },
      });
      expect(replacement.calls).toHaveLength(1);
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  test('空值与纯空白 CSV 不误伤任何 channel', () => {
    for (const value of ['', '   ', ' , ,']) {
      process.env[ENV_KEY] = value;
      try {
        const notifier = new EventNotifier();
        for (const id of BUILTIN_IDS) {
          expect(notifier.hasChannel(id)).toBe(true);
        }
      } finally {
        delete process.env[ENV_KEY];
      }
    }
  });
});

describe('ws-broadcast channel 经注册桥转发', () => {
  test('EventNotifier.notify 经 ws-broadcast channel 调到注册的 broadcaster fn', async () => {
    const received: Array<{ eventType: EventType; event: WebhookEvent }> = [];
    registerEventNotifyBroadcaster((eventType, event) => {
      received.push({ eventType, event });
    });
    try {
      const notifier = new EventNotifier();
      await notifier.notify('watch_rule_error', {
        ...baseEvent,
        payload: { message: 'bridge' },
      });

      expect(received).toHaveLength(1);
      expect(received[0]?.eventType).toBe('watch_rule_error');
      expect(received[0]?.event.eventType).toBe('watch_rule_error');
      expect(received[0]?.event.payload?.message).toBe('bridge');
      expect(Number.isNaN(Date.parse(received[0]?.event.timestamp ?? ''))).toBe(false);
    } finally {
      registerEventNotifyBroadcaster(null);
    }
  });

  test('ws-broadcast 不受 enableBellPush/enableNotificationPush 门控', async () => {
    const received: EventType[] = [];
    registerEventNotifyBroadcaster((eventType) => {
      received.push(eventType);
    });
    const original = getSiteSettings();
    try {
      updateSiteSettings({
        bellThrottleSeconds: 0,
        notificationThrottleSeconds: 0,
        enableBellPush: false,
        enableNotificationPush: false,
      });

      const notifier = new EventNotifier();
      await notifier.notify('terminal_bell', {
        ...baseEvent,
        device: { id: 'device-ws-gate-bell', name: 'dev-g1', type: 'local' },
      });
      await notifier.notify('terminal_notification', {
        ...baseEvent,
        device: { id: 'device-ws-gate-notification', name: 'dev-g2', type: 'local' },
        payload: { source: 'osc777', title: 'done', message: 'ok' },
      });

      expect(received).toEqual(['terminal_bell', 'terminal_notification']);
    } finally {
      registerEventNotifyBroadcaster(null);
      updateSiteSettings({
        bellThrottleSeconds: original.bellThrottleSeconds,
        notificationThrottleSeconds: original.notificationThrottleSeconds,
        enableBellPush: original.enableBellPush,
        enableNotificationPush: original.enableNotificationPush,
      });
    }
  });

  test('ws-broadcast 受中央 bell 节流约束', async () => {
    const received: EventType[] = [];
    registerEventNotifyBroadcaster((eventType) => {
      received.push(eventType);
    });
    const original = getSiteSettings();
    try {
      updateSiteSettings({ bellThrottleSeconds: 30, enableBellPush: false });

      const notifier = new EventNotifier();
      const event = {
        ...baseEvent,
        device: { id: 'device-ws-throttle', name: 'dev-th', type: 'local' as const },
      };
      await notifier.notify('terminal_bell', event);
      await notifier.notify('terminal_bell', event);

      expect(received).toEqual(['terminal_bell']);
    } finally {
      registerEventNotifyBroadcaster(null);
      updateSiteSettings({
        bellThrottleSeconds: original.bellThrottleSeconds,
        enableBellPush: original.enableBellPush,
      });
    }
  });

  test('桥未注册时 ws-broadcast channel 静默 no-op', async () => {
    registerEventNotifyBroadcaster(null);
    const notifier = new EventNotifier();
    await notifier.notify('watch_rule_error', {
      ...baseEvent,
      payload: { message: 'no bridge' },
    });
  });

  test('lifecycle 事件全量到达 ws-broadcast，但不进 telegram/weixin 推送', async () => {
    const received: EventType[] = [];
    registerEventNotifyBroadcaster((eventType) => {
      received.push(eventType);
    });
    const telegramCalls: string[] = [];
    const weixinCalls: string[] = [];
    const originalTelegramSend = telegramService.sendToAuthorizedChats;
    const originalWeixinSend = weixinService.sendToAuthorizedUsers;
    telegramService.sendToAuthorizedChats = async ({ text }) => {
      telegramCalls.push(text);
    };
    weixinService.sendToAuthorizedUsers = async ({ text }) => {
      weixinCalls.push(text);
    };
    const original = getSiteSettings();
    try {
      updateSiteSettings({ enableNotificationPush: true });

      const notifier = new EventNotifier();
      const lifecycle: EventType[] = [
        'device_disconnect',
        'device_tmux_missing',
        'session_created',
        'session_closed',
        'tmux_window_close',
        'tmux_pane_close',
      ];
      for (const eventType of lifecycle) {
        await notifier.notify(eventType, {
          ...baseEvent,
          device: { id: `device-lc-${eventType}`, name: 'dev-lc', type: 'local' },
          payload: { message: eventType },
        });
      }

      expect(received).toEqual(lifecycle);
      expect(telegramCalls).toHaveLength(0);
      expect(weixinCalls).toHaveLength(0);
    } finally {
      registerEventNotifyBroadcaster(null);
      telegramService.sendToAuthorizedChats = originalTelegramSend;
      weixinService.sendToAuthorizedUsers = originalWeixinSend;
      updateSiteSettings({ enableNotificationPush: original.enableNotificationPush });
    }
  });
});

describe('EventNotifier telegram bell settings & html formatting', () => {
  test('skips telegram bell push when disabled', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        bellThrottleSeconds: 0,
        enableBellPush: false,
      });

      await eventNotifier.notify('terminal_bell', {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-disabled',
          name: 'dev-1',
          type: 'local',
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 1,
          paneIndex: 2,
        },
      });

      expect(calls).toHaveLength(0);
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        enableBellPush: true,
      });
    }
  });

  test('formats bell push as HTML with escaped text and link', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        bellThrottleSeconds: 0,
        enableBellPush: true,
      });

      await eventNotifier.notify('terminal_bell', {
        site: {
          name: 'tmex<prod>&',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-html',
          name: 'dev<1>&',
          type: 'local',
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 7,
          paneIndex: 3,
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.parseMode).toBe('HTML');
      expect(calls[0]?.text).toContain(
        '🔔 Bell from tmex&lt;prod&gt;&amp;: Window 7 · Pane 3 @ dev&lt;1&gt;&amp;'
      );
      expect(calls[0]?.text).toContain(
        '<a href="https://tmex.example.com/devices/device-html/windows/%401/panes/%251">Click to view</a>'
      );
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
    }
  });

  test('non-bell telegram notifications use HTML mode with escaped content (issue #4 regression)', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      // 关 bell 开关：非 bell 事件仍应照常发送
      updateSiteSettings({
        enableBellPush: false,
      });

      await eventNotifier.notify('watch_rule_error', {
        site: {
          name: 'shanghai-macmini',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-other',
          name: 'local <1>&',
          type: 'local',
        },
        tmux: {
          windowId: '@137',
          paneId: '%242',
          windowIndex: 0,
          paneIndex: 0,
          paneTitle: 'vim main.rs',
          paneCurrentCommand: 'vim',
        },
        payload: {
          message: "监控「卡住」连续失败 10 次，已自动停用：can't find pane: %2965",
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.parseMode).toBe('HTML');
      const text = calls[0]?.text ?? '';
      expect(text).toContain('Watch Rule Error');
      // 问题1 回归：不再把 MarkdownV2 转义反斜杠当纯文本发出
      expect(text).not.toContain('\\-');
      expect(text).not.toContain('\\(');
      expect(text).not.toContain('\\.');
      // HTML 转义：尖括号与 & 被正确转义
      expect(text).toContain('local &lt;1&gt;&amp;');
      // 增强：通知含 pane 标题与进程
      expect(text).toContain('vim main.rs');
      // 原始消息原样呈现（含中文与特殊符号）
      expect(text).toContain('监控「卡住」连续失败 10 次');
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        enableBellPush: true,
      });
    }
  });

  test('skips telegram terminal notification push when disabled', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        notificationThrottleSeconds: 0,
        enableNotificationPush: false,
      });

      await eventNotifier.notify('terminal_notification', {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-notification-disabled',
          name: 'dev-3',
          type: 'local',
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 1,
          paneIndex: 2,
        },
        payload: {
          source: 'osc777',
          title: 'Build finished',
          message: 'All 42 tests passed',
        },
      });

      expect(calls).toHaveLength(0);
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        enableNotificationPush: true,
      });
    }
  });

  test('formats terminal notification push as HTML and applies notification throttle', async () => {
    const calls: Array<{ text: string; parseMode?: 'HTML' | 'MarkdownV2' }> = [];
    const originalSend = telegramService.sendToAuthorizedChats;
    telegramService.sendToAuthorizedChats = async (params) => {
      calls.push(params);
    };

    try {
      updateSiteSettings({
        notificationThrottleSeconds: 3,
        enableNotificationPush: true,
      });

      const payload = {
        site: {
          name: 'tmex',
          url: 'https://tmex.example.com',
        },
        device: {
          id: 'device-notification-html',
          name: 'dev<4>&',
          type: 'local' as const,
        },
        tmux: {
          windowId: '@1',
          paneId: '%1',
          windowIndex: 7,
          paneIndex: 3,
        },
        payload: {
          source: 'osc777',
          title: 'Build <finished>',
          message: 'All 42 tests & checks passed',
        },
      };

      await eventNotifier.notify('terminal_notification', payload);
      await eventNotifier.notify('terminal_notification', payload);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.parseMode).toBe('HTML');
      expect(calls[0]?.text).toContain('Build &lt;finished&gt;');
      expect(calls[0]?.text).toContain('All 42 tests &amp; checks passed');
      expect(calls[0]?.text).toContain('from tmex: Window 7 · Pane 3 @ dev&lt;4&gt;&amp;');
      expect(calls[0]?.text).toContain(
        '<a href="https://tmex.example.com/devices/device-notification-html/windows/%401/panes/%251">'
      );
    } finally {
      telegramService.sendToAuthorizedChats = originalSend;
      updateSiteSettings({
        notificationThrottleSeconds: 3,
      });
    }
  });
});
