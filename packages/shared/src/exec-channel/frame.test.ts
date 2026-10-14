import { describe, expect, it } from 'bun:test';
import {
  EC_HEADER_BYTES,
  EC_MAX_FRAME_PAYLOAD,
  EcKind,
  EcProtocolError,
  FrameDecoder,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  isKnownKind,
  isLoggedKind,
} from './index';

const bytes = (...values: number[]) => new Uint8Array(values);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

describe('encodeFrame', () => {
  it('writes kind and big-endian length before the payload', () => {
    const frame = encodeFrame(EcKind.STDIN, bytes(1, 2, 3));
    expect(Array.from(frame)).toEqual([0x10, 0, 0, 0, 3, 1, 2, 3]);
  });

  it('encodes an empty payload as header only', () => {
    expect(encodeFrame(EcKind.PING, new Uint8Array(0)).byteLength).toBe(EC_HEADER_BYTES);
  });

  it('rejects payloads above the frame ceiling', () => {
    expect(() => encodeFrame(EcKind.STDOUT, new Uint8Array(EC_MAX_FRAME_PAYLOAD + 1))).toThrow(
      EcProtocolError
    );
    expect(encodeFrame(EcKind.STDOUT, new Uint8Array(EC_MAX_FRAME_PAYLOAD)).byteLength).toBe(
      EC_HEADER_BYTES + EC_MAX_FRAME_PAYLOAD
    );
  });

  it('encodes JSON as UTF-8', () => {
    const frame = encodeJsonFrame(EcKind.ERROR, { message: '中文' });
    const [decoded] = new FrameDecoder().push(frame);
    expect(decoded?.kind).toBe(EcKind.ERROR);
    expect(decodeJson<{ message: string }>(decoded!.payload)).toEqual({ message: '中文' });
  });
});

describe('kind helpers', () => {
  it('flags only stdout, stderr and exit as logged', () => {
    const logged = Object.values(EcKind).filter(isLoggedKind);
    expect(logged.sort()).toEqual([EcKind.STDOUT, EcKind.STDERR, EcKind.EXIT].sort());
  });

  it('knows every defined kind and nothing else', () => {
    for (const kind of Object.values(EcKind)) expect(isKnownKind(kind)).toBe(true);
    expect(isKnownKind(0x00)).toBe(false);
    expect(isKnownKind(0xff)).toBe(false);
  });
});

describe('decodeJson', () => {
  const enc = (text: string) => new TextEncoder().encode(text);

  it('parses objects', () => {
    expect(decodeJson(enc('{"a":1}'))).toEqual({ a: 1 });
  });

  it('rejects malformed JSON, invalid UTF-8 and non-object roots', () => {
    expect(() => decodeJson(enc('{'))).toThrow(EcProtocolError);
    expect(() => decodeJson(bytes(0xff, 0xfe))).toThrow(EcProtocolError);
    expect(() => decodeJson(enc('[1]'))).toThrow(EcProtocolError);
    expect(() => decodeJson(enc('null'))).toThrow(EcProtocolError);
    expect(() => decodeJson(enc('"x"'))).toThrow(EcProtocolError);
  });
});

describe('FrameDecoder', () => {
  const sample = [
    encodeFrame(EcKind.STDOUT, bytes(10, 20, 30, 40)),
    encodeFrame(EcKind.PING, new Uint8Array(0)),
    encodeJsonFrame(EcKind.RESIZE, { cols: 80, rows: 24 }),
    encodeFrame(EcKind.STDERR, bytes(7)),
  ];
  const wire = concat(sample);

  function expectSample(frames: { kind: number; payload: Uint8Array }[]) {
    expect(frames.map((frame) => frame.kind)).toEqual([
      EcKind.STDOUT,
      EcKind.PING,
      EcKind.RESIZE,
      EcKind.STDERR,
    ]);
    expect(Array.from(frames[0]!.payload)).toEqual([10, 20, 30, 40]);
    expect(frames[1]!.payload.byteLength).toBe(0);
    expect(decodeJson(frames[2]!.payload)).toEqual({ cols: 80, rows: 24 });
    expect(Array.from(frames[3]!.payload)).toEqual([7]);
  }

  it('decodes coalesced frames from one chunk', () => {
    expectSample(new FrameDecoder().push(wire));
  });

  it('decodes when split at every byte boundary', () => {
    for (let cut = 0; cut <= wire.byteLength; cut += 1) {
      const decoder = new FrameDecoder();
      const frames = [...decoder.push(wire.subarray(0, cut)), ...decoder.push(wire.subarray(cut))];
      expectSample(frames);
    }
  });

  it('decodes byte-by-byte', () => {
    const decoder = new FrameDecoder();
    const frames = Array.from(wire).flatMap((value) => decoder.push(bytes(value)));
    expectSample(frames);
  });

  it('ignores empty chunks and returns nothing for partial headers', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
    expect(decoder.push(wire.subarray(0, 3))).toEqual([]);
  });

  it('copies payloads so callers may reuse their buffers', () => {
    const decoder = new FrameDecoder();
    const chunk = encodeFrame(EcKind.STDOUT, bytes(1, 2, 3));
    const [frame] = decoder.push(chunk);
    chunk.fill(0);
    expect(Array.from(frame!.payload)).toEqual([1, 2, 3]);
  });

  it('round-trips a maximum-size payload split into many chunks', () => {
    const payload = new Uint8Array(EC_MAX_FRAME_PAYLOAD).map((_, i) => i % 251);
    const frame = encodeFrame(EcKind.STDOUT, payload);
    const decoder = new FrameDecoder();
    const out = [];
    for (let pos = 0; pos < frame.byteLength; pos += 65536) {
      out.push(...decoder.push(frame.subarray(pos, pos + 65536)));
    }
    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toEqual(payload);
  });

  it('rejects oversize payload as soon as the header is complete', () => {
    const header = new Uint8Array(EC_HEADER_BYTES);
    header[0] = EcKind.STDOUT;
    new DataView(header.buffer).setUint32(1, EC_MAX_FRAME_PAYLOAD + 1, false);
    expect(() => new FrameDecoder().push(header)).toThrow(EcProtocolError);
  });

  it('rejects unknown kinds', () => {
    expect(() => new FrameDecoder().push(bytes(0x99, 0, 0, 0, 0))).toThrow(EcProtocolError);
    expect(() => new FrameDecoder().push(bytes(0x00, 0, 0, 0, 0))).toThrow(EcProtocolError);
  });

  it('stays failed after a protocol error', () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(bytes(0x99, 0, 0, 0, 0))).toThrow(EcProtocolError);
    expect(() => decoder.push(wire)).toThrow(EcProtocolError);
  });

  it('accepts a well-formed frame before reporting later garbage', () => {
    const decoder = new FrameDecoder();
    const good = decoder.push(encodeFrame(EcKind.PONG, new Uint8Array(0)));
    expect(good).toHaveLength(1);
    expect(() => decoder.push(bytes(0x99, 0, 0, 0, 0))).toThrow(EcProtocolError);
  });
});
