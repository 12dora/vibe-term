// DataChannel 分片 / 重组（设计 §3「DataChannel 消息尺寸与背压」）。
//
// 线格式与 node 侧 `apps/gateway/src/mesh/rtc/fragmenter.ts` **逐字节一致**：
// `[frameId u32 LE][idx u16 LE][total u16 LE][payload]`。
//
// 尺寸约定（两侧一致，越界即协议违规）：
// - 单条 DataChannel 消息 ≤ 64 KiB，**含 8 字节头** → 分片载荷 ≤ 65528；
//   实际载荷取 `min(65528, sctp.maxMessageSize - 8)`；
// - 重组后的逻辑帧 ≤ 1 MiB（与 WS 侧 `maxFrameBytes` 同值）；
// - 因此 `total ≤ ceil(1 MiB / 65528) = 17`。
//
// 上限由**收发双方各自强制**：只靠超时/在途帧数收不住内存——`total=65535` 配大分片能在
// 一个 frameId 下堆几百 MiB。越界一律上报 `onViolation`，由载体关闭直连（而不是静默等超时）。
// 两侧各自实现是刻意的：ws-client 只依赖 `@tmex/shared`，不引 gateway 代码。

export const FRAGMENT_HEADER_SIZE = 8;
/** 单条 DataChannel 消息上限（含头）。 */
export const MAX_DC_MESSAGE_BYTES = 64 * 1024;
/** 分片载荷上限：64 KiB 减去 8 字节头。 */
export const FRAGMENT_PAYLOAD_SIZE = MAX_DC_MESSAGE_BYTES - FRAGMENT_HEADER_SIZE;
/** 重组后的逻辑帧上限。 */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** 一个逻辑帧允许的最大分片数：ceil(1 MiB / 65528) = 17。 */
export const MAX_FRAGMENTS_PER_FRAME = Math.ceil(MAX_FRAME_BYTES / FRAGMENT_PAYLOAD_SIZE);
export const DEFAULT_FRAME_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_IN_FLIGHT = 32;
/** 所有半截帧的累计上限：ordered+reliable 下正常只会有一个半截帧。 */
export const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

/** 分片层的协议违规原因（诊断与日志用，不进线格式）。 */
export type FragmentViolation =
  | 'chunk-too-short'
  | 'chunk-too-large'
  | 'bad-total'
  | 'bad-index'
  | 'frame-too-large'
  | 'pending-bytes-exceeded';

export interface ReassemblerOptions {
  timeoutMs?: number;
  maxInFlight?: number;
  maxFrameBytes?: number;
  maxPendingBytes?: number;
  /** 单条 DataChannel 消息上限（含头）；缺省 64 KiB。 */
  maxMessageBytes?: number;
  now?: () => number;
  /** 协议违规回调：宿主载体据此关闭直连。 */
  onViolation?: (reason: FragmentViolation) => void;
}

/** 出站分片越界（本地 bug 或上层给了超大帧）；调用方应关闭载体。 */
export class FragmentBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentBoundsError';
  }
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

/**
 * 按对端声明的 `maxMessageSize` 算出可用的分片载荷：`min(65528, maxMessageSize - 8)`。
 * 拿不到或不合法时用默认 65528。
 */
export function effectiveFragmentPayloadSize(maxMessageBytes?: number | null): number {
  if (typeof maxMessageBytes !== 'number' || !Number.isFinite(maxMessageBytes)) {
    return FRAGMENT_PAYLOAD_SIZE;
  }
  const usable = Math.floor(maxMessageBytes) - FRAGMENT_HEADER_SIZE;
  if (usable <= 0) return FRAGMENT_PAYLOAD_SIZE;
  return Math.min(FRAGMENT_PAYLOAD_SIZE, usable);
}

/**
 * 把一个 Borsh 帧切成若干带头的分片；空载荷也产出 1 个分片（total=1）。
 * 越界（帧 > 1 MiB、载荷 > 65528、分片数 > 17）抛 `FragmentBoundsError`。
 */
