import { describe, expect, test } from 'bun:test';
import type { SiteSettings, WebhookEvent } from '@tmex/shared';
import {
  EVENT_EMOJI,
  buildBellRawView,
  buildGenericRawView,
  buildNotificationRawView,
  buildPaneMetaLines,
  buildTerminalTopbarLabel,
} from './notification-format';

const SETTINGS = { language: 'en_US' } as SiteSettings;

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventType: 'watch_triggered',
    timestamp: '2026-01-02T03:04:05.000Z',
    site: { name: 'tmex & co', url: 'https://tmex.example.com' },
    device: { id: 'dev-1', name: 'mac', type: 'local' },
    tmux: {
      windowId: '@1',
      paneId: '%1',
      windowIndex: 7,
      paneIndex: 3,
      paneTitle: 'vim <main>',
      paneCurrentCommand: 'bash & nvim',
    },
    payload: { title: 'Build <ok>', message: 'done & dusted' },
    ...overrides,
  };
}

describe('notification-format raw views', () => {
  test('EVENT_EMOJI covers the 14 event types', () => {
    expect(EVENT_EMOJI.terminal_bell).toBe('🔔');
    expect(EVENT_EMOJI.watch_triggered).toBe('👁️');
    expect(Object.keys(EVENT_EMOJI)).toHaveLength(14);
  });

  test('buildTerminalTopbarLabel uses window/pane index when present', () => {
    expect(buildTerminalTopbarLabel(makeEvent())).toBe('Window 7 · Pane 3 @ mac');
  });

  test('pane meta and raw views keep HTML special characters unescaped', () => {
    const event = makeEvent();
    expect(buildPaneMetaLines(event)).toEqual(['Title：vim <main>', 'Process：bash & nvim']);

    const bell = buildBellRawView(event);
    expect(bell.title).toContain('tmex & co');
    expect(bell.paneMetaLines.some((line) => line.includes('vim <main>'))).toBe(true);
    expect(bell.paneUrl).toContain('https://tmex.example.com/');

    const notification = buildNotificationRawView(event);
    expect(notification.title).toBe('Build <ok>');
    expect(notification.body).toBe('done & dusted');
    expect(notification.footer).toContain('tmex & co');

    const generic = buildGenericRawView(event, SETTINGS);
    expect(generic.lines.some((line) => line.includes('vim <main>'))).toBe(true);
    expect(generic.lines.some((line) => line.includes('done & dusted'))).toBe(true);
    expect(generic.lines.some((line) => line.includes('&lt;') || line.includes('&amp;'))).toBe(
      false
    );
  });

  test('generic view omits the message line when the message is empty', () => {
    const withMessage = buildGenericRawView(makeEvent(), SETTINGS).lines.length;
    const empty = buildGenericRawView(makeEvent({ payload: { message: '' } }), SETTINGS);
    expect(empty.lines.length).toBe(withMessage - 1);
  });
});
