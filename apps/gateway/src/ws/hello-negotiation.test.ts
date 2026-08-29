import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITIES, wsBorsh } from '@tmex/shared';
import { handleHello, handlePing } from './hello-negotiation';
import { WebSocketServer } from './index';
import { createBorshTestWs } from './test-helpers';

function decodeSent(ws: ReturnType<typeof createBorshTestWs>) {
  expect(ws.sent.length).toBeGreaterThan(0);
  return wsBorsh.decodeEnvelope(ws.sent[ws.sent.length - 1]);
}

describe('handleHello', () => {
  test('negotiates, truncates clientImpl, and replies HELLO_S2C', () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const clientImpl = `tmex-fe-${'y'.repeat(80)}`;
    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl,
      clientVersion: 'test',
      maxFrameBytes: 1024,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });

    handleHello(server, ws, 3, payload);

    expect(ws.data.borshState.negotiated).toBe(true);
    expect(ws.data.borshState.clientImpl).toBe(clientImpl.slice(0, 64));
    expect(ws.data.borshState.maxFrameBytes).toBe(1024);

    const envelope = decodeSent(ws);
    expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    const hello = wsBorsh.decodePayload(wsBorsh.schema.HelloS2CSchema, envelope.payload);
    expect(hello.serverImpl).toBe('tmex-gateway');
    expect(hello.selectedVersion).toBe(wsBorsh.CURRENT_VERSION);
    expect(hello.maxFrameBytes).toBe(wsBorsh.DEFAULT_MAX_FRAME_BYTES);
    expect(hello.heartbeatIntervalMs).toBe(15000);
    expect(hello.capabilities).toEqual([...GATEWAY_CAPABILITIES]);
    server.handleClose(ws);
  });

  test('decode failure sends protocol error and does not negotiate', () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();

    handleHello(server, ws, 9, new Uint8Array([0xff]));

    expect(ws.data.borshState.negotiated).toBe(false);
    const envelope = decodeSent(ws);
    expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
    const error = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
    expect(error.refSeq).toBe(9);
    expect(error.code).toBe(wsBorsh.ERROR_PAYLOAD_DECODE_FAILED);
    expect(error.retryable).toBe(false);
  });
});

describe('handlePing', () => {
  test('replies PONG with the same nonce and timeMs', () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
      nonce: 7,
      timeMs: 1234n,
    });

    handlePing(server, ws, 4, payload);

    const envelope = decodeSent(ws);
    expect(envelope.kind).toBe(wsBorsh.KIND_PONG);
    const pong = wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, envelope.payload);
    expect(pong.nonce).toBe(7);
    expect(pong.timeMs).toBe(1234n);
  });

  test('decode failure sends protocol error', () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();

    handlePing(server, ws, 2, new Uint8Array([0x01]));

    const envelope = decodeSent(ws);
    expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
    const error = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
    expect(error.refSeq).toBe(2);
    expect(error.code).toBe(wsBorsh.ERROR_PAYLOAD_DECODE_FAILED);
    expect(error.retryable).toBe(false);
  });
});
