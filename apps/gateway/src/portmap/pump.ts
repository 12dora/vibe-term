import type { LinkStream } from '@tmex/shared/link';
import type { PortMapCounters } from './types';

/** socket → 流方向的兜底缓冲上限：正常路径上 pause 已经封住，越界说明对端行为异常。 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/**
 * 拨号期间先攒下的数据上限。此时不能 pause socket——Bun 的暂停会连 close 事件一起压住，
 * 客户端中途断开就发现不了。
 */
const MAX_EARLY_BYTES = 1024 * 1024;

export type PumpSocket = {
  write(data: Uint8Array): number;
  end(): unknown;
  terminate(): void;
  pause(): void;
  resume(): void;
};

/** Bun socket 回调与泵之间的中转：拨号还没完成时先把早到的数据存下。 */
export type PumpSocketData = {
  pump: TcpStreamPump | null;
  early: Uint8Array[];
  earlyBytes: number;
  fin: boolean;
  closed: boolean;
};

export function createPumpSocketData(): PumpSocketData {
  return { pump: null, early: [], earlyBytes: 0, fin: false, closed: false };
}

export function attachPump(data: PumpSocketData, pump: TcpStreamPump): void {
  data.pump = pump;
  pump.start();
  data.earlyBytes = 0;
  for (const chunk of data.early.splice(0)) pump.onData(chunk);
  if (data.fin) pump.onEnd();
  if (data.closed) pump.onClose();
}

/** 返回 false 表示拨号还没完成就攒过了上限，调用方应直接断开这条连接。 */
export function onSocketData(data: PumpSocketData, chunk: Uint8Array): boolean {
  // Bun 会复用回调里的底层缓冲，异步写出前必须拷一份
  const copy = new Uint8Array(chunk);
  if (data.pump) {
    data.pump.onData(copy);
    return true;
  }
  data.early.push(copy);
  data.earlyBytes += copy.byteLength;
  return data.earlyBytes <= MAX_EARLY_BYTES;
}

/**
 * 一条 TCP 连接与一条 mux 流之间的双向泵。
 * 下行只在 socket 写入被接受后再取下一块，让 mux 的 WINDOW 额度直接成为跨 mesh 的背压；
 * 上行在 `stream.write` 未决期间暂停 socket，两侧都不额外缓冲。
 */
export class TcpStreamPump {
  private readonly socket: PumpSocket;
  private readonly stream: LinkStream;
  private readonly counters: PortMapCounters;
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private drainWaiters: Array<(ok: boolean) => void> = [];
  private uploading = false;
  private paused = false;
  private localFin = false;
  private streamEnded = false;
  private remoteEnded = false;
  private socketClosed = false;
  private destroyed = false;
  private started = false;

  constructor(socket: PumpSocket, stream: LinkStream, counters: PortMapCounters) {
    this.socket = socket;
    this.stream = stream;
    this.counters = counters;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stream.onAbort(() => {
      this.destroy('portmap-stream-aborted');
    });
    void this.runDownlink();
  }

  /** 本地 socket 收到数据。 */
  onData(bytes: Uint8Array): void {
    if (this.destroyed || bytes.byteLength === 0) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    if (this.pendingBytes > MAX_PENDING_BYTES) {
      this.destroy('portmap-buffer-overflow');
      return;
    }
    if (!this.paused) {
      this.paused = true;
      this.socket.pause();
    }
    void this.flushUplink();
  }

  /** 本地 socket 的发送缓冲已排空。 */
  onDrain(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) waiter(true);
  }

  /** 本地 socket 收到 FIN。 */
  onEnd(): void {
    this.localFin = true;
    if (!this.uploading) void this.endStream();
  }

  /**
   * 本地 socket 关闭。对端已经 END 时视为正常收尾——Bun 的 `socket.end()` 会连读半边一起关，
   * 收到 END 后关 socket 是唯一能把 EOF 传给本地客户端的做法，不该再回一个 RST。
   */
  onClose(): void {
    if (this.socketClosed) return;
    this.socketClosed = true;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) waiter(false);
    if (this.streamEnded) return;
    if (this.remoteEnded) {
      void this.endStream();
      return;
    }
    this.resetStream('portmap-socket-closed');
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resetStream(reason);
    try {
      this.socket.terminate();
    } catch {
      // 已经关闭
    }
  }

  private resetStream(reason: string): void {
    try {
      this.stream.reset(reason);
    } catch {
      // 流已经结束
    }
  }

  private async endStream(): Promise<void> {
    if (this.streamEnded || this.destroyed) return;
    this.streamEnded = true;
    try {
      await this.stream.end();
    } catch {
      // 对端已经收掉
    }
  }

  private async flushUplink(): Promise<void> {
    if (this.uploading) return;
    this.uploading = true;
    try {
      while (this.pending.length > 0 && !this.destroyed) {
        const chunk = this.pending.shift() as Uint8Array;
        this.pendingBytes -= chunk.byteLength;
        await this.stream.write(chunk);
        this.counters.bytesOut += chunk.byteLength;
      }
    } catch {
      this.uploading = false;
      this.destroy('portmap-stream-write-failed');
      return;
    }
    this.uploading = false;
    if (this.destroyed) return;
    if (this.paused && !this.socketClosed) {
      this.paused = false;
      this.socket.resume();
    }
    if (this.localFin) await this.endStream();
  }

  private async runDownlink(): Promise<void> {
    const reader = this.stream.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const bytes = value?.bytes;
        if (!bytes || bytes.byteLength === 0) continue;
        await this.writeToSocket(bytes);
        this.counters.bytesIn += bytes.byteLength;
      }
      this.remoteEnded = true;
      if (!this.socketClosed && !this.destroyed) this.socket.end();
    } catch {
      if (!this.destroyed) this.destroy('portmap-socket-write-failed');
    } finally {
      reader.releaseLock();
    }
  }

  private async writeToSocket(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.socketClosed || this.destroyed) throw new Error('socket closed');
      const written = this.socket.write(offset === 0 ? bytes : bytes.subarray(offset));
      if (written < 0) throw new Error('socket closed');
      offset += written;
      if (offset < bytes.byteLength && !(await this.waitDrain())) {
        throw new Error('socket closed');
      }
    }
  }

  private waitDrain(): Promise<boolean> {
    if (this.socketClosed || this.destroyed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
}
