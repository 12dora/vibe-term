import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { AgentSyncEventPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { appendAgentMessage, createAgentConfirmation, createAgentSession } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { createGatewaySession } from '../ws/test-helpers';
import { AgentWsHub } from './ws-hub';

function createMockWs(options?: Parameters<typeof createGatewaySession>[0]) {
  return createGatewaySession(options);
}

function requireFrame(frames: Uint8Array[], index = 0): Uint8Array {
  const frame = frames[index];
  if (!frame) throw new Error(`expected frame at ${index}`);
  return frame;
}

function decodeAgentEvent(data: Uint8Array) {
  const envelope = wsBorsh.decodeEnvelope(data);
  expect(envelope.kind).toBe(wsBorsh.KIND_AGENT_EVENT);
  const decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentEventSchema, envelope.payload);
  return {
    ...decoded,
    json: JSON.parse(new TextDecoder().decode(decoded.payload)),
  };
}

function decodeWatchEvent(data: Uint8Array) {
  const envelope = wsBorsh.decodeEnvelope(data);
  expect(envelope.kind).toBe(wsBorsh.KIND_WATCH_EVENT);
  const decoded = wsBorsh.decodePayload(wsBorsh.schema.WatchEventSchema, envelope.payload);
  return {
    ...decoded,
    json: JSON.parse(new TextDecoder().decode(decoded.payload)),
  };
}

