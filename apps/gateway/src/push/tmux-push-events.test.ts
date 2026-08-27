import { describe, expect, test } from 'bun:test';
import type { Device, SiteSettings } from '@tmex/shared';
import { dispatchTmuxPushEvent, parseTmuxNotificationPayload } from './tmux-push-events';

function makeDevice(): Device {
  return {
    id: 'd1',
    name: 'd1',
    type: 'local',
    session: 'tmex',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '2026-02-11T00:00:00.000Z',
    updatedAt: '2026-02-11T00:00:00.000Z',
  };
}

function makeSettings(): SiteSettings {
  return {
    siteName: 'tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 6,
    notificationThrottleSeconds: 3,
    enableBrowserNotificationToast: true,
    enableNotificationPush: true,
    enableBellPush: true,
    enableBellSound: true,
    sshReconnectMaxRetries: 2,
    sshReconnectDelaySeconds: 1,
    language: 'zh_CN',
    theme: 'dark',
    disabledNotificationChannels: [],
    updatedAt: '2026-02-11T00:00:00.000Z',
  };
}

describe('parseTmuxNotificationPayload', () => {
  test('解析 title/body/source', () => {
    expect(
      parseTmuxNotificationPayload({
        title: 'Build finished',
        body: 'ok',
        source: 'osc777',
      })
    ).toEqual({ source: 'osc777', title: 'Build finished', body: 'ok' });
  });

  test.each(['osc9', 'osc777', 'osc1337'] as const)('保留 source=%s', (source) => {
    expect(parseTmuxNotificationPayload({ body: 'x', source })?.source).toBe(source);
  });

  test('未知或缺失 source 回退 osc9', () => {
    expect(parseTmuxNotificationPayload({ body: 'x' })?.source).toBe('osc9');
    expect(parseTmuxNotificationPayload({ body: 'x', source: 'osc99' })?.source).toBe('osc9');
    expect(parseTmuxNotificationPayload({ body: 'x', source: 'other' })?.source).toBe('osc9');
  });

  test('空 title 视为缺失；非字符串 body 视为空串', () => {
    expect(parseTmuxNotificationPayload({ title: '', body: 'hi' })).toEqual({
      source: 'osc9',
      title: undefined,
      body: 'hi',
    });
    expect(parseTmuxNotificationPayload({ title: 't', body: 1 })).toEqual({
      source: 'osc9',
      title: 't',
      body: '',
    });
  });

  test('title 与 body 都空则丢弃', () => {
    expect(parseTmuxNotificationPayload({})).toBeNull();
    expect(parseTmuxNotificationPayload({ title: '', body: '' })).toBeNull();
    expect(parseTmuxNotificationPayload(undefined)).toBeNull();
    expect(parseTmuxNotificationPayload('x')).toBeNull();
  });
});

describe('dispatchTmuxPushEvent', () => {
  const paneContext = { paneId: '%1', windowId: '@1' };

  test('bell 调用 notifyBell', async () => {
    const bells: unknown[] = [];
    const notifications: unknown[] = [];
    await dispatchTmuxPushEvent({
      event: { type: 'bell', data: { paneId: '%1' } },
      device: makeDevice(),
      settings: makeSettings(),
      paneContext,
      notifyBell: async (ctx) => {
        bells.push(ctx.bell);
      },
      notifyNotification: async (ctx) => {
        notifications.push(ctx.notification);
      },
    });
    expect(bells).toEqual([paneContext]);
    expect(notifications).toEqual([]);
  });

  test('notification 调用 notifyNotification 并合并 pane context', async () => {
    const notifications: unknown[] = [];
    await dispatchTmuxPushEvent({
      event: {
        type: 'notification',
        data: { paneId: '%1', source: 'osc777', title: 'T', body: 'B' },
      },
      device: makeDevice(),
      settings: makeSettings(),
      paneContext,
      notifyBell: async () => {
        throw new Error('bell should not fire');
      },
      notifyNotification: async (ctx) => {
        notifications.push(ctx.notification);
      },
    });
    expect(notifications).toEqual([{ ...paneContext, source: 'osc777', title: 'T', body: 'B' }]);
  });

  test('空 notification 不通知', async () => {
    let called = 0;
    await dispatchTmuxPushEvent({
      event: { type: 'notification', data: { title: '', body: '' } },
      device: makeDevice(),
      settings: makeSettings(),
      paneContext,
      notifyBell: async () => {
        called += 1;
      },
      notifyNotification: async () => {
        called += 1;
      },
    });
    expect(called).toBe(0);
  });

  test.each(['window-close', 'pane-close', 'output', 'layout-change'] as const)(
    '忽略 %s',
    async (type) => {
      let called = 0;
      await dispatchTmuxPushEvent({
        event: { type, data: {} },
        device: makeDevice(),
        settings: makeSettings(),
        paneContext,
        notifyBell: async () => {
          called += 1;
        },
        notifyNotification: async () => {
          called += 1;
        },
      });
      expect(called).toBe(0);
    }
  );
});
