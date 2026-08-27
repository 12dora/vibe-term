import { describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { WebSocketServer } from './index';
import { createBorshTestWs } from './test-helpers';

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function encodeHelloFrame() {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'inbound-frame-test',
    clientVersion: '0.0.1',
    maxFrameBytes: 65_536,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return {
    payload,
    frame: wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1),
  };
}

describe('WebSocket inbound binary frames', () => {
  test('handlers receive identical payload bytes from an inbound Buffer', async () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const received: Uint8Array[] = [];
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        received.push(payload);
      }
    );

    const { frame, payload } = encodeHelloFrame();
    const inbound = Buffer.from(frame);
    expect(inbound).toBeInstanceOf(Uint8Array);

    server.handleOpen(ws);
    server.handleMessage(ws, inbound);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    handleBorshMessage.mockRestore();
    server.handleClose(ws);
  });

  test('handlers receive identical bytes from a Buffer view over a larger backing store', async () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const received: Uint8Array[] = [];
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        received.push(payload);
      }
    );

    const { frame, payload } = encodeHelloFrame();
    const backing = Buffer.alloc(frame.byteLength + 6, 0xff);
    backing.set(frame, 3);
    const inbound = backing.subarray(3, 3 + frame.byteLength);

    server.handleOpen(ws);
    server.handleMessage(ws, inbound);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    handleBorshMessage.mockRestore();
    server.handleClose(ws);
  });
});
