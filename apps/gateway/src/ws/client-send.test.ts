import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { encodeClientError, sendClientChunked } from './client-send';
import { createBorshTestWs } from './test-helpers';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

describe('client send helpers', () => {
  test('encodeClientError encodes KIND_ERROR with refSeq and retryable', () => {
    const ws = createBorshTestWs();
    sendClientChunked(
      ws,
      wsBorsh.KIND_ERROR,
      encodeClientError(11, wsBorsh.ERROR_INVALID_FRAME, 'HELLO required', false)
    );

    expect(ws.sent).toHaveLength(1);
    const envelope = wsBorsh.decodeEnvelope(ws.sent[0]);
    expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
    const error = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
    expect(error.refSeq).toBe(11);
    expect(error.code).toBe(wsBorsh.ERROR_INVALID_FRAME);
    expect(error.message).toBe('HELLO required');
    expect(error.retryable).toBe(false);
  });

  test('encodeClientError allows null refSeq', () => {
    const ws = createBorshTestWs();
    sendClientChunked(
      ws,
      wsBorsh.KIND_ERROR,
      encodeClientError(null, wsBorsh.ERROR_INTERNAL_ERROR, 'boom', true)
    );

    const error = wsBorsh.decodePayload(
      wsBorsh.schema.ErrorSchema,
      wsBorsh.decodeEnvelope(ws.sent[0]).payload
    );
    expect(error.refSeq).toBe(null);
    expect(error.retryable).toBe(true);
  });

  test('sendClientChunked returns false when the send guard is already backpressured', () => {
    const ws = createBorshTestWs({
      send() {
        return -1;
      },
    });
    const first = sendClientChunked(ws, wsBorsh.KIND_PONG, new Uint8Array([1]));
    const second = sendClientChunked(ws, wsBorsh.KIND_PONG, new Uint8Array([2]));
    expect(first).toBe(false);
    expect(second).toBe(false);
    gatewayWebSocketSendGuard.forget(ws);
  });

  test('sendClientChunked chunks payloads that exceed maxFrameBytes', () => {
    const sent: Uint8Array[] = [];
    const ws = createBorshTestWs({
      send(frame) {
        sent.push(new Uint8Array(frame));
        return frame.byteLength;
      },
    });
    ws.data.borshState.maxFrameBytes = 128;
    sendClientChunked(ws, wsBorsh.KIND_NOTIFY_EVENT, new Uint8Array(512));

    expect(sent.length).toBeGreaterThan(1);
    for (const frame of sent) {
      expect(frame.byteLength).toBeLessThanOrEqual(128);
      expect(wsBorsh.decodeEnvelope(frame).kind).toBe(wsBorsh.KIND_CHUNK);
    }
  });
});
