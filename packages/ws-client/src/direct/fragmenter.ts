// DataChannel 分片 / 重组（设计 §3「DataChannel 消息尺寸与背压」）。
//
// 线格式与 node 侧 `apps/gateway/src/mesh/rtc/fragmenter.ts` **逐字节一致**：
// `[frameId u32 LE][idx u16 LE][total u16 LE][payload]`，分片载荷 64 KiB。
// 两侧各自实现是刻意的：ws-client 只依赖 `@tmex/shared`，不引 gateway 代码。

export const FRAGMENT_HEADER_SIZE = 8;
export const FRAGMENT_PAYLOAD_SIZE = 64 * 1024;
export const DEFAULT_FRAME_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_IN_FLIGHT = 32;

export interface ReassemblerOptions {
  timeoutMs?: number;
  maxInFlight?: number;
  now?: () => number;
}

function readU16LE(buf: Uint8Array, offset: number): number {
  const lo = buf[offset];
  const hi = buf[offset + 1];
  if (lo === undefined || hi === undefined) return 0;
  return lo | (hi << 8);
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return 0;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

/** 把一个 Borsh 帧切成若干带头的分片；空载荷也产出 1 个分片（total=1）。 */
export function fragmentFrame(
  frameId: number,
  payload: Uint8Array,
  payloadSize = FRAGMENT_PAYLOAD_SIZE
): Uint8Array[] {
  const size = Math.max(1, payloadSize);
  const total = Math.max(1, Math.ceil(payload.byteLength / size));
  const parts: Uint8Array[] = [];
  for (let idx = 0; idx < total; idx++) {
    const start = idx * size;
    const end = Math.min(payload.byteLength, start + size);
    const chunk = new Uint8Array(FRAGMENT_HEADER_SIZE + (end - start));
    writeU32LE(chunk, 0, frameId >>> 0);
    writeU16LE(chunk, 4, idx);
    writeU16LE(chunk, 6, total);
    if (end > start) {
      chunk.set(payload.subarray(start, end), FRAGMENT_HEADER_SIZE);
    }
    parts.push(chunk);
  }
  return parts;
}

interface PendingFrame {
  total: number;
  received: number;
  chunks: Array<Uint8Array | undefined>;
  deadline: number;
}

/**
 * 分片重组器：按 `frameId` 聚合，集齐即返回完整帧。
 *
 * 超时（默认 15 s）与在途上限（默认 32 帧）都是为了让**永远集不齐**的帧不至于常驻内存——
 * DataChannel 是 ordered+reliable，正常情况下不会缺片，缺片只出现在对端中途关闭时。
 */
export class FrameReassembler {
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly pending = new Map<number, PendingFrame>();
  private readonly order: number[] = [];

  constructor(options: ReassemblerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.now = options.now ?? Date.now;
  }

  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.byteLength < FRAGMENT_HEADER_SIZE) return null;
    const frameId = readU32LE(chunk, 0);
    const idx = readU16LE(chunk, 4);
    const total = readU16LE(chunk, 6);
    if (total === 0 || idx >= total) return null;
    this.sweep();

    let frame = this.pending.get(frameId);
    if (frame && frame.total !== total) {
      this.drop(frameId);
      frame = undefined;
    }
    if (!frame) {
      if (this.pending.size >= this.maxInFlight) this.evictOldest();
      frame = {
        total,
        received: 0,
        chunks: new Array(total),
        deadline: this.now() + this.timeoutMs,
      };
      this.pending.set(frameId, frame);
      this.order.push(frameId);
    }

    if (frame.chunks[idx]) return null;
    frame.chunks[idx] = chunk.subarray(FRAGMENT_HEADER_SIZE).slice();
    frame.received += 1;
    if (frame.received < frame.total) return null;

    let length = 0;
    for (const part of frame.chunks) length += part?.byteLength ?? 0;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of frame.chunks) {
      if (!part) return null;
      out.set(part, offset);
      offset += part.byteLength;
    }
    this.drop(frameId);
    return out;
  }

  /** 丢弃已超时的半截帧。`push` 每次都会调，也可由宿主主动调。 */
  sweep(): void {
    const now = this.now();
    for (const [id, frame] of this.pending) {
      if (frame.deadline <= now) this.drop(id);
    }
  }

  clear(): void {
    this.pending.clear();
    this.order.length = 0;
  }

  private evictOldest(): void {
    while (this.order.length > 0 && this.pending.size >= this.maxInFlight) {
      const id = this.order.shift();
      if (id === undefined) return;
      if (this.pending.has(id)) this.drop(id);
    }
  }

  private drop(frameId: number): void {
    this.pending.delete(frameId);
    const at = this.order.indexOf(frameId);
    if (at >= 0) this.order.splice(at, 1);
  }
}
