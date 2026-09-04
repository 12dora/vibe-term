import { describe, expect, test } from 'bun:test';
import type { WebhookEvent } from '@tmex/shared';
import { buildPaneUrl, eventNodeId, normalizeHttpUrl } from './pane-url';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventType: 'terminal_bell',
    timestamp: '2026-01-02T03:04:05.000Z',
    site: { name: 'tmex', url: 'https://tmex.example.com' },
    device: { id: 'dev-1', name: 'mac', type: 'local' },
    tmux: { windowId: '@1', paneId: '%1' },
    ...overrides,
  };
}

describe('buildPaneUrl', () => {
  test('local pane uses /devices/... without node prefix', () => {
    expect(buildPaneUrl(makeEvent())).toBe(
      'https://tmex.example.com/devices/dev-1/windows/%401/panes/%251'
    );
  });

  test('remote node pane uses /n/<nodeId>/devices/...', () => {
    const nodeId = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
    expect(
      buildPaneUrl(
        makeEvent({
          payload: { nodeId },
        })
      )
    ).toBe(`https://tmex.example.com/n/${nodeId}/devices/dev-1/windows/%401/panes/%251`);
  });

  test('remote node without window/pane falls back to the device page', () => {
    const nodeId = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
    expect(
      buildPaneUrl(
        makeEvent({
          tmux: { paneId: '%9' },
          payload: { nodeId },
        })
      )
    ).toBe(`https://tmex.example.com/n/${nodeId}/devices/dev-1`);
  });

  test('missing window/pane on a local event still returns null', () => {
    expect(buildPaneUrl(makeEvent({ tmux: { paneId: '%9' } }))).toBeNull();
  });

  test('eventNodeId reads payload.nodeId', () => {
    expect(eventNodeId(makeEvent())).toBeNull();
    expect(eventNodeId(makeEvent({ payload: { nodeId: '  abc  ' } }))).toBe('abc');
    expect(eventNodeId(makeEvent({ payload: { nodeId: '' } }))).toBeNull();
  });

  test('normalizeHttpUrl rejects non-http', () => {
    expect(normalizeHttpUrl('ftp://x')).toBeNull();
    expect(normalizeHttpUrl('https://ok.example/a')).toBe('https://ok.example/a');
  });
});