export function fragmentFrame(
  frameId: number,
  payload: Uint8Array,
  payloadSize = FRAGMENT_PAYLOAD_SIZE
): Uint8Array[] {
  if (payloadSize < 1 || payloadSize > FRAGMENT_PAYLOAD_SIZE) {
    throw new FragmentBoundsError(`fragment payload size out of range: ${payloadSize}`);
  }
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FragmentBoundsError(`frame too large: ${payload.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const total = Math.max(1, Math.ceil(payload.byteLength / payloadSize));
  if (total > MAX_FRAGMENTS_PER_FRAME) {
    throw new FragmentBoundsError(`too many fragments: ${total} > ${MAX_FRAGMENTS_PER_FRAME}`);
  }
  const parts: Uint8Array[] = [];
  for (let idx = 0; idx < total; idx++) {
    const start = idx * payloadSize;
    const end = Math.min(payload.byteLength, start + payloadSize);
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
  bytes: number;
  chunks: Array<Uint8Array | undefined>;
  deadline: number;
}

/**
 * 分片重组器：按 `frameId` 聚合，集齐即返回完整帧。
 *
 * 超时（默认 15 s）与在途上限（默认 32 帧）让**永远集不齐**的帧不至于常驻内存——
 * DataChannel 是 ordered+reliable，正常情况下不会缺片，缺片只出现在对端中途关闭时。
 * 尺寸越界不是「等超时」的问题而是协议违规，直接 `onViolation` 让载体关闭。
 */
export class FrameReassembler {
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly maxFrameBytes: number;
  private readonly maxPendingBytes: number;
  private readonly maxMessageBytes: number;
  private readonly now: () => number;
  private readonly onViolation: ((reason: FragmentViolation) => void) | null;
  private readonly pending = new Map<number, PendingFrame>();
  private readonly order: number[] = [];
  private pendingBytes = 0;

  constructor(options: ReassemblerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_DC_MESSAGE_BYTES;
    this.now = options.now ?? Date.now;
    this.onViolation = options.onViolation ?? null;
  }

  /** 当前所有半截帧占用的字节数（诊断 / 测试）。 */
  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.byteLength < FRAGMENT_HEADER_SIZE) return this.violation('chunk-too-short');
    if (chunk.byteLength > this.maxMessageBytes) return this.violation('chunk-too-large');
    const frameId = readU32LE(chunk, 0);
    const idx = readU16LE(chunk, 4);
    const total = readU16LE(chunk, 6);
    if (total === 0 || total > MAX_FRAGMENTS_PER_FRAME) return this.violation('bad-total');
    if (idx >= total) return this.violation('bad-index');
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
        bytes: 0,
        chunks: new Array(total),
        deadline: this.now() + this.timeoutMs,
      };
      this.pending.set(frameId, frame);
      this.order.push(frameId);
    }

    if (frame.chunks[idx]) return null;
    const part = chunk.subarray(FRAGMENT_HEADER_SIZE).slice();
    // 单帧累计：`total` 合法也挡不住每片都塞满 65528 却声明 17 片之外的组合，按字节兜底。
    if (frame.bytes + part.byteLength > this.maxFrameBytes) {
      this.drop(frameId);
      return this.violation('frame-too-large');
    }
    if (this.pendingBytes + part.byteLength > this.maxPendingBytes) {
      this.drop(frameId);
      return this.violation('pending-bytes-exceeded');
    }
    frame.chunks[idx] = part;
    frame.received += 1;
    frame.bytes += part.byteLength;
    this.pendingBytes += part.byteLength;
    if (frame.received < frame.total) return null;

    const out = new Uint8Array(frame.bytes);
    let offset = 0;
    for (const item of frame.chunks) {
      if (!item) return null;
      out.set(item, offset);
      offset += item.byteLength;
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
    this.pendingBytes = 0;
  }

  private violation(reason: FragmentViolation): null {
    this.onViolation?.(reason);
    return null;
  }

  private evictOldest(): void {
    while (this.order.length > 0 && this.pending.size >= this.maxInFlight) {
      const id = this.order.shift();
      if (id === undefined) return;
      if (this.pending.has(id)) this.drop(id);
    }
  }

  private drop(frameId: number): void {
    const frame = this.pending.get(frameId);
    if (frame) this.pendingBytes -= frame.bytes;
    this.pending.delete(frameId);
    const at = this.order.indexOf(frameId);
    if (at >= 0) this.order.splice(at, 1);
  }
}
