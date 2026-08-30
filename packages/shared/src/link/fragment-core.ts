export const FRAGMENT_HEADER_SIZE = 8;
export const DC_MAX_MESSAGE_BYTES = 64 * 1024;
export const FRAGMENT_PAYLOAD_SIZE = DC_MAX_MESSAGE_BYTES - FRAGMENT_HEADER_SIZE;
export const DEFAULT_FRAME_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_IN_FLIGHT = 32;

export type FragmentFail =
  | 'short'
  | 'chunk-too-large'
  | 'total-zero'
  | 'total-exceeds'
  | 'bad-index'
  | 'payload-exceeds'
  | 'frame-too-large'
  | 'pending-exceeded';

type Pending = {
  total: number;
  received: number;
  bytes: number;
  chunks: Array<Uint8Array | undefined>;
  deadline: number;
};

type Opts = {
  timeoutMs: number;
  maxInFlight: number;
  now: () => number;
  maxFrameBytes: number;
  maxTotal: number;
  payloadMax: number;
  maxMessageBytes: number;
  maxPendingBytes: number;
  refreshDeadline: boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

export function fragmentBytes(
  frameId: number,
  payload: Uint8Array,
  payloadSize: number
): Uint8Array[] {
  const size = Math.max(1, payloadSize);
  const total = Math.max(1, Math.ceil(payload.byteLength / size));
  const parts: Uint8Array[] = [];
  for (let idx = 0; idx < total; idx++) {
    const start = idx * size;
    const end = Math.min(payload.byteLength, start + size);
    const chunk = new Uint8Array(FRAGMENT_HEADER_SIZE + (end - start));
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    dv.setUint32(0, frameId >>> 0, true);
    dv.setUint16(4, idx, true);
    dv.setUint16(6, total, true);
    if (end > start) chunk.set(payload.subarray(start, end), FRAGMENT_HEADER_SIZE);
    parts.push(chunk);
  }
  return parts;
}

export class FragmentAssembler {
  pendingBytes = 0;
  disposed = false;
  private timer: unknown = null;
  private readonly pending = new Map<number, Pending>();
  private readonly order: number[] = [];
  private readonly o: Opts;

  constructor(o: Partial<Opts> & Pick<Opts, 'maxFrameBytes' | 'maxTotal' | 'refreshDeadline'>) {
    this.o = {
      timeoutMs: o.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
      maxInFlight: o.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      now: o.now ?? Date.now,
      maxFrameBytes: o.maxFrameBytes,
      maxTotal: o.maxTotal,
      payloadMax: o.payloadMax ?? Number.POSITIVE_INFINITY,
      maxMessageBytes: o.maxMessageBytes ?? Number.POSITIVE_INFINITY,
      maxPendingBytes: o.maxPendingBytes ?? Number.POSITIVE_INFINITY,
      refreshDeadline: o.refreshDeadline,
      setTimeoutFn: o.setTimeoutFn,
      clearTimeoutFn: o.clearTimeoutFn,
    };
  }

  clear(): void {
    this.pending.clear();
    this.order.length = 0;
    this.pendingBytes = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.clear();
  }

  sweep(): void {
    if (this.disposed) return;
    const now = this.o.now();
    for (const [id, frame] of this.pending) {
      if (frame.deadline <= now) this.drop(id);
    }
    this.armTimer();
  }

  push(chunk: Uint8Array, fail: (kind: FragmentFail, message: string) => null): Uint8Array | null {
    const o = this.o;
    try {
      if (this.disposed) return null;
      if (chunk.byteLength < FRAGMENT_HEADER_SIZE) return fail('short', 'chunk-too-short');
      if (chunk.byteLength > o.maxMessageBytes) return fail('chunk-too-large', 'chunk-too-large');
      const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const frameId = dv.getUint32(0, true);
      const idx = dv.getUint16(4, true);
      const total = dv.getUint16(6, true);
      if (total === 0) return fail('total-zero', 'bad-total');
      if (total > o.maxTotal) {
        return fail('total-exceeds', `fragment total ${total} exceeds ${o.maxTotal}`);
      }
      if (idx >= total) return fail('bad-index', 'bad-index');
      const payloadLen = chunk.byteLength - FRAGMENT_HEADER_SIZE;
      if (payloadLen > o.payloadMax) {
        return fail('payload-exceeds', `fragment payload ${payloadLen} exceeds ${o.payloadMax}`);
      }
      const now = o.now();
      for (const [id, f] of this.pending) {
        if (f.deadline <= now) this.drop(id);
      }
      let frame = this.pending.get(frameId);
      if (frame && frame.total !== total) {
        this.drop(frameId);
        frame = undefined;
      }
      if (!frame) {
        while (this.order.length > 0 && this.pending.size >= o.maxInFlight) {
          const id = this.order.shift();
          if (id !== undefined && this.pending.has(id)) this.drop(id);
        }
        frame = {
          total,
          received: 0,
          bytes: 0,
          chunks: new Array(total),
          deadline: now + o.timeoutMs,
        };
        this.pending.set(frameId, frame);
        this.order.push(frameId);
      }
      if (frame.chunks[idx]) return null;
      if (o.refreshDeadline) frame.deadline = o.now() + o.timeoutMs;
      const piece = chunk.subarray(FRAGMENT_HEADER_SIZE).slice();
      if (frame.bytes + piece.byteLength > o.maxFrameBytes) {
        this.drop(frameId);
        return fail('frame-too-large', `reassembled frame exceeds ${o.maxFrameBytes} bytes`);
      }
      if (this.pendingBytes + piece.byteLength > o.maxPendingBytes) {
        this.drop(frameId);
        return fail('pending-exceeded', 'pending-bytes-exceeded');
      }
      frame.chunks[idx] = piece;
      frame.bytes += piece.byteLength;
      frame.received += 1;
      this.pendingBytes += piece.byteLength;
      if (frame.received < frame.total) return null;
      const out = new Uint8Array(frame.bytes);
      let offset = 0;
      for (const part of frame.chunks) {
        if (!part) return null;
        out.set(part, offset);
        offset += part.byteLength;
      }
      this.drop(frameId);
      return out;
    } finally {
      this.armTimer();
    }
  }

  private drop(frameId: number): void {
    const frame = this.pending.get(frameId);
    if (frame) this.pendingBytes -= frame.bytes;
    this.pending.delete(frameId);
    const at = this.order.indexOf(frameId);
    if (at >= 0) this.order.splice(at, 1);
  }

  private armTimer(): void {
    const { setTimeoutFn, clearTimeoutFn } = this.o;
    if (!setTimeoutFn || !clearTimeoutFn) return;
    this.clearTimer();
    if (this.disposed || this.pending.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const frame of this.pending.values()) {
      if (frame.deadline < earliest) earliest = frame.deadline;
    }
    if (earliest === Number.POSITIVE_INFINITY) return;
    this.timer = setTimeoutFn(
      () => {
        this.timer = null;
        this.sweep();
      },
      Math.max(0, earliest - this.o.now())
    );
  }

  private clearTimer(): void {
    if (this.timer == null) return;
    this.o.clearTimeoutFn?.(this.timer);
    this.timer = null;
  }
}
