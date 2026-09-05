export const FRAGMENT_HEADER_SIZE = 8;
export const DC_MAX_MESSAGE_BYTES = 64 * 1024;
export const FRAGMENT_PAYLOAD_SIZE = DC_MAX_MESSAGE_BYTES - FRAGMENT_HEADER_SIZE;
export const FRAGMENT_SEND_MESSAGE_BYTES = 16 * 1024;
export const FRAGMENT_SEND_PAYLOAD_SIZE = FRAGMENT_SEND_MESSAGE_BYTES - FRAGMENT_HEADER_SIZE;
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
    chunk.set(payload.subarray(start, end), FRAGMENT_HEADER_SIZE);
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
  private earliestDeadline = Number.POSITIVE_INFINITY;
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
    this.earliestDeadline = Number.POSITIVE_INFINITY;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.clear();
  }

  sweep(): void {
    if (this.disposed) return;
    this.expire(this.o.now());
    this.armTimer();
  }

  // 单片返回 payload 视图（与 decodeEnvelopeView 相同：调用方不得改写，也不得跨回调长期持有）。
  // 多片在末片一次性分配输出，每片只拷一次。
  push(chunk: Uint8Array, fail: (kind: FragmentFail, message: string) => null): Uint8Array | null {
    const o = this.o;
    try {
      if (this.disposed) return null;
      const head = this.readHeader(chunk, fail);
      if (!head) return null;
      const { frameId, idx, total } = head;
      const now = o.now();
      this.expire(now);
      const piece = chunk.subarray(FRAGMENT_HEADER_SIZE);
      if (total === 1) {
        if (piece.byteLength > o.maxFrameBytes) {
          return fail('frame-too-large', `reassembled frame exceeds ${o.maxFrameBytes} bytes`);
        }
        if (this.pending.size > 0) this.drop(frameId);
        return piece;
      }
      const frame = this.openFrame(frameId, total, now);
      if (frame.chunks[idx]) return null;
      if (o.refreshDeadline) {
        frame.deadline = o.now() + o.timeoutMs;
        this.earliestDeadline = Math.min(this.earliestDeadline, frame.deadline);
      }
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

  private readHeader(chunk: Uint8Array, fail: (kind: FragmentFail, message: string) => null) {
    const o = this.o;
    if (chunk.byteLength < FRAGMENT_HEADER_SIZE) return fail('short', 'chunk-too-short');
    if (chunk.byteLength > o.maxMessageBytes) return fail('chunk-too-large', 'chunk-too-large');
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const idx = dv.getUint16(4, true);
    const total = dv.getUint16(6, true);
    const payloadLen = chunk.byteLength - FRAGMENT_HEADER_SIZE;
    if (total === 0) return fail('total-zero', 'bad-total');
    if (total > o.maxTotal) {
      return fail('total-exceeds', `fragment total ${total} exceeds ${o.maxTotal}`);
    }
    if (idx >= total) return fail('bad-index', 'bad-index');
    if (payloadLen > o.payloadMax) {
      return fail('payload-exceeds', `fragment payload ${payloadLen} exceeds ${o.payloadMax}`);
    }
    return { frameId: dv.getUint32(0, true), idx, total };
  }

  /** 取回同一 frameId 的在途帧；total 变了或不存在则按 LRU 腾位后重建。 */
  private openFrame(frameId: number, total: number, now: number): Pending {
    const existing = this.pending.get(frameId);
    if (existing?.total === total) return existing;
    if (existing) this.drop(frameId);
    while (this.order.length && this.pending.size >= this.o.maxInFlight) this.drop(this.order[0]);
    const chunks: Array<Uint8Array | undefined> = new Array(total);
    const frame = { total, received: 0, bytes: 0, chunks, deadline: now + this.o.timeoutMs };
    this.pending.set(frameId, frame);
    this.order.push(frameId);
    this.earliestDeadline = Math.min(this.earliestDeadline, frame.deadline);
    return frame;
  }

  private expire(now: number): void {
    if (this.pending.size === 0 || now < this.earliestDeadline) return;
    let next = Number.POSITIVE_INFINITY;
    for (const [id, frame] of this.pending) {
      if (frame.deadline <= now) this.drop(id);
      else if (frame.deadline < next) next = frame.deadline;
    }
    this.earliestDeadline = this.pending.size === 0 ? Number.POSITIVE_INFINITY : next;
  }

  private drop(frameId: number): void {
    const frame = this.pending.get(frameId);
    if (!frame) return;
    this.pendingBytes -= frame.bytes;
    this.pending.delete(frameId);
    const at = this.order.indexOf(frameId);
    if (at >= 0) this.order.splice(at, 1);
    if (this.pending.size === 0) this.earliestDeadline = Number.POSITIVE_INFINITY;
  }

  private armTimer(): void {
    const { setTimeoutFn, clearTimeoutFn } = this.o;
    if (!setTimeoutFn || !clearTimeoutFn) return;
    this.clearTimer();
    if (this.disposed || this.pending.size === 0) return;
    const delay = Math.max(0, this.earliestDeadline - this.o.now());
    this.timer = setTimeoutFn(() => {
      this.timer = null;
      this.sweep();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer == null) return;
    this.o.clearTimeoutFn?.(this.timer);
    this.timer = null;
  }
}