const stubSync: AgentSyncEventPayload = {
  status: 'idle',
  lastError: null,
  inProgressText: '',
  inProgressReasoning: '',
  pendingConfirmations: [],
  queuedMessages: [],
  lastMessageSeq: -1,
};

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('AgentWsHub', () => {
  test('subscribe 后立即回发 sync 事件（seq=0）', async () => {
    const hub = new AgentWsHub({
      syncProvider: async () => ({ ...stubSync, inProgressText: 'partial' }),
    });
    const ws = createMockWs();

    await hub.subscribe(ws, 'session-1');

    expect(ws.sent.length).toBe(1);
    const event = decodeAgentEvent(requireFrame(ws.sent));
    expect(event.sessionId).toBe('session-1');
    expect(event.seq).toBe(0);
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_SYNC);
    expect(event.json.inProgressText).toBe('partial');
  });

  test('syncProvider 返回 null 时不回发 sync', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();

    await hub.subscribe(ws, 'missing-session');
    expect(ws.sent.length).toBe(0);
  });

  test('broadcastAgentEvent 只发给对应 session 的订阅者', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const subscriber = createMockWs();
    const otherSubscriber = createMockWs();
    const nonSubscriber = createMockWs();

    hub.registerClient(nonSubscriber);
    await hub.subscribe(subscriber, 'session-a');
    await hub.subscribe(otherSubscriber, 'session-b');

    hub.broadcastAgentEvent(
      'session-a',
      wsBorsh.AGENT_EVENT_TEXT_DELTA,
      {
        messageId: 'm1',
        delta: 'hi',
      },
      5
    );

    expect(subscriber.sent.length).toBe(1);
    expect(otherSubscriber.sent.length).toBe(0);
    expect(nonSubscriber.sent.length).toBe(0);

    const event = decodeAgentEvent(requireFrame(subscriber.sent));
    expect(event.sessionId).toBe('session-a');
    expect(event.seq).toBe(5);
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_TEXT_DELTA);
    expect(event.json).toEqual({ messageId: 'm1', delta: 'hi' });
  });

  test('unsubscribe 后不再收到广播', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();

    await hub.subscribe(ws, 'session-a');
    hub.unsubscribe(ws, 'session-a');

    hub.broadcastAgentEvent('session-a', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);
    expect(ws.sent.length).toBe(0);
  });

  test('removeClient 清理全部订阅与客户端集合', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();

    hub.registerClient(ws);
    await hub.subscribe(ws, 'session-a');
    await hub.subscribe(ws, 'session-b');

    hub.removeClient(ws);

    hub.broadcastAgentEvent('session-a', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);
    hub.broadcastAgentEvent('session-b', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);
    hub.broadcastWatchEvent('rule-1', 'device-1', '%1', wsBorsh.WATCH_EVENT_TRIGGERED, {
      summary: 's',
    });
    expect(ws.sent.length).toBe(0);
  });

  test('broadcastWatchEvent 发给所有已注册客户端（与订阅无关）', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const client1 = createMockWs();
    const client2 = createMockWs();
    const unregistered = createMockWs();

    hub.registerClient(client1);
    hub.registerClient(client2);

    hub.broadcastWatchEvent('rule-1', 'device-1', '%1', wsBorsh.WATCH_EVENT_TRIGGERED, {
      summary: 'matched',
      matchedText: 'ERROR',
    });

    expect(client1.sent.length).toBe(1);
    expect(client2.sent.length).toBe(1);
    expect(unregistered.sent.length).toBe(0);

    const event = decodeWatchEvent(requireFrame(client1.sent));
    expect(event.ruleId).toBe('rule-1');
    expect(event.deviceId).toBe('device-1');
    expect(event.paneId).toBe('%1');
    expect(event.eventType).toBe(wsBorsh.WATCH_EVENT_TRIGGERED);
    expect(event.json).toEqual({ summary: 'matched', matchedText: 'ERROR' });
  });

  test('subscribe 等待 sync 期间退订则不回发', async () => {
    let resolveSync: (value: AgentSyncEventPayload) => void = () => {};
    const hub = new AgentWsHub({
      syncProvider: () =>
        new Promise<AgentSyncEventPayload>((resolve) => {
          resolveSync = resolve;
        }),
    });
    const ws = createMockWs();

    const pending = hub.subscribe(ws, 'session-a');
    hub.unsubscribe(ws, 'session-a');
    resolveSync(stubSync);
    await pending;

    expect(ws.sent.length).toBe(0);
  });

  test('默认 syncProvider 从 DB 读取 status/confirmations/lastMessageSeq', async () => {
    const session = createAgentSession({ title: 'hub-test', modelId: 'gpt-test' });
    appendAgentMessage(session.id, 'user', { text: 'hello' });
    appendAgentMessage(session.id, 'assistant', { text: 'world' });
    const confirmation = createAgentConfirmation({
      sessionId: session.id,
      toolName: 'write_pane',
      toolCallId: 'call-1',
      inputJson: { text: 'ls' },
    });

    const hub = new AgentWsHub();
    const ws = createMockWs();
    await hub.subscribe(ws, session.id);

    expect(ws.sent.length).toBe(1);
    const event = decodeAgentEvent(requireFrame(ws.sent));
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_SYNC);
    const sync = event.json as AgentSyncEventPayload;
    expect(sync.status).toBe('idle');
    expect(sync.inProgressText).toBe('');
    expect(sync.lastMessageSeq).toBe(1);
    expect(sync.pendingConfirmations).toEqual([
      {
        confirmationId: confirmation.id,
        toolCallId: 'call-1',
        toolName: 'write_pane',
        input: { text: 'ls' },
        createdAt: confirmation.createdAt,
      },
    ]);
  });

  test('payload 超过 maxFrameBytes 时走分片路径且可重组', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const ws = createMockWs();
    ws.borshState.maxFrameBytes = 256;

    await hub.subscribe(ws, 'session-big');

    const bigDelta = 'x'.repeat(2048);
    hub.broadcastAgentEvent(
      'session-big',
      wsBorsh.AGENT_EVENT_TEXT_DELTA,
      { messageId: 'm1', delta: bigDelta },
      7
    );

    expect(ws.sent.length).toBeGreaterThan(1);

    const reassembler = new wsBorsh.ChunkReassembler();
    let message: wsBorsh.ReassembledMessage | null = null;
    for (const frame of ws.sent) {
      expect(frame.length).toBeLessThanOrEqual(256);
      const envelope = wsBorsh.decodeEnvelope(frame);
      expect(envelope.kind).toBe(wsBorsh.KIND_CHUNK);
      expect(message).toBeNull();
      message = reassembler.addChunk(wsBorsh.decodeChunk(envelope.payload));
    }

    expect(message).not.toBeNull();
    if (!message) throw new Error('expected reassembled message');
    expect(message.kind).toBe(wsBorsh.KIND_AGENT_EVENT);
    const decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentEventSchema, message.payload);
    expect(decoded.sessionId).toBe('session-big');
    expect(decoded.seq).toBe(7);
    expect(decoded.eventType).toBe(wsBorsh.AGENT_EVENT_TEXT_DELTA);
    const json = JSON.parse(new TextDecoder().decode(decoded.payload));
    expect(json).toEqual({ messageId: 'm1', delta: bigDelta });
  });

  test('单个订阅者 send 抛错不影响其他订阅者收到广播', async () => {
    const hub = new AgentWsHub({ syncProvider: async () => null });
    const broken = createMockWs({
      send() {
        throw new Error('connection closed');
      },
    });
    const healthy = createMockWs();

    await hub.subscribe(broken, 'session-a');
    await hub.subscribe(healthy, 'session-a');

    hub.broadcastAgentEvent('session-a', wsBorsh.AGENT_EVENT_STATUS, { status: 'running' }, 1);

    expect(healthy.sent.length).toBe(1);
    const event = decodeAgentEvent(requireFrame(healthy.sent));
    expect(event.eventType).toBe(wsBorsh.AGENT_EVENT_STATUS);
    expect(event.json).toEqual({ status: 'running' });

    hub.registerClient(broken);
    hub.registerClient(healthy);
    hub.broadcastWatchEvent('rule-1', 'device-1', '%1', wsBorsh.WATCH_EVENT_TRIGGERED, {
      summary: 'matched',
    });
    expect(healthy.sent.length).toBe(2);
    expect(decodeWatchEvent(requireFrame(healthy.sent, 1)).json).toEqual({ summary: 'matched' });
  });

  test('默认 syncProvider 对不存在的 session 不回发', async () => {
    const hub = new AgentWsHub();
    const ws = createMockWs();
    await hub.subscribe(ws, crypto.randomUUID());
    expect(ws.sent.length).toBe(0);
  });
});
