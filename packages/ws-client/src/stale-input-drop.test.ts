import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { CanonicalPendingCommands } from './canonical-pending-commands';
import { BorshWebSocketClient } from './client';
import {
  DEFAULT_RECONNECT_BUDGET_MS,
  PendingSendQueue,
  STALE_INPUT_TTL_MS,
  staleInputTtlMs,
} from './pending-send-queue';
import { createFakeSocket, helloFrame } from './test-fakes';
import type { GatewayTransportCommand, GatewayTransportEvent } from './transport-types';
import { WebSocketGatewayTransport } from './websocket-transport';

function payload(size: number, fill = 1): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function input(data: string): GatewayTransportCommand {
  return { type: 'terminal-input', deviceId: 'dev', paneId: '%1', data, isComposing: false };
}

function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe('PendingSendQueue.dropStaleOrderedInput', () => {
  test('超过 TTL 的有序输入被丢弃，未超时的保留', () => {
    const clock = fakeClock();
    const queue = new PendingSendQueue({
      maxBytes: 10_000,
      maxFrames: 64,
      now: clock.now,
      reconnectBudgetMs: 1_000,
    });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 1));
    queue.enqueue(wsBorsh.KIND_TERM_PASTE, payload(4, 2));
    clock.advance(STALE_INPUT_TTL_MS + 1);
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 3));

    expect(queue.dropStaleOrderedInput()).toMatchObject({ reason: 'stale', droppedFrames: 2 });
    expect(queue.frameCount).toBe(1);
    expect(queue.pendingBytes).toBe(4);
    expect([...queue.drain()[0].payload]).toEqual([...payload(4, 3)]);
  });

  test('结构性命令不受 TTL 影响', () => {
    const clock = fakeClock();
    const queue = new PendingSendQueue({
      maxBytes: 10_000,
      maxFrames: 64,
      now: clock.now,
      reconnectBudgetMs: 1_000,
    });
    queue.enqueue(wsBorsh.KIND_DEVICE_CONNECT, payload(4, 9));
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 1));
    clock.advance(STALE_INPUT_TTL_MS + 1);

    expect(queue.dropStaleOrderedInput()).toMatchObject({ droppedFrames: 1 });
    expect(queue.drain().map((frame) => frame.kind)).toEqual([wsBorsh.KIND_DEVICE_CONNECT]);
  });

  test('TTL 内的输入原样重放，不丢帧也不提示', () => {
    const clock = fakeClock();
    const queue = new PendingSendQueue({
      maxBytes: 10_000,
      maxFrames: 64,
      now: clock.now,
      reconnectBudgetMs: 1_000,
    });
    queue.enqueue(wsBorsh.KIND_TERM_INPUT, payload(4, 1));
    clock.advance(STALE_INPUT_TTL_MS);

    expect(queue.dropStaleOrderedInput()).toBeNull();
    expect(queue.frameCount).toBe(1);
  });
});

