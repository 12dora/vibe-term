import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { BorshWebSocketClient } from './client';
import { type FakeSocket, createFakeSocket, helloFrame } from './test-fakes';
import { WebSocketGatewayTransport } from './websocket-transport';

function connectingClient(
  socket: FakeSocket,
  extra: { maxPendingBytes?: number; maxPendingFrames?: number } = {}
): BorshWebSocketClient {
  const client = new BorshWebSocketClient({
    url: 'ws://example.test/ws',
    socketFactory: () => socket,
    heartbeatIntervalMs: 60_000,
    ...extra,
  });
  client.connect();
  return client;
}

function becomeReady(socket: FakeSocket): void {
  socket.open();
  socket.deliver(helloFrame());
}

function payloadKinds(socket: FakeSocket): number[] {
  const kinds: number[] = [];
  for (const frame of socket.sent) {
    if (!(frame instanceof Uint8Array)) continue;
    kinds.push(wsBorsh.decodeEnvelope(frame).kind);
  }
  return kinds;
}

describe('未就绪待发队列', () => {
  test('小队列按入队顺序在 READY 时 flush，send 返回 queued', () => {
    const socket = createFakeSocket();
    const client = connectingClient(socket);

    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array([1]))).toBe('queued');
    expect(client.send(wsBorsh.KIND_DEVICE_CONNECT, new Uint8Array([2]))).toBe('queued');
    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array([3]))).toBe('queued');
    expect(socket.sent).toEqual([]);

    becomeReady(socket);

    const kinds = payloadKinds(socket).filter((kind) => kind !== wsBorsh.KIND_HELLO_C2S);
    const pingIndex = kinds.indexOf(wsBorsh.KIND_PING);
    const flushed = pingIndex >= 0 ? kinds.slice(0, pingIndex) : kinds;
    expect(flushed).toEqual([
      wsBorsh.KIND_TERM_INPUT,
      wsBorsh.KIND_DEVICE_CONNECT,
      wsBorsh.KIND_TERM_INPUT,
    ]);

    client.disconnect();
  });

  test('超过旧的 100 帧上限仍可排队（默认 2048）', () => {
    const socket = createFakeSocket();
    const client = connectingClient(socket);
    for (let i = 0; i < 101; i++) {
      expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array([i & 0xff]))).toBe('queued');
    }
    becomeReady(socket);
    const inputs = payloadKinds(socket).filter((kind) => kind === wsBorsh.KIND_TERM_INPUT);
    expect(inputs).toHaveLength(101);
    client.disconnect();
  });

  test('字节预算溢出返回 overflow，并只派发一次 pending-overflow', () => {
    const socket = createFakeSocket();
    const client = connectingClient(socket, { maxPendingBytes: 16, maxPendingFrames: 32 });
    const overflows: Array<{ kind: number; droppedFrames: number }> = [];
    client.onPendingOverflow((info) => overflows.push(info));

    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array(10))).toBe('queued');
    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array(10))).toBe('overflow');
    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array(2))).toBe('overflow');
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toMatchObject({ kind: wsBorsh.KIND_TERM_INPUT, droppedFrames: 1 });

    becomeReady(socket);
    expect(payloadKinds(socket).filter((kind) => kind === wsBorsh.KIND_TERM_INPUT)).toEqual([]);
    client.disconnect();
  });

  test('有序输入 overflow 丢掉整段输入，控制帧仍会 flush', () => {
    const socket = createFakeSocket();
    const client = connectingClient(socket, { maxPendingBytes: 16, maxPendingFrames: 32 });

    expect(client.send(wsBorsh.KIND_DEVICE_CONNECT, new Uint8Array(4))).toBe('queued');
    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array(8))).toBe('queued');
    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array(8))).toBe('overflow');

    becomeReady(socket);
    const kinds = payloadKinds(socket).filter(
      (kind) => kind !== wsBorsh.KIND_HELLO_C2S && kind !== wsBorsh.KIND_PING
    );
    expect(kinds).toEqual([wsBorsh.KIND_DEVICE_CONNECT]);
    client.disconnect();
  });

  test('READY 后小帧 send 仍返回 sent', () => {
    const socket = createFakeSocket();
    const client = connectingClient(socket);
    becomeReady(socket);
    expect(client.send(wsBorsh.KIND_TERM_INPUT, new Uint8Array([9]))).toBe('sent');
    client.disconnect();
  });

  test('transport.send 透出 overflow，并转发 pending-overflow 事件', () => {
    const socket = createFakeSocket();
    const client = connectingClient(socket, { maxPendingFrames: 1, maxPendingBytes: 4096 });
    const transport = new WebSocketGatewayTransport(client);
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));

    const first = transport.send({
      type: 'terminal-input',
      deviceId: 'dev',
      paneId: '%1',
      data: 'a',
      isComposing: false,
    });
    const second = transport.send({
      type: 'terminal-input',
      deviceId: 'dev',
      paneId: '%1',
      data: 'b',
      isComposing: false,
    });

    expect(first).toBe('queued');
    expect(second).toBe('overflow');
    expect(events).toEqual(['pending-overflow']);
    client.disconnect();
  });
});
