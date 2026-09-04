import { afterEach, describe, expect, test } from 'bun:test';
import type { SiteSettings, WebhookEvent } from '@tmex/shared';
import {
  EVENT_EMOJI,
  buildBellRawView,
  buildCredentialWarningText,
  buildGenericRawView,
  buildNotificationRawView,
  buildPaneMetaLines,
  buildTerminalTopbarLabel,
  setNotificationNodeNameProvider,
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
  afterEach(() => {
    setNotificationNodeNameProvider(null);
  });

  test('EVENT_EMOJI covers the 15 event types', () => {
    expect(EVENT_EMOJI.terminal_bell).toBe('🔔');
    expect(EVENT_EMOJI.watch_triggered).toBe('👁️');
    expect(Object.keys(EVENT_EMOJI)).toHaveLength(15);
  });

  test('buildTerminalTopbarLabel uses window/pane index when present', () => {
    expect(buildTerminalTopbarLabel(makeEvent())).toBe('Window 7 · Terminal 3 @ mac');
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

  test('standalone (no mesh identity) does not add a node line', () => {
    setNotificationNodeNameProvider(() => null);
    const event = makeEvent();
    expect(buildBellRawView(event).paneMetaLines.some((line) => line.includes('studio'))).toBe(
      false
    );
    expect(
      buildNotificationRawView(event).paneMetaLines.some((line) => line.includes('studio'))
    ).toBe(false);
    expect(buildGenericRawView(event, SETTINGS).lines.some((line) => line.includes('studio'))).toBe(
      false
    );
  });

  test('mesh identity adds a node line to bell, notification and generic views', () => {
    setNotificationNodeNameProvider(() => 'studio');
    const event = makeEvent();
    expect(buildBellRawView(event).paneMetaLines.some((line) => line.includes('studio'))).toBe(
      true
    );
    expect(
      buildNotificationRawView(event).paneMetaLines.some((line) => line.includes('studio'))
    ).toBe(true);
    const generic = buildGenericRawView(event, SETTINGS).lines;
    const siteIndex = generic.findIndex((line) => line.includes('tmex & co'));
    const nodeIndex = generic.findIndex((line) => line.includes('studio'));
    expect(nodeIndex).toBeGreaterThan(siteIndex);
  });

  test('node label prefers payload nodeName then nodeId over local identity', () => {
    setNotificationNodeNameProvider(() => 'studio');
    const named = makeEvent({
      payload: { nodeName: 'remote-box', nodeId: 'ab'.repeat(16), message: 'x' },
    });
    expect(
      buildGenericRawView(named, SETTINGS).lines.some((line) => line.includes('remote-box'))
    ).toBe(true);
    expect(buildGenericRawView(named, SETTINGS).lines.some((line) => line.includes('studio'))).toBe(
      false
    );
    expect(buildCredentialWarningText(named)).toContain('remote-box');
    expect(buildCredentialWarningText(named)).not.toContain('studio');

    const idOnly = makeEvent({ payload: { nodeId: 'cd'.repeat(16), message: 'x' } });
    expect(
      buildGenericRawView(idOnly, SETTINGS).lines.some((line) => line.includes('cd'.repeat(16)))
    ).toBe(true);
    expect(buildCredentialWarningText(idOnly)).toContain('cd'.repeat(16));
    expect(buildBellRawView(named).paneMetaLines.some((line) => line.includes('remote-box'))).toBe(
      true
    );
  });
});
