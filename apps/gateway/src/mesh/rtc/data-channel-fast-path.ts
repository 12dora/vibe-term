import {
  type ByteTransportStats,
  FAST_COPY_INDEX_BYTES,
  FAST_COPY_MAX_BYTES,
  FastPathMerge,
  FastPathSender,
  readFastCopyIndex,
} from '@vibeterm/shared/link';
import { FRAGMENT_HEADER_SIZE } from './fragmenter';
import type { DataChannelLike } from './native';
import { sendBinary, toUint8Array } from './native';
import { exitRtcLogContext, rtcLog } from './rtc-log';

/** 快副本晚于可靠消息几毫秒再发，避免和原消息挤进同一个 SCTP 包一起丢。 */
export const DC_FAST_COPY_DELAY_MS = 5;
/** peer-rt 自身积压上限：超过就不发副本。 */
export const DC_FAST_MAX_BUFFERED_BYTES = 4 * 1024;
/** `peer` 已积压时原消息本身在排队，副本只会给同一个 association 添堵。 */
export const DC_FAST_MAX_RELIABLE_BUFFERED_BYTES = 16 * 1024;
export const DC_FAST_MAX_QUEUED_COPIES = 64;
export const DC_FAST_DESYNC_COOLDOWN_MS = 30 * 60_000;

const desyncUntil = new Map<string, number>();

/** 发生过 desync 的对端在冷却期内不再通告 peer-rt 能力，避免「建链 → desync → 重拨」循环。 */
export function noteFastPathDesync(peer: string, now = Date.now()): void {
  desyncUntil.set(peer.toLowerCase(), now + DC_FAST_DESYNC_COOLDOWN_MS);
}

export function fastPathCoolingFor(peer: string, now = Date.now()): boolean {
  const key = peer.toLowerCase();
  const until = desyncUntil.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  desyncUntil.delete(key);
  return false;
}

export function resetFastPathDesyncForTest(): void {
  desyncUntil.clear();
}

export type DcFastPathOptions = {
  peer?: string;
  copyDelayMs?: number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  /** `peer` 可靠通道当前的 bufferedAmount。 */
  reliableBuffered: () => number;
  /** 按序交付给 Link 的原有入站处理（liveness / 重组 / mux）。 */
  deliver: (bytes: Uint8Array) => void;
  onDesync: () => void;
  /** 包一层 Link 的 native 回调保护（callbackDepth）。 */
  runCallback: (fn: () => void) => void;
};

export function closeChannelQuietly(dc: DataChannelLike | null): void {
  if (!dc) return;
  try {
    dc.close();
  } catch {
    // already closed
  }
}

function isSingleFragment(bytes: Uint8Array): boolean {
  if (bytes.byteLength < FRAGMENT_HEADER_SIZE) return false;
  return bytes[6] === 1 && bytes[7] === 0;
}

/**
 * DataChannelLink 的 peer-rt 快路径：发送端给小消息补无序不可靠副本，
 * 接收端把可靠消息与副本按隐式序号合并。由 Link 组合持有，Link 关闭时调 close()。
 */
export class DcFastPath {
  private readonly sender = new FastPathSender();
  private readonly merge: FastPathMerge;
  private readonly opts: DcFastPathOptions;
  private readonly copyDelayMs: number;
  private channel: DataChannelLike | null = null;
  private closed = false;
  private activeLogged = false;
  private queue: Uint8Array[] = [];
  private timer: unknown = null;

  constructor(opts: DcFastPathOptions) {
    this.opts = opts;
    this.copyDelayMs = opts.copyDelayMs ?? DC_FAST_COPY_DELAY_MS;
    this.merge = new FastPathMerge({
      onDeliver: (bytes) => opts.deliver(bytes),
      onDesync: (index) => {
        rtcLog('fast path desync', { peer: this.peerLabel(), index });
        if (opts.peer) noteFastPathDesync(opts.peer);
        opts.onDesync();
      },
    });
  }

