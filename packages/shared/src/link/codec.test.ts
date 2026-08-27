import { describe, expect, it } from 'bun:test';
import {
  FLAG_HEAD,
  FrameDecoder,
  FrameOp,
  MAX_FRAME_PAYLOAD,
  decodeWindowPayload,
  encodeFrame,
  encodeFrameHeader,
  encodeWindowPayload,
  peekFrameHeader,
  readU32LE,
} from './index';
import { LinkError } from './types';

describe('link codec', () => {
  it('round-trips streamId, op, flags, payload', () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const encoded = encodeFrame({
      streamId: 0x01020304,
      op: FrameOp.DATA,
      flags: FLAG_HEAD,
      payload,
    });
    expect(encoded.byteLength).toBe(10 + payload.byteLength);
    expect(readU32LE(encoded, 0)).toBe(0x01020304);
    expect(encoded[4]).toBe(FrameOp.DATA);
    expect(encoded[5]).toBe(FLAG_HEAD);
    expect(readU32LE(encoded, 6)).toBe(payload.byteLength);

    const frames = new FrameDecoder().push(encoded);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      streamId: 0x01020304,
      op: FrameOp.DATA,
      flags: FLAG_HEAD,
      payload,
    });
  });

  it('encodes empty payload and WINDOW delta as u32 LE', () => {
    const encoded = encodeFrame({
      streamId: 0,
      op: FrameOp.WINDOW,
      payload: encodeWindowPayload(0x10203040),
    });
    const [frame] = new FrameDecoder().push(encoded);
    expect(frame).toBeDefined();
    if (!frame) throw new Error('expected WINDOW frame');
    expect(frame.op).toBe(FrameOp.WINDOW);
    expect(decodeWindowPayload(frame.payload)).toBe(0x10203040);
  });

  it('reassembles partial input across pushes', () => {
    const payload = new Uint8Array(64).map((_, i) => i);
    const encoded = encodeFrame({ streamId: 7, op: FrameOp.OPEN, payload });
    const decoder = new FrameDecoder();
    expect(decoder.push(encoded.slice(0, 3))).toEqual([]);
    expect(decoder.push(encoded.slice(3, 10))).toEqual([]);
    expect(decoder.push(encoded.slice(10, 20))).toEqual([]);
    const rest = decoder.push(encoded.slice(20));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.streamId).toBe(7);
    expect(rest[0]?.op).toBe(FrameOp.OPEN);
    expect(rest[0]?.payload).toEqual(payload);
  });

  it('splits coalesced frames in one push', () => {
    const a = encodeFrame({ streamId: 1, op: FrameOp.DATA, payload: new Uint8Array([1]) });
    const b = encodeFrame({ streamId: 2, op: FrameOp.END });
    const c = encodeFrame({ streamId: 3, op: FrameOp.RST, payload: new TextEncoder().encode('x') });
    const joined = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
    joined.set(a, 0);
    joined.set(b, a.byteLength);
    joined.set(c, a.byteLength + b.byteLength);
    const frames = new FrameDecoder().push(joined);
    expect(frames.map((f) => f.op)).toEqual([FrameOp.DATA, FrameOp.END, FrameOp.RST]);
    expect(frames.map((f) => f.streamId)).toEqual([1, 2, 3]);
  });

  it('throws on oversize payload length in the header before buffering the body', () => {
    const header = encodeFrameHeader(1, FrameOp.DATA, 0, MAX_FRAME_PAYLOAD + 1);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header)).toThrow(LinkError);
    try {
      decoder.push(header);
    } catch (err) {
      expect(err).toBeInstanceOf(LinkError);
      expect((err as LinkError).code).toBe('oversize');
    }
  });

  it('rejects unknown op', () => {
    const encoded = encodeFrame({ streamId: 1, op: 9, payload: new Uint8Array([1]) });
    expect(() => new FrameDecoder().push(encoded)).toThrow(LinkError);
  });

  it('peekFrameHeader reads without consuming payload', () => {
    const encoded = encodeFrame({
      streamId: 11,
      op: FrameOp.DATA,
      flags: 1,
      payload: new Uint8Array([4, 5]),
    });
    expect(peekFrameHeader(encoded)).toEqual({
      streamId: 11,
      op: FrameOp.DATA,
      flags: 1,
      length: 2,
    });
    expect(peekFrameHeader(encoded.slice(0, 9))).toBeNull();
  });

  it('reassembles a 1 MiB frame delivered as 1-byte chunks in well under a second', () => {
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD).fill(7);
    const encoded = encodeFrame({ streamId: 1, op: FrameOp.DATA, payload });
    const decoder = new FrameDecoder();
    const start = performance.now();
    let frames: ReturnType<FrameDecoder['push']> = [];
    for (let i = 0; i < encoded.byteLength; i++) {
      const emitted = decoder.push(encoded.subarray(i, i + 1));
      if (emitted.length > 0) frames = emitted;
    }
    const elapsed = performance.now() - start;
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.byteLength).toBe(MAX_FRAME_PAYLOAD);
    expect(frames[0]?.payload[0]).toBe(7);
    expect(frames[0]?.payload[MAX_FRAME_PAYLOAD - 1]).toBe(7);
    expect(elapsed).toBeLessThan(1000);
  });

  it('emits three complete frames and retains a half frame from coalesced input', () => {
    const a = encodeFrame({ streamId: 1, op: FrameOp.DATA, payload: new Uint8Array([1]) });
    const b = encodeFrame({ streamId: 2, op: FrameOp.END });
    const c = encodeFrame({ streamId: 3, op: FrameOp.RST, payload: new TextEncoder().encode('x') });
    const d = encodeFrame({
      streamId: 4,
      op: FrameOp.DATA,
      payload: new Uint8Array([9, 8, 7, 6, 5, 4]),
    });
    const half = Math.floor(d.byteLength / 2);
    const joined = new Uint8Array(a.byteLength + b.byteLength + c.byteLength + half);
    let offset = 0;
    for (const part of [a, b, c]) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    joined.set(d.subarray(0, half), offset);

    const decoder = new FrameDecoder();
    const first = decoder.push(joined);
    expect(first.map((frame) => frame.op)).toEqual([FrameOp.DATA, FrameOp.END, FrameOp.RST]);
    expect(first.map((frame) => frame.streamId)).toEqual([1, 2, 3]);
    expect(decoder.pending).toBe(half);

    const rest = decoder.push(d.subarray(half));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.streamId).toBe(4);
    expect(rest[0]?.payload).toEqual(new Uint8Array([9, 8, 7, 6, 5, 4]));
    expect(decoder.pending).toBe(0);
  });
});
