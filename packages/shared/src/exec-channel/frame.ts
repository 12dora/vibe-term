import { EC_HEADER_BYTES, EC_MAX_FRAME_PAYLOAD, EcKind } from './constants';
import type { EcFrame } from './types';

export class EcProtocolError extends Error {
  readonly code = 'protocol_error';

  constructor(message: string) {
    super(message);
    this.name = 'EcProtocolError';
  }
}

const KNOWN_KINDS: ReadonlySet<number> = new Set(Object.values(EcKind));
const LOGGED_KINDS: ReadonlySet<number> = new Set([EcKind.STDOUT, EcKind.STDERR, EcKind.EXIT]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function isKnownKind(kind: number): boolean {
  return KNOWN_KINDS.has(kind);
}

export function isLoggedKind(kind: number): boolean {
  return LOGGED_KINDS.has(kind);
}

export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > EC_MAX_FRAME_PAYLOAD) {
    throw new EcProtocolError(`frame payload too large: ${payload.byteLength}`);
  }
  const out = new Uint8Array(EC_HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.byteLength, false);
  out.set(payload, EC_HEADER_BYTES);
  return out;
}

export function encodeJsonFrame(kind: number, obj: unknown): Uint8Array {
  return encodeFrame(kind, textEncoder.encode(JSON.stringify(obj)));
}

export function decodeJson<T = unknown>(payload: Uint8Array): T {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(payload));
  } catch {
    throw new EcProtocolError('invalid JSON payload');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EcProtocolError('JSON payload must be an object');
  }
  return value as T;
}

export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private header: { kind: number; length: number } | null = null;
  private failure: EcProtocolError | null = null;

  push(chunk: Uint8Array): EcFrame[] {
    if (this.failure) throw this.failure;
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.byteLength;
    }
    const frames: EcFrame[] = [];
    try {
      for (let frame = this.next(); frame; frame = this.next()) frames.push(frame);
    } catch (error) {
      this.failure = error as EcProtocolError;
      this.chunks = [];
      this.buffered = 0;
      throw error;
    }
    return frames;
  }

  private next(): EcFrame | null {
    if (!this.header) {
      if (this.buffered < EC_HEADER_BYTES) return null;
      this.header = parseHeader(this.take(EC_HEADER_BYTES));
    }
    if (this.buffered < this.header.length) return null;
    const { kind, length } = this.header;
    this.header = null;
    return { kind, payload: this.take(length) };
  }

  private take(size: number): Uint8Array {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = this.chunks[0] as Uint8Array;
      const need = size - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.buffered -= size;
    return out;
  }
}

function parseHeader(bytes: Uint8Array): { kind: number; length: number } {
  const kind = bytes[0] as number;
  if (!isKnownKind(kind)) {
    throw new EcProtocolError(`unknown frame kind 0x${kind.toString(16).padStart(2, '0')}`);
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  if (length > EC_MAX_FRAME_PAYLOAD) {
    throw new EcProtocolError(`frame payload too large: ${length}`);
  }
  return { kind, length };
}
