import { describe, expect, test } from 'bun:test';
import { BunSocketCarrier } from './carrier';

function createSocket(
  options: {
    send?: (bytes: Uint8Array) => number;
    bufferedAmount?: number;
    close?: (code: number, reason: string) => void;
    terminate?: () => void;
  } = {}
) {
  let sendCalls = 0;
  let terminateCalls = 0;
  const closeCalls: Array<{ code: number; reason: string }> = [];
  const socket = {
    send(bytes: Uint8Array) {
      sendCalls += 1;
      if (options.send) return options.send(bytes);
      return bytes.byteLength;
    },
    getBufferedAmount() {
      return options.bufferedAmount ?? 0;
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
