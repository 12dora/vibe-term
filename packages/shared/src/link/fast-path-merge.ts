/**
 * 有序可靠通道 + 无序不可靠「快副本」通道的接收端合并。
 *
 * 可靠通道上第 k 条消息的隐式序号就是 k（两端从同一同步点各自计数），快副本携带显式序号。
 * 合并器只按序号严格递增交付：先到者交付，后到者丢弃；可靠通道单独也能交付全部消息。
 * 快副本提前交付的条目保留指纹，可靠副本到达时比对，计数错位会报 desync 而不是静默错乱。
 */

export const FAST_COPY_INDEX_BYTES = 4;
/** 单条可靠消息不超过这个字节数才发快副本，保证副本连同序号落在一个 UDP 包里。 */
export const FAST_COPY_MAX_BYTES = 1100;
export const FAST_MERGE_MAX_BUFFERED = 256;
export const FAST_MERGE_MAX_BUFFERED_BYTES = 256 * 1024;
export const FAST_MERGE_MAX_AHEAD = 1024;

export type FastPathMergeStats = {
  deliveredEarly: number;
  droppedDup: number;
  fastLate: number;
  bufferOverflows: number;
  buffered: number;
  ahead: number;
  desync: number;
};

export type FastPathMergeOptions = {
  onDeliver: (bytes: Uint8Array) => void;
  onDesync?: (index: number) => void;
  startIndex?: number;
  maxBuffered?: number;
  maxBufferedBytes?: number;
  maxAhead?: number;
};

function seqDiff(a: number, b: number): number {
  return (a - b) | 0;
}

