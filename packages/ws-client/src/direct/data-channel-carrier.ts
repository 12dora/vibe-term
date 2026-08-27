// 浏览器侧的 `RTCDataChannel` 载体：分片发送、重组接收、高低水位背压。
//
// 与 node 侧 `DataChannelCarrier` 同语义（`send` 返回 `sent | backpressure | closed`），
// 高水位 4 MiB、`bufferedAmountLowThreshold` 1 MiB，见设计 §3。
//
// 背压是**整帧**粒度的：水位过高时把整帧排进队列，`bufferedamountlow` 再按序写出。
// 一个逻辑帧要么全部分片都写进通道，要么就关闭载体——`channel.send()` 写到一半抛错时
// 已写出的分片无法撤回，留着只会让对端的重组器永远等不到剩下的片，后续协议流全乱。
//
// 注意：`sess` 通道的**首帧 nonce 不经过本类**——node 侧在挂载载体之前先读走一条裸消息
// （`RtcPeerManager.acceptBrowser`），因此首帧必须是未分片的原始 JSON，由控制器直接写通道。

import {
  type FragmentViolation,
  FrameReassembler,
  MAX_DC_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  effectiveFragmentPayloadSize,
  fragmentFrame,
} from './fragmenter';

export const DC_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const DC_LOW_WATER_BYTES = 1 * 1024 * 1024;
/** 背压队列上限；超限说明对端根本收不动，关闭直连回落 primary 比无限攒内存好。 */
export const DC_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export type CarrierSendResult = 'sent' | 'backpressure' | 'closed';

/** `RTCDataChannel` 的最小结构子集（便于注入假通道）。 */
export interface RTCDataChannelLike {
  readonly readyState: string;
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onbufferedamountlow: ((event?: unknown) => void) | null;
  send(data: ArrayBufferView | ArrayBuffer | string): void;
  close(): void;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

export interface DirectDataChannelCarrierOptions {
  reassembler?: FrameReassembler;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  maxQueuedBytes?: number;
  /** 对端 SCTP 的 `maxMessageSize`；据此把分片载荷压到 `min(65528, 它 - 8)`。 */
  maxMessageBytes?: number;
  /** 协议违规 / 半帧失败导致载体自毁时的原因回调（诊断用）。 */
  onProtocolError?: (reason: string) => void;
}

export class DirectDataChannelCarrier {
  readonly channel: RTCDataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly highWater: number;
  private readonly maxQueuedBytes: number;
  private readonly payloadSize: number;
  private readonly onProtocolError: ((reason: string) => void) | null;
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private readonly drainCbs: Array<() => void> = [];
  /** 尚未写进通道的**整帧**队列（背压期间）。 */
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private nextFrameId = 1;
  private closed = false;

  constructor(channel: RTCDataChannelLike, options: DirectDataChannelCarrierOptions = {}) {
    this.channel = channel;
    this.highWater = options.highWaterBytes ?? DC_HIGH_WATER_BYTES;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DC_MAX_QUEUED_BYTES;
    this.payloadSize = effectiveFragmentPayloadSize(options.maxMessageBytes);
    this.onProtocolError = options.onProtocolError ?? null;
    this.reassembler =
      options.reassembler ??
      new FrameReassembler({
        maxMessageBytes: Math.max(
          MAX_DC_MESSAGE_BYTES,
          options.maxMessageBytes ?? MAX_DC_MESSAGE_BYTES
        ),
        onViolation: (reason: FragmentViolation) => this.failProtocol(`inbound ${reason}`),
      });
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = options.lowWaterBytes ?? DC_LOW_WATER_BYTES;

    channel.onmessage = (event) => {
      if (this.closed) return;
      const chunk = toBytes(event.data);
      if (!chunk) return;
      const frame = this.reassembler.push(chunk);
      if (!frame) return;
      for (const cb of this.messageCbs) {
        try {
          cb(frame);
        } catch {
          // 单个订阅者异常不得打断收流
        }
      }
    };

    channel.onbufferedamountlow = () => this.flushQueue();

    channel.onclose = () => this.markClosed();
    channel.onerror = () => this.markClosed();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 尚未写出的排队字节数（诊断 / 测试）。 */
  get queuedBytesPending(): number {
    return this.queuedBytes;
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || this.channel.readyState !== 'open') return 'closed';
    if (bytes.byteLength > MAX_FRAME_BYTES) {
      this.failProtocol(`outbound frame too large: ${bytes.byteLength}`);
      return 'closed';
    }
    // 队列非空说明还在背压中：必须继续排队，否则新帧会插到旧帧前面。
    if (this.queue.length > 0 || this.channel.bufferedAmount > this.highWater) {
      if (this.queuedBytes + bytes.byteLength > this.maxQueuedBytes) {
        this.failProtocol('outbound queue overflow');
        return 'closed';
      }
      this.queue.push(bytes.slice());
      this.queuedBytes += bytes.byteLength;
      return 'backpressure';
    }
    if (!this.writeFrame(bytes)) return 'closed';
    return this.channel.bufferedAmount > this.highWater ? 'backpressure' : 'sent';
  }

  bufferedAmount(): number {
    try {
      return this.channel.bufferedAmount;
    } catch {
      return 0;
    }
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.channel.close();
    } catch {
      // 通道可能已在关闭中
    }
    this.markClosed();
  }

  /** 整帧写出；任一分片失败即关闭载体（半帧不可恢复）。 */
  private writeFrame(bytes: Uint8Array): boolean {
    let parts: Uint8Array[];
    try {
      parts = fragmentFrame(this.nextFrameId, bytes, this.payloadSize);
    } catch (err) {
      this.failProtocol(err instanceof Error ? err.message : 'fragment failed');
      return false;
    }
    this.nextFrameId = (this.nextFrameId + 1) >>> 0 || 1;
    for (const part of parts) {
      try {
        this.channel.send(part);
      } catch {
        // 已写出的分片撤不回来，对端的重组器会永远等剩下的片：只能关闭载体让上层回落 primary。
        this.failProtocol('data channel send failed mid-frame');
        return false;
      }
    }
    return true;
  }

  private flushQueue(): void {
    while (!this.closed && this.queue.length > 0) {
      if (this.channel.readyState !== 'open') {
        this.markClosed();
        return;
      }
      if (this.channel.bufferedAmount > this.highWater) return; // 等下一次 bufferedamountlow
      const frame = this.queue[0];
      if (!frame) break;
      if (!this.writeFrame(frame)) return;
      this.queue.shift();
      this.queuedBytes -= frame.byteLength;
    }
    if (this.closed) return;
    for (const cb of this.drainCbs) {
      try {
        cb();
      } catch {
        // 同上
      }
    }
  }

  private failProtocol(reason: string): void {
    this.onProtocolError?.(reason);
    this.close();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.reassembler.clear();
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        // 同上
      }
    }
  }
}
