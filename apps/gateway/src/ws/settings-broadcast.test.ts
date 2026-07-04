import { beforeAll, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { createDevice } from '../db';
import { runMigrations } from '../db/migrate';
import { createBorshClientState } from './borsh/codec-borsh';
import { WebSocketServer } from './index';

beforeAll(() => {
  runMigrations();
  const now = new Date().toISOString();
  createDevice({
    id: 'device-x',
    name: 'settings-broadcast-test',
    type: 'local',
    authMode: 'auto',
    session: 'test-session',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

function createMockClient() {
  return {
    data: { borshState: createBorshClientState() },
    sent: [] as Uint8Array[],
    send(message: Uint8Array) {
      this.sent.push(message);
    },
  };
}

function decodeSettingsUpdate(frame: Uint8Array): {
  kind: number;
  namespace: string;
  serverTimestamp: bigint;
} {
  const envelope = wsBorsh.decodeEnvelope(frame);
  const payload = wsBorsh.decodePayload(
    wsBorsh.schema.SettingsUpdateS2CSchema,
    envelope.payload as Uint8Array
  );
  return {
    kind: envelope.kind,
    namespace: payload.namespace,
    serverTimestamp: payload.serverTimestamp,
  };
}

describe('broadcastSettingsUpdate', () => {
  test('向所有 connected clients 发送 KIND_SETTINGS_UPDATE', () => {
    const server = new WebSocketServer();
    const client1 = createMockClient();
    const client2 = createMockClient();
    server.connectedClients.add(client1 as never);
    server.connectedClients.add(client2 as never);

    server.broadcastSettingsUpdate('site');

    for (const client of [client1, client2]) {
      expect(client.sent.length).toBe(1);
      const decoded = decodeSettingsUpdate(client.sent[0]);
      expect(decoded.kind).toBe(wsBorsh.KIND_SETTINGS_UPDATE);
      expect(decoded.namespace).toBe('site');
      expect(decoded.serverTimestamp).toBeGreaterThan(0n);
    }
  });

  test('serverTimestamp 严格递增（含同毫秒并发）', () => {
    const server = new WebSocketServer();
    const client = createMockClient();
    server.connectedClients.add(client as never);

    server.broadcastSettingsUpdate('llm');
    server.broadcastSettingsUpdate('llm');
    server.broadcastSettingsUpdate('webhooks');

    expect(client.sent.length).toBe(3);
    const timestamps = client.sent.map((frame) => decodeSettingsUpdate(frame).serverTimestamp);
    expect(timestamps[1]).toBeGreaterThan(timestamps[0]);
    expect(timestamps[2]).toBeGreaterThan(timestamps[1]);
  });

  test('tree overlay 写路径触发 tree-order 广播', () => {
    const server = new WebSocketServer();
    const client = createMockClient();
    server.connectedClients.add(client as never);

    server.renameWindow('device-x', '@1', 'build');
    server.renamePane('device-x', '%1', 'logs');
    server.reorderWindows('device-x', ['@2', '@1']);
    server.reorderPanes('device-x', '@1', ['%2', '%1']);

    expect(client.sent.length).toBe(4);
    for (const frame of client.sent) {
      const decoded = decodeSettingsUpdate(frame);
      expect(decoded.kind).toBe(wsBorsh.KIND_SETTINGS_UPDATE);
      expect(decoded.namespace).toBe('tree-order');
    }
  });

  test('自定义名 overlay 可经 getCustomNames 读出', () => {
    const server = new WebSocketServer();
    server.renameWindow('device-y', '@1', 'build');
    server.renamePane('device-y', '%3', 'logs');

    expect(server.getCustomNames('device-y')).toEqual({
      windows: { '@1': 'build' },
      panes: { '%3': 'logs' },
    });

    server.renameWindow('device-y', '@1', '');
    expect(server.getCustomNames('device-y').windows).toEqual({});
  });
});