describe('CanonicalPendingCommands stale flush', () => {
  function setup(clockStart = 1_000) {
    const clock = fakeClock(clockStart);
    const events: GatewayTransportEvent[] = [];
    const pending = new CanonicalPendingCommands(
      (event) => events.push(event),
      1_000_000,
      1_000,
      clock.now,
      1_000
    );
    return { clock, events, pending };
  }

  test('过期输入被丢弃且只提示一次；结构性命令照常下发', () => {
    const { clock, events, pending } = setup();
    pending.enqueue(input('exit\r'), true);
    pending.enqueue({ type: 'select-window', deviceId: 'dev', windowId: '@1' }, true);
    clock.advance(STALE_INPUT_TTL_MS + 1);
    pending.enqueue(input('ls'), true);

    const sent: GatewayTransportCommand[] = [];
    pending.flush((command) => {
      sent.push(command);
      return 'sent';
    });

    expect(sent.map((command) => command.type)).toEqual(['select-window', 'terminal-input']);
    const drops = events.filter(
      (event) => event.type === 'pending-overflow' && event.reason === 'stale'
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ droppedFrames: 1, pendingFrames: 2 });
  });

  test('无过期输入时不发提示', () => {
    const { events, pending } = setup();
    pending.enqueue(input('a'), true);
    pending.flush(() => 'sent');
    expect(events.filter((event) => event.type === 'pending-overflow')).toHaveLength(0);
  });

  test('缺省 TTL 盖住 30s 重连窗口：10s 处不丢，45s 后才丢', () => {
    const clock = fakeClock();
    const events: GatewayTransportEvent[] = [];
    const pending = new CanonicalPendingCommands(
      (event) => events.push(event),
      1_000_000,
      1_000,
      clock.now
    );
    expect(staleInputTtlMs(DEFAULT_RECONNECT_BUDGET_MS)).toBe(45_000);

    pending.enqueue(input('keep'), true);
    clock.advance(STALE_INPUT_TTL_MS + 1);
    const kept: GatewayTransportCommand[] = [];
    pending.flush((command) => {
      kept.push(command);
      return 'sent';
    });
    expect(kept.map((command) => command.type)).toEqual(['terminal-input']);
    expect(events.filter((event) => event.type === 'pending-overflow')).toHaveLength(0);

    pending.enqueue(input('drop'), true);
    clock.advance(45_000 + 1);
    const later: GatewayTransportCommand[] = [];
    pending.flush((command) => {
      later.push(command);
      return 'sent';
    });
    expect(later).toHaveLength(0);
    expect(
      events.filter((event) => event.type === 'pending-overflow' && event.reason === 'stale')
    ).toHaveLength(1);
  });
});

describe('WebSocketGatewayTransport 重连后的重放', () => {
  test('断线期间过期的输入不再重放，并派发一次 stale 提示', () => {
    const clock = fakeClock();
    const socket = createFakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
    });
    client.connect();
    const transport = new WebSocketGatewayTransport(client, clock.now, 1_000);
    const events: GatewayTransportEvent[] = [];
    transport.onEvent((event) => events.push(event));

    expect(transport.send(input('exit\r'))).toBe('queued');
    clock.advance(STALE_INPUT_TTL_MS + 1);
    expect(transport.send(input('ls'))).toBe('queued');

    socket.open();
    socket.deliver(helloFrame());

    const drops = events.filter(
      (event) => event.type === 'pending-overflow' && event.reason === 'stale'
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ droppedFrames: 1 });
    client.disconnect();
  });

  test('缺省 TTL 盖住 30s 重连窗口，10s 处仍重放', () => {
    const clock = fakeClock();
    const socket = createFakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
    });
    client.connect();
    const transport = new WebSocketGatewayTransport(client, clock.now);
    const events: GatewayTransportEvent[] = [];
    transport.onEvent((event) => events.push(event));

    expect(transport.send(input('keep'))).toBe('queued');
    clock.advance(STALE_INPUT_TTL_MS + 1);
    socket.open();
    socket.deliver(helloFrame());

    expect(
      events.filter((event) => event.type === 'pending-overflow' && event.reason === 'stale')
    ).toHaveLength(0);
    client.disconnect();
  });

  test('client.reconnectBudgetMs 可覆盖缺省预算', () => {
    const clock = fakeClock();
    const socket = createFakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
    });
    Object.assign(client, { reconnectBudgetMs: 1_000 });
    client.connect();
    const transport = new WebSocketGatewayTransport(client, clock.now);
    const events: GatewayTransportEvent[] = [];
    transport.onEvent((event) => events.push(event));

    expect(transport.send(input('exit\r'))).toBe('queued');
    clock.advance(STALE_INPUT_TTL_MS + 1);
    socket.open();
    socket.deliver(helloFrame());

    expect(
      events.filter((event) => event.type === 'pending-overflow' && event.reason === 'stale')
    ).toHaveLength(1);
    client.disconnect();
  });
});