  pushReliable(bytes: Uint8Array): void {
    this.merge.pushReliable(bytes);
  }

  /** 接上 peer-rt。已关闭或已有快通道时直接关掉传入的通道。 */
  attach(dc: DataChannelLike): void {
    if (this.closed || this.channel) {
      closeChannelQuietly(dc);
      return;
    }
    this.channel = dc;
    dc.onMessage((msg) => {
      if (this.closed || this.channel !== dc || typeof msg === 'string') return;
      const raw = toUint8Array(msg);
      const index = readFastCopyIndex(raw);
      // 晚到的重复副本（健康链路上几乎全是）不进 runCallback，免得白白冻结 `peer` 的发送 8 ms。
      if (index === null || this.merge.dropIfLate(index)) return;
      const bytes = raw.slice(FAST_COPY_INDEX_BYTES);
      this.opts.runCallback(() => this.merge.pushFast(index, bytes));
    });
    dc.onOpen(() => exitRtcLogContext(() => this.noteActive(dc)));
    dc.onClosed(() => exitRtcLogContext(() => this.detach(dc, 'closed')));
    dc.onError((err) => exitRtcLogContext(() => this.detach(dc, err || 'error')));
    if (dc.isOpen()) this.noteActive(dc);
  }

  /** 可靠通道已接受 `bytes` 后调用：推进序号，必要时排一份快副本。 */
  noteReliableSent(bytes: Uint8Array): void {
    const want =
      bytes.byteLength <= FAST_COPY_MAX_BYTES &&
      isSingleFragment(bytes) &&
      this.usable() &&
      this.opts.reliableBuffered() <= DC_FAST_MAX_RELIABLE_BUFFERED_BYTES;
    const copy = this.sender.noteReliable(bytes, want);
    if (!copy || this.queue.length >= DC_FAST_MAX_QUEUED_COPIES) return;
    this.queue.push(copy);
    if (this.copyDelayMs <= 0) {
      this.flushCopies();
      return;
    }
    if (this.timer != null) return;
    this.timer = this.opts.setTimeoutFn(() => {
      this.timer = null;
      this.flushCopies();
    }, this.copyDelayMs);
  }

  stats(): ByteTransportStats {
    const merge = this.merge.stats();
    return {
      fastActive: this.usable() ? 1 : 0,
      copiesSent: this.sender.copiesSent,
      deliveredEarly: merge.deliveredEarly,
      droppedDup: merge.droppedDup,
      fastLate: merge.fastLate,
      bufferOverflows: merge.bufferOverflows,
      desync: merge.desync,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.merge.dispose();
    const dc = this.channel;
    this.reset();
    closeChannelQuietly(dc);
  }

  private peerLabel(): string {
    return this.opts.peer ?? 'unknown';
  }

  private noteActive(dc: DataChannelLike): void {
    if (this.closed || this.channel !== dc || this.activeLogged) return;
    this.activeLogged = true;
    rtcLog('fast path active', { peer: this.peerLabel(), label: dc.getLabel?.() ?? '' });
  }

  private detach(dc: DataChannelLike, reason: string): void {
    if (this.channel !== dc) return;
    this.reset();
    if (!this.closed) rtcLog('fast path closed', { peer: this.peerLabel(), reason });
  }

  private reset(): void {
    this.channel = null;
    this.queue = [];
    if (this.timer == null) return;
    this.opts.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private usable(): boolean {
    const dc = this.channel;
    return !this.closed && dc !== null && dc.isOpen();
  }

  private flushCopies(): void {
    const queued = this.queue;
    this.queue = [];
    const dc = this.channel;
    if (!dc || !this.usable()) return;
    for (const copy of queued) {
      try {
        if (dc.bufferedAmount() > DC_FAST_MAX_BUFFERED_BYTES) return;
        const before = dc.bufferedAmount();
        const ok = sendBinary(dc, copy);
        if (ok || dc.bufferedAmount() > before) this.sender.noteCopySent();
      } catch {
        return;
      }
    }
  }
}