function fingerprint(bytes: Uint8Array): number {
  let h = 0x811c9dc5 ^ bytes.byteLength;
  for (let i = 0; i < bytes.byteLength; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function encodeFastCopy(index: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(FAST_COPY_INDEX_BYTES + bytes.byteLength);
  const v = index >>> 0;
  out[0] = v & 0xff;
  out[1] = (v >>> 8) & 0xff;
  out[2] = (v >>> 16) & 0xff;
  out[3] = (v >>> 24) & 0xff;
  out.set(bytes, FAST_COPY_INDEX_BYTES);
  return out;
}

/** 只读序号，不拷贝负载；格式不对返回 null。 */
export function readFastCopyIndex(msg: Uint8Array): number | null {
  if (msg.byteLength <= FAST_COPY_INDEX_BYTES) return null;
  return (
    ((msg[0] ?? 0) | ((msg[1] ?? 0) << 8) | ((msg[2] ?? 0) << 16) | ((msg[3] ?? 0) << 24)) >>> 0
  );
}

export function decodeFastCopy(msg: Uint8Array): { index: number; bytes: Uint8Array } | null {
  const index = readFastCopyIndex(msg);
  if (index === null) return null;
  return { index, bytes: msg.slice(FAST_COPY_INDEX_BYTES) };
}

export class FastPathMerge {
  private readonly onDeliver: (bytes: Uint8Array) => void;
  private readonly onDesync: ((index: number) => void) | undefined;
  private readonly maxBuffered: number;
  private readonly maxBufferedBytes: number;
  private readonly maxAhead: number;
  private nextIndex: number;
  private reliableIndex: number;
  private readonly pending = new Map<number, Uint8Array>();
  private pendingBytes = 0;
  private readonly early = new Map<number, number>();
  private disposed = false;
  private readonly counters: FastPathMergeStats = {
    deliveredEarly: 0,
    droppedDup: 0,
    fastLate: 0,
    bufferOverflows: 0,
    buffered: 0,
    ahead: 0,
    desync: 0,
  };

  constructor(opts: FastPathMergeOptions) {
    this.onDeliver = opts.onDeliver;
    this.onDesync = opts.onDesync;
    this.maxBuffered = opts.maxBuffered ?? FAST_MERGE_MAX_BUFFERED;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? FAST_MERGE_MAX_BUFFERED_BYTES;
    this.maxAhead = opts.maxAhead ?? FAST_MERGE_MAX_AHEAD;
    this.nextIndex = (opts.startIndex ?? 0) >>> 0;
    this.reliableIndex = this.nextIndex;
  }

  /** 下一条待交付的序号。 */
  get next(): number {
    return this.nextIndex;
  }

  pushReliable(bytes: Uint8Array): void {
    if (this.disposed) return;
    const k = this.reliableIndex;
    this.reliableIndex = (k + 1) >>> 0;
    if (seqDiff(k, this.nextIndex) < 0) {
      const expected = this.early.get(k);
      this.early.delete(k);
      if (expected === undefined || expected !== fingerprint(bytes)) {
        this.failDesync(k);
        return;
      }
      this.counters.droppedDup += 1;
      this.drain();
      return;
    }
    // reliableIndex 永远不会超过 nextIndex：可靠消息只可能是「已提前交付」或「正好轮到」。
    this.advance(bytes);
    this.drain();
  }

  /** 序号早于下一条待交付（晚到的重复副本）时计 fastLate 并返回 true，调用方可直接丢弃。 */
  dropIfLate(index: number): boolean {
    if (this.disposed || seqDiff(index >>> 0, this.nextIndex) >= 0) return false;
    this.counters.fastLate += 1;
    return true;
  }

  pushFast(index: number, bytes: Uint8Array): void {
    if (this.disposed) return;
    const j = index >>> 0;
    const diff = seqDiff(j, this.nextIndex);
    if (diff < 0) {
      this.counters.fastLate += 1;
      return;
    }
    if (diff === 0) {
      if (this.early.size >= this.maxAhead) {
        this.counters.bufferOverflows += 1;
        return;
      }
      this.deliverEarly(j, bytes);
      this.drain();
      return;
    }
    if (this.pending.has(j)) {
      this.counters.fastLate += 1;
      return;
    }
    if (
      diff > this.maxAhead ||
      this.pending.size + 1 > this.maxBuffered ||
      this.pendingBytes + bytes.byteLength > this.maxBufferedBytes
    ) {
      this.clearPending();
      this.counters.bufferOverflows += 1;
      return;
    }
    this.pending.set(j, bytes);
    this.pendingBytes += bytes.byteLength;
  }

  /** 解析 `[u32 LE 序号][原消息]` 并合并；格式不对的直接丢弃。 */
  pushFastMessage(msg: Uint8Array): void {
    const decoded = decodeFastCopy(msg);
    if (!decoded) return;
    this.pushFast(decoded.index, decoded.bytes);
  }

  stats(): FastPathMergeStats {
    return { ...this.counters, buffered: this.pending.size, ahead: this.early.size };
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.early.clear();
  }

  private advance(bytes: Uint8Array): void {
    const stale = this.pending.get(this.nextIndex);
    if (stale) {
      this.pending.delete(this.nextIndex);
      this.pendingBytes -= stale.byteLength;
    }
    this.nextIndex = (this.nextIndex + 1) >>> 0;
    this.onDeliver(bytes);
  }

  private deliverEarly(j: number, bytes: Uint8Array): void {
    this.early.set(j, fingerprint(bytes));
    this.counters.deliveredEarly += 1;
    this.advance(bytes);
  }

  private drain(): void {
    while (!this.disposed && this.early.size < this.maxAhead) {
      const j = this.nextIndex;
      const bytes = this.pending.get(j);
      if (!bytes) return;
      this.pending.delete(j);
      this.pendingBytes -= bytes.byteLength;
      this.deliverEarly(j, bytes);
    }
  }

  private clearPending(): void {
    this.pending.clear();
    this.pendingBytes = 0;
  }

  private failDesync(index: number): void {
    this.counters.desync += 1;
    this.dispose();
    this.onDesync?.(index);
  }
}

/** 发送端计数：可靠通道每写出一条消息调用一次 `noteReliable`，按需拿到快副本。 */
export class FastPathSender {
  private nextIndex: number;
  private readonly maxCopyBytes: number;
  copiesSent = 0;

  constructor(opts?: { startIndex?: number; maxCopyBytes?: number }) {
    this.nextIndex = (opts?.startIndex ?? 0) >>> 0;
    this.maxCopyBytes = opts?.maxCopyBytes ?? FAST_COPY_MAX_BYTES;
  }

  get next(): number {
    return this.nextIndex;
  }

  /**
   * 可靠通道已接受 `bytes` 后调用。`wantCopy` 为 false 或消息过大时只推进序号返回 null，
   * 否则返回编码好的快副本。
   */
  noteReliable(bytes: Uint8Array, wantCopy: boolean): Uint8Array | null {
    const index = this.nextIndex;
    this.nextIndex = (index + 1) >>> 0;
    if (!wantCopy || bytes.byteLength > this.maxCopyBytes) return null;
    return encodeFastCopy(index, bytes);
  }

  noteCopySent(): void {
    this.copiesSent += 1;
  }
}
