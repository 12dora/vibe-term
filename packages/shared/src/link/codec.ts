import {
  FRAME_HEADER_SIZE,
  type Frame,
  type FrameHeader,
  LinkError,
  MAX_FRAME_PAYLOAD,
  isFrameOp,
} from './types';

function u8(buf: Uint8Array, offset: number): number {
  const value = buf[offset];
  if (value === undefined) {
    throw new LinkError('protocol', `buffer offset ${offset} out of range`);
  }
  return value;
}

export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (u8(buf, offset) |
      (u8(buf, offset + 1) << 8) |
      (u8(buf, offset + 2) << 16) |
      (u8(buf, offset + 3) << 24)) >>>
    0
  );
}

export function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

export function encodeFrameHeader(
  streamId: number,
  op: number,
  flags: number,
  payloadLength: number
): Uint8Array {
  const header = new Uint8Array(FRAME_HEADER_SIZE);
  writeU32LE(header, 0, streamId >>> 0);
  header[4] = op & 0xff;
  header[5] = flags & 0xff;
  writeU32LE(header, 6, payloadLength >>> 0);
  return header;
}

export function encodeFrame(frame: {
  streamId: number;
  op: number;
  flags?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const payload = frame.payload ?? new Uint8Array(0);
  if (payload.byteLength > MAX_FRAME_PAYLOAD) {
    throw new LinkError(
      'oversize',
      `frame payload ${payload.byteLength} exceeds ${MAX_FRAME_PAYLOAD}`
    );
  }
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
  writeU32LE(out, 0, frame.streamId >>> 0);
  out[4] = frame.op & 0xff;
  out[5] = (frame.flags ?? 0) & 0xff;
  writeU32LE(out, 6, payload.byteLength);
  if (payload.byteLength > 0) {
    out.set(payload, FRAME_HEADER_SIZE);
  }
  return out;
}

export function encodeWindowPayload(delta: number): Uint8Array {
  const payload = new Uint8Array(4);
  writeU32LE(payload, 0, delta >>> 0);
  return payload;
}

export function decodeWindowPayload(payload: Uint8Array): number {
  if (payload.byteLength !== 4) {
    throw new LinkError('protocol', `WINDOW payload must be 4 bytes, got ${payload.byteLength}`);
  }
  return readU32LE(payload, 0);
}

export function peekFrameHeader(buf: Uint8Array, offset = 0): FrameHeader | null {
  if (buf.byteLength - offset < FRAME_HEADER_SIZE) return null;
  return {
    streamId: readU32LE(buf, offset),
    op: u8(buf, offset + 4),
    flags: u8(buf, offset + 5),
    length: readU32LE(buf, offset + 6),
  };
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type FrameDecoderOptions = {
  maxPayload?: number;
};

/**
 * Incremental frame decoder. Transports may split or coalesce arbitrarily;
 * push() returns every complete frame and retains a remainder.
 */
export class FrameDecoder {
  private buffer = new Uint8Array(0);
  private readonly maxPayload: number;

  constructor(opts?: FrameDecoderOptions) {
    this.maxPayload = opts?.maxPayload ?? MAX_FRAME_PAYLOAD;
  }

  push(chunk: Uint8Array): Frame[] {
    if (chunk.byteLength === 0) return [];
    if (this.buffer.byteLength === 0) {
      this.buffer = chunk.slice();
    } else {
      const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      next.set(this.buffer);
      next.set(chunk, this.buffer.byteLength);
      this.buffer = next;
    }

    const frames: Frame[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= FRAME_HEADER_SIZE) {
      const length = readU32LE(this.buffer, offset + 6);
      if (length > this.maxPayload) {
        throw new LinkError('oversize', `frame payload ${length} exceeds ${this.maxPayload}`);
      }
      const total = FRAME_HEADER_SIZE + length;
      if (this.buffer.byteLength - offset < total) break;
      const op = u8(this.buffer, offset + 4);
      if (!isFrameOp(op)) {
        throw new LinkError('protocol', `invalid frame op ${op}`);
      }
      frames.push({
        streamId: readU32LE(this.buffer, offset),
        op,
        flags: u8(this.buffer, offset + 5),
        payload: this.buffer.slice(offset + FRAME_HEADER_SIZE, offset + total),
      });
      offset += total;
    }

    this.buffer = offset === 0 ? this.buffer : this.buffer.slice(offset);
    return frames;
  }

  get pending(): number {
    return this.buffer.byteLength;
  }
}
