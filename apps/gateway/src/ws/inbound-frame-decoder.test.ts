import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { decodeInboundFrame } from './inbound-frame-decoder';

function pingPayload(): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
    nonce: 42,
    timeMs: 99n,
  });
}

describe('decodeInboundFrame', () => {
  test('missing magic is an invalid-frame error', () => {
    expect(
      decodeInboundFrame(new Uint8Array([0x00, 0x01]), new wsBorsh.ChunkReassembler())
    ).toEqual({
      status: 'error',
      code: wsBorsh.ERROR_INVALID_FRAME,
      message: 'Missing magic bytes',
      retryable: false,
    });
  });

  test('magic present but envelope too small keeps decode error metadata', () => {
    expect(
      decodeInboundFrame(new Uint8Array([0x54, 0x58, 0x00]), new wsBorsh.ChunkReassembler())
    ).toEqual({
      status: 'error',
      code: wsBorsh.ERROR_INVALID_FRAME,
      message: 'Envelope too small',
      retryable: false,
    });
  });

  test('malformed chunk payload is an invalid-chunk error', () => {
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_CHUNK, new Uint8Array([0xff]), 3);
    expect(decodeInboundFrame(frame, new wsBorsh.ChunkReassembler())).toEqual({
      status: 'error',
      code: wsBorsh.ERROR_INVALID_FRAME,
      message: 'Invalid chunk',
      retryable: false,
    });
  });

  test('incomplete chunk reassembly is ignored', () => {
    const frame = wsBorsh.encodeChunk(
      {
        chunkStreamId: 1,
        originalKind: wsBorsh.KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: new Uint8Array([1, 2, 3, 4]),
      },
      8
    );
    expect(decodeInboundFrame(frame, new wsBorsh.ChunkReassembler())).toEqual({ status: 'ignore' });
  });

  test('complete chunk reassembly yields the original kind/seq/payload', () => {
    const reassembler = new wsBorsh.ChunkReassembler();
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = decodeInboundFrame(
      wsBorsh.encodeChunk(
        {
          chunkStreamId: 9,
          originalKind: wsBorsh.KIND_PING,
          originalSeq: 100,
          totalChunks: 2,
          chunkIndex: 0,
          data: payload.slice(0, 4),
        },
        1
      ),
      reassembler
    );
    expect(first).toEqual({ status: 'ignore' });

    const second = decodeInboundFrame(
      wsBorsh.encodeChunk(
        {
          chunkStreamId: 9,
          originalKind: wsBorsh.KIND_PING,
          originalSeq: 100,
          totalChunks: 2,
          chunkIndex: 1,
          data: payload.slice(4),
        },
        2
      ),
      reassembler
    );
    expect(second).toEqual({
      status: 'ok',
      kind: wsBorsh.KIND_PING,
      seq: 100,
      payload,
    });
  });

  test('non-chunk envelope yields kind/seq/payload', () => {
    const payload = pingPayload();
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, payload, 7);
    expect(decodeInboundFrame(frame, new wsBorsh.ChunkReassembler())).toEqual({
      status: 'ok',
      kind: wsBorsh.KIND_PING,
      seq: 7,
      payload,
    });
  });

  test('chunk reassembler WsBorshError metadata is preserved', () => {
    const frame = wsBorsh.encodeChunk(
      {
        chunkStreamId: 1,
        originalKind: wsBorsh.KIND_PING,
        originalSeq: 1,
        totalChunks: 1,
        chunkIndex: 2,
        data: new Uint8Array([1]),
      },
      1
    );
    const result = decodeInboundFrame(frame, new wsBorsh.ChunkReassembler());
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.code).toBe(wsBorsh.ERROR_INVALID_FRAME);
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/Chunk index out of bounds/);
  });
});
