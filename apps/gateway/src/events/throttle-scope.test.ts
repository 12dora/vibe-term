import { beforeAll, describe, expect, test } from 'bun:test';
import type { EventType, WebhookEvent } from '@vibeterm/shared';
import { ensureSiteSettingsInitialized, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import type { NotificationChannel } from './channels/types';
import { EventNotifier, eventThrottleScope } from './index';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

function event(payload?: Record<string, unknown>): WebhookEvent {
  return {
    eventType: 'terminal_bell',
    timestamp: '2026-09-06T00:00:00.000Z',
    site: { name: 'tmex', url: 'https://tmex.example.com' },
    device: { id: 'dev-1', name: 'dev', type: 'local' },
    tmux: { paneId: '%1' },
    ...(payload ? { payload } : {}),
  };
}

describe('eventThrottleScope', () => {
  test('本机事件记为 local', () => {
    expect(eventThrottleScope(event())).toBe('local:dev-1:%1');
  });

  test('转发件按来源节点分桶', () => {
    expect(eventThrottleScope(event({ nodeId: 'node-b' }))).toBe('node-b:dev-1:%1');
  });
});

describe('节流键含 nodeId', () => {
  test('不同节点的同名 pane 响铃互不压制', async () => {
    updateSiteSettings({ bellThrottleSeconds: 60 });
    const calls: EventType[] = [];
    const channel: NotificationChannel = {
      id: 'recorder',
      notify: async (eventType) => {
        calls.push(eventType);
      },
    };
    const notifier = new EventNotifier();
    notifier.registerChannel(channel);
    const { eventType: _t, timestamp: _s, ...rest } = event({ nodeId: 'node-b' });
    const { eventType: _t2, timestamp: _s2, ...restC } = event({ nodeId: 'node-c' });
    await notifier.notify('terminal_bell', rest);
    await notifier.notify('terminal_bell', restC);
    await notifier.notify('terminal_bell', rest);
    expect(calls).toHaveLength(2);
    updateSiteSettings({ bellThrottleSeconds: 0 });
  });
});
