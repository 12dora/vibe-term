// 浏览器侧的 `RTCDataChannel` 载体：分片发送、重组接收、高低水位背压。
//
// 与 node 侧 `DataChannelCarrier` 同语义（`send` 返回 `sent | backpressure | closed`），
// 高水位 4 MiB、`bufferedAmountLowThreshold` 1 MiB，见设计 §3。
//
// 注意：`sess` 通道的**首帧 nonce 不经过本类**——node 侧在挂载载体之前先读走一条裸消息
// （`RtcPeerManager.acceptBrowser`），因此首帧必须是未分片的原始 JSON，由控制器直接写通道。

import { FRAGMENT_PAYLOAD_SIZE, FrameReassembler, fragmentFrame } from './fragmenter';

export const DC_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const DC_LOW_WATER_BYTES = 1 * 1024 * 1024;

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
}

export class DirectDataChannelCarrier {
  readonly channel: RTCDataChannelLike;
  private readonly reassembler: FrameReassembler;
  private readonly highWater: number;
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private readonly drainCbs: Array<() => void> = [];
  private nextFrameId = 1;
  private closed = false;

  constructor(channel: RTCDataChannelLike, options: DirectDataChannelCarrierOptions = {}) {
    this.channel = channel;
    this.reassembler = options.reassembler ?? new FrameReassembler();
    this.highWater = options.highWaterBytes ?? DC_HIGH_WATER_BYTES;
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

    channel.onbufferedamountlow = () => {
      for (const cb of this.drainCbs) {
        try {
          cb();
        } catch {
          // 同上
        }
      }
    };

    channel.onclose = () => this.markClosed();
    channel.onerror = () => this.markClosed();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(bytes: Uint8Array): CarrierSendResult {
    if (this.closed || this.channel.readyState !== 'open') return 'closed';
    const frameId = this.nextFrameId;
    this.nextFrameId = (this.nextFrameId + 1) >>> 0 || 1;
    for (const part of fragmentFrame(frameId, bytes, FRAGMENT_PAYLOAD_SIZE)) {
      try {
        this.channel.send(part);
      } catch {
        if (this.channel.readyState !== 'open') {
          this.markClosed();
          return 'closed';
        }
        return 'backpressure';
      }
    }
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

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
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
