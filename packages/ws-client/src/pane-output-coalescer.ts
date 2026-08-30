// per-pane 输出合并：高频小帧逐帧下发时，每帧都要在 WASM 里搬一次缓冲、查一次 alt-screen、
// 排一次渲染，成本按帧数线性增长。每条 WebSocket 消息是独立宏任务，微任务边界只能合并
// 同一条消息里的连续帧，因此这里用有界窗口：攒够 flushBytes 立即下发，否则最多等
// DEFAULT_PANE_OUTPUT_FLUSH_MS 毫秒（不用 rAF：一帧 16.7ms 的回显延迟比这更差）。
//
// 顺序保证：同一 pane 的字节严格按到达顺序拼接；任何会改变画面基线的事件
//（reset / history / snapshot / rebase / sink 换绑与注销）都要先 flush 再执行。
// 帧字节按引用暂存不复制：每帧的字节来自各自的解码结果，没有跨帧复用的缓冲。
import type { GatewayTerminalData } from './transport';

export const DEFAULT_PANE_OUTPUT_FLUSH_BYTES = 32 * 1024;
// 攒不满阈值时的最大附加延迟
export const DEFAULT_PANE_OUTPUT_FLUSH_MS = 4;

export type PaneOutputScheduler = (flush: () => void) => void;

export interface PaneOutputCoalescerOptions {
  flushBytes?: number;
  schedule?: PaneOutputScheduler;
}

interface PaneOutputBuffer {
  deviceId: string;
  paneId: string;
  paneEpoch?: Uint8Array;
  seqStart?: bigint;
  seqEnd?: bigint;
  chunks: Uint8Array[];
  bytes: number;
}

function sameEpoch(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function concatChunks(chunks: Uint8Array[], bytes: number): Uint8Array {
  const first = chunks[0];
  if (chunks.length === 1 && first) return first;
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function toFrame(buffer: PaneOutputBuffer): GatewayTerminalData {
  const frame: GatewayTerminalData = {
    deviceId: buffer.deviceId,
    paneId: buffer.paneId,
    data: concatChunks(buffer.chunks, buffer.bytes),
  };
  if (buffer.paneEpoch) frame.paneEpoch = buffer.paneEpoch;
  if (buffer.seqStart !== undefined) frame.seqStart = buffer.seqStart;
  if (buffer.seqEnd !== undefined) frame.seqEnd = buffer.seqEnd;
  return frame;
}

export class PaneOutputCoalescer {
  private readonly buffers = new Map<string, PaneOutputBuffer>();
  private readonly flushBytes: number;
  private readonly schedule: PaneOutputScheduler;
  private scheduled = false;

  constructor(
    private readonly emit: (key: string, frame: GatewayTerminalData) => void,
    options: PaneOutputCoalescerOptions = {}
  ) {
    this.flushBytes = options.flushBytes ?? DEFAULT_PANE_OUTPUT_FLUSH_BYTES;
    this.schedule =
      options.schedule ?? ((flush) => void setTimeout(flush, DEFAULT_PANE_OUTPUT_FLUSH_MS));
  }

  push(key: string, frame: GatewayTerminalData): void {
    const buffered = this.buffers.get(key);
    // epoch 变化意味着服务端重排了这个 pane 的序列，跨 epoch 的字节不能拼在一起
    if (buffered && !sameEpoch(buffered.paneEpoch, frame.paneEpoch)) {
      this.flush(key);
    }

    const buffer = this.buffers.get(key) ?? this.createBuffer(key, frame);
    buffer.chunks.push(frame.data);
    buffer.bytes += frame.data.byteLength;
    if (frame.seqEnd !== undefined) buffer.seqEnd = frame.seqEnd;

    if (buffer.bytes >= this.flushBytes) {
      this.flush(key);
      return;
    }
    this.ensureScheduled();
  }

  flush(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key);
    this.emit(key, toFrame(buffer));
  }

  flushAll(): void {
    for (const key of [...this.buffers.keys()]) {
      this.flush(key);
    }
  }

  discardMatching(predicate: (key: string) => boolean): void {
    for (const key of [...this.buffers.keys()]) {
      if (predicate(key)) this.buffers.delete(key);
    }
  }

  discardAll(): void {
    this.buffers.clear();
  }

  private createBuffer(key: string, frame: GatewayTerminalData): PaneOutputBuffer {
    const buffer: PaneOutputBuffer = {
      deviceId: frame.deviceId,
      paneId: frame.paneId,
      chunks: [],
      bytes: 0,
    };
    if (frame.paneEpoch) buffer.paneEpoch = frame.paneEpoch;
    if (frame.seqStart !== undefined) buffer.seqStart = frame.seqStart;
    this.buffers.set(key, buffer);
    return buffer;
  }

  private ensureScheduled(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flushAll();
    });
  }
}
