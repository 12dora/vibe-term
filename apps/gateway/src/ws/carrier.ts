import type { ServerWebSocket } from 'bun';

/** `backpressure` = 已入队；`rejected` = 未接受。 */
export type CarrierSendResult = 'sent' | 'backpressure' | 'rejected' | 'closed';

export type CarrierKind = 'physical_browser_ws' | 'mesh_link_stream';

export type CarrierLogContext = {
  kind?: CarrierKind;
  sessionId?: string;
  cid?: string;
  nodeId?: string;
};

export interface CarrierSendManyOptions {
  /** true（缺省）时首帧一旦不是 `sent` 就停发余下帧；false 只在 `closed`/`rejected` 时停 */
  stopOnBackpressure?: boolean;
}

export interface CarrierSendManyResult {
  /** 与入参一一对应的发送结果；提前停发时长度更短 */
  statuses: CarrierSendResult[];
  /** 整批写完后的缓冲水位（cork 结束后读，批内读到的是陈旧值） */
  bufferedAmount: number;
}

export interface Carrier {
  send(bytes: Uint8Array): CarrierSendResult;
  /**
   * 批量发送。实现可把整批合进一次系统调用（Bun 的 `socket.cork`），
   * 缺省不实现时调用方退回逐帧 `send()`。
   */
  sendMany?(frames: readonly Uint8Array[], options?: CarrierSendManyOptions): CarrierSendManyResult;
  /**
   * 控制面优先发送（PONG 等）。缺省等价于 `send()`。
   * DataChannel 实现会把帧送进有界优先队列，在 drain 时先于 remainder 刷出。
   */
  sendPriority?(bytes: Uint8Array): CarrierSendResult;
  bufferedAmount(): number;
  onDrain(cb: () => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
  hasPendingWrites?(): boolean;
  logContext?: CarrierLogContext;
}

export class BunSocketCarrier implements Carrier {
  readonly logContext: CarrierLogContext = { kind: 'physical_browser_ws' };
  private readonly drainCallbacks: Array<() => void> = [];

  constructor(private readonly socket: ServerWebSocket<unknown>) {}

  send(bytes: Uint8Array): CarrierSendResult {
    try {
      const status = this.socket.send(bytes);
      if (status > 0) return 'sent';
      if (status === -1) return 'backpressure';
      return 'closed';
    } catch {
      return 'closed';
    }
  }

  /**
   * 整批帧写在一次 `cork` 里：Bun 把批内的 `send()` 合并成一次写出，
   * 省掉逐帧的系统调用与 WS 帧头分片。水位只在 cork 结束后读一次（批内是陈旧值）。
   */
  sendMany(
    frames: readonly Uint8Array[],
    options: CarrierSendManyOptions = {}
  ): CarrierSendManyResult {
    const stopOnBackpressure = options.stopOnBackpressure ?? true;
    const statuses: CarrierSendResult[] = [];

    try {
      this.socket.cork(() => {
        for (const bytes of frames) {
          const status = this.send(bytes);
          statuses.push(status);
          if (status === 'sent') continue;
          if (stopOnBackpressure || status === 'closed' || status === 'rejected') return;
        }
      });
    } catch {
      // cork 自身抛出（socket 已经没了）：把当前帧记成 closed，交由调用方收敛
      if (statuses.length < frames.length) statuses.push('closed');
    }

    return { statuses, bufferedAmount: this.bufferedAmount() };
  }

  bufferedAmount(): number {
    try {
      return Math.max(0, this.socket.getBufferedAmount());
    } catch {
      return 0;
    }
  }

  onDrain(cb: () => void): void {
    this.drainCallbacks.push(cb);
  }

  emitDrain(): void {
    for (const cb of this.drainCallbacks) {
      cb();
    }
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // The socket may already be closing.
    }
  }

  terminate(): void {
    try {
      this.socket.terminate();
    } catch {
      // The socket may already be closing.
    }
  }
}
