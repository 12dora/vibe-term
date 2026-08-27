import { beforeAll, describe, expect, test } from 'bun:test';
import type { WebhookEvent } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { ensureSiteSettingsInitialized } from '../db';
import { runMigrations } from '../db/migrate';
import { registerEventNotifyBroadcaster } from '../events/broadcaster';
import { EventNotifier } from '../events/index';
import { WebSocketServer } from './index';
import { createBorshTestWs } from './test-helpers';

beforeAll(() => {
  runMigrations();
  ensureSiteSettingsInitialized();
});

function createMockClient() {
  return createBorshTestWs();
}

function decodeEventNotify(frame: Uint8Array): {
  kind: number;
  eventType: string;
  eventJson: string;
  timestamp: bigint;
} {
  const envelope = wsBorsh.decodeEnvelope(frame);
  const payload = wsBorsh.decodePayload(
    wsBorsh.schema.EventNotifyS2CSchema,
    envelope.payload as Uint8Array
  );
  return {
    kind: envelope.kind,
    eventType: payload.eventType,
    eventJson: payload.eventJson,
    timestamp: payload.timestamp,
  };
}

function buildEvent(timestamp: string): WebhookEvent {
  return {
    eventType: 'terminal_bell',
    timestamp,
    site: { name: 'tmex', url: 'https://tmex.example.com' },
    device: { id: 'device-1', name: 'dev-1', type: 'local' },
    tmux: { windowId: '@1', paneId: '%1', windowIndex: 1, paneIndex: 2 },
  };
}

describe('broadcastEventNotify', () => {
  test('向所有 connected clients 发送 KIND_NOTIFY_EVENT，payload 三字段可解', () => {
    const server = new WebSocketServer();
    const client1 = createMockClient();
    const client2 = createMockClient();
    server.connectedClients.add(client1 as never);
    server.connectedClients.add(client2 as never);

    const event = buildEvent('2026-07-11T08:00:00.000Z');
    server.broadcastEventNotify('terminal_bell', event);

    for (const client of [client1, client2]) {
      expect(client.sent.length).toBe(1);
      const decoded = decodeEventNotify(client.sent[0]);
      expect(decoded.kind).toBe(wsBorsh.KIND_NOTIFY_EVENT);
      expect(decoded.eventType).toBe('terminal_bell');
      expect(JSON.parse(decoded.eventJson)).toEqual(event as unknown as Record<string, unknown>);
      expect(decoded.timestamp).toBe(BigInt(Date.parse('2026-07-11T08:00:00.000Z')));
    }
  });

  test('事件 timestamp 不可解析时回退 Date.now()', () => {
    const server = new WebSocketServer();
    const client = createMockClient();
    server.connectedClients.add(client as never);

    const before = BigInt(Date.now());
    server.broadcastEventNotify('terminal_notification', buildEvent('not-a-timestamp'));
    const after = BigInt(Date.now());

    expect(client.sent.length).toBe(1);
    const decoded = decodeEventNotify(client.sent[0]);
    expect(decoded.timestamp).toBeGreaterThanOrEqual(before);
    expect(decoded.timestamp).toBeLessThanOrEqual(after);
  });

  test('无 connected client 时广播为静默 no-op', () => {
    const server = new WebSocketServer();
    expect(() =>
      server.broadcastEventNotify('terminal_bell', buildEvent('2026-07-11T08:00:00.000Z'))
    ).not.toThrow();
  });

  test('EventNotifier.notify 经 ws-broadcast channel 与注册桥送达 client（全链路）', async () => {
    const server = new WebSocketServer();
    const client = createMockClient();
    server.connectedClients.add(client as never);
    registerEventNotifyBroadcaster((eventType, event) =>
      server.broadcastEventNotify(eventType, event)
    );
    try {
      const notifier = new EventNotifier();
      await notifier.notify('watch_rule_error', {
        site: { name: 'tmex', url: 'https://tmex.example.com' },
        device: { id: 'device-chain', name: 'dev-chain', type: 'local' },
        tmux: { windowId: '@1', paneId: '%1', windowIndex: 1, paneIndex: 2 },
        payload: { message: 'chained' },
      });

      expect(client.sent.length).toBe(1);
      const decoded = decodeEventNotify(client.sent[0]);
      expect(decoded.kind).toBe(wsBorsh.KIND_NOTIFY_EVENT);
      expect(decoded.eventType).toBe('watch_rule_error');
      const parsed = JSON.parse(decoded.eventJson) as WebhookEvent;
      expect(parsed.eventType).toBe('watch_rule_error');
      expect(parsed.payload?.message).toBe('chained');
      expect(decoded.timestamp).toBe(BigInt(Date.parse(parsed.timestamp)));
    } finally {
      registerEventNotifyBroadcaster(null);
    }
  });

  test('注册桥注销后广播不再送达 client', async () => {
    const server = new WebSocketServer();
    const client = createMockClient();
    server.connectedClients.add(client as never);
    registerEventNotifyBroadcaster((eventType, event) =>
      server.broadcastEventNotify(eventType, event)
    );
    registerEventNotifyBroadcaster(null);

    const notifier = new EventNotifier();
    await notifier.notify('watch_rule_error', {
      site: { name: 'tmex', url: 'https://tmex.example.com' },
      device: { id: 'device-unregistered', name: 'dev-u', type: 'local' },
      tmux: { windowId: '@1', paneId: '%1', windowIndex: 1, paneIndex: 2 },
      payload: { message: 'dropped' },
    });

    expect(client.sent.length).toBe(0);
  });
});
