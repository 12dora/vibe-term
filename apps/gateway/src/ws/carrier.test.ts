import { describe, expect, test } from 'bun:test';
import { BunSocketCarrier } from './carrier';

function createSocket(
  options: {
    send?: (bytes: Uint8Array) => number;
    bufferedAmount?: number | (() => number);
    cork?: () => never;
    close?: (code: number, reason: string) => void;
    terminate?: () => void;
  } = {}
) {
  let sendCalls = 0;
  let terminateCalls = 0;
  let corkCalls = 0;
  let corkDepth = 0;
  const closeCalls: Array<{ code: number; reason: string }> = [];
  const socket = {
    send(bytes: Uint8Array) {
      sendCalls += 1;
      if (options.send) return options.send(bytes);
      return bytes.byteLength;
    },
    cork<T>(callback: (ws: unknown) => T): T {
      corkCalls += 1;
      if (options.cork) options.cork();
      corkDepth += 1;
      try {
        return callback(socket);
      } finally {
        corkDepth -= 1;
      }
    },
    getBufferedAmount() {
      if (corkDepth > 0) throw new Error('buffered amount must be read after the cork');
      const buffered = options.bufferedAmount ?? 0;
      return typeof buffered === 'function' ? buffered() : buffered;
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code: code ?? 0, reason: reason ?? '' });
      options.close?.(code ?? 0, reason ?? '');
    },
    terminate() {
      terminateCalls += 1;
      options.terminate?.();
    },
  };
  return {
    socket,
    sendCalls: () => sendCalls,
    corkCalls: () => corkCalls,
    terminateCalls: () => terminateCalls,
    closeCalls: () => closeCalls,
  };
}

describe('BunSocketCarrier', () => {
  test('maps Bun send() > 0 to sent', () => {
    const target = createSocket({ send: (bytes) => bytes.byteLength });
    const carrier = new BunSocketCarrier(target.socket as never);
    expect(carrier.send(new Uint8Array([1, 2, 3]))).toBe('sent');
    expect(target.sendCalls()).toBe(1);
  });

  test('maps Bun send() === -1 to backpressure', () => {
    const target = createSocket({ send: () => -1 });
    const carrier = new BunSocketCarrier(target.socket as never);
    expect(carrier.send(new Uint8Array([1]))).toBe('backpressure');
  });

  test('maps Bun send() === 0 to closed', () => {
    const target = createSocket({ send: () => 0 });
    const carrier = new BunSocketCarrier(target.socket as never);
    expect(carrier.send(new Uint8Array([1]))).toBe('closed');
  });

  test('maps Bun send() throwing to closed', () => {
    const target = createSocket({
      send: () => {
        throw new Error('gone');
      },
    });
    const carrier = new BunSocketCarrier(target.socket as never);
    expect(carrier.send(new Uint8Array([1]))).toBe('closed');
  });

  test('bufferedAmount reads the socket queue and close/terminate forward', () => {
    const target = createSocket({ bufferedAmount: 41 });
    const carrier = new BunSocketCarrier(target.socket as never);
    expect(carrier.bufferedAmount()).toBe(41);
    carrier.close(1012, 'restart');
    carrier.terminate();
    expect(target.closeCalls()).toEqual([{ code: 1012, reason: 'restart' }]);
    expect(target.terminateCalls()).toBe(1);
  });

  test('sendMany corks the whole batch once and reports the post-batch buffered amount', () => {
    let buffered = 0;
    const target = createSocket({
      send: (bytes) => {
        buffered += bytes.byteLength;
        return bytes.byteLength;
      },
      bufferedAmount: () => buffered,
    });
    const carrier = new BunSocketCarrier(target.socket as never);

    const result = carrier.sendMany([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array(4),
    ]);

    expect(target.corkCalls()).toBe(1);
    expect(target.sendCalls()).toBe(3);
    expect(result.statuses).toEqual(['sent', 'sent', 'sent']);
    expect(result.bufferedAmount).toBe(7);
  });

  test('sendMany stops at the first backpressured frame by default', () => {
    const target = createSocket({
      send: (bytes) => (bytes.byteLength === 2 ? -1 : bytes.byteLength),
    });
    const carrier = new BunSocketCarrier(target.socket as never);

    const result = carrier.sendMany([
      new Uint8Array([1]),
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
    ]);

    expect(result.statuses).toEqual(['sent', 'backpressure']);
    expect(target.sendCalls()).toBe(2);
  });

  test('sendMany keeps sending past backpressure when asked, and still stops on closed', () => {
    const target = createSocket({
      send: (bytes) =>
        bytes.byteLength === 2 ? -1 : bytes.byteLength === 9 ? 0 : bytes.byteLength,
    });
    const carrier = new BunSocketCarrier(target.socket as never);

    const result = carrier.sendMany(
      [new Uint8Array([1]), new Uint8Array([1, 2]), new Uint8Array(9), new Uint8Array([3])],
      { stopOnBackpressure: false }
    );

    expect(result.statuses).toEqual(['sent', 'backpressure', 'closed']);
    expect(target.sendCalls()).toBe(3);
  });

  test('sendMany maps a throwing cork to closed', () => {
    const target = createSocket({
      cork: () => {
        throw new Error('gone');
      },
    });
    const carrier = new BunSocketCarrier(target.socket as never);

    expect(carrier.sendMany([new Uint8Array([1]), new Uint8Array([2])]).statuses).toEqual([
      'closed',
    ]);
  });

  test('onDrain callbacks fire from emitDrain', () => {
    const target = createSocket();
    const carrier = new BunSocketCarrier(target.socket as never);
    let drains = 0;
    carrier.onDrain(() => {
      drains += 1;
    });
    carrier.emitDrain();
    expect(drains).toBe(1);
  });
});
