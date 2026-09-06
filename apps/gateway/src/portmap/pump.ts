import type { LinkStream } from '@tmex/shared/link';
import { halfCloseSupported, shutdownWriteHalf } from './half-close';
import type { PortMapCounters } from './types';

/** socket → 流方向的兜底缓冲上限：正常路径上 pause 已经封住，越界说明对端行为异常。 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/**
 * 拨号窗口里的兜底缓冲上限。拨号期间 socket 是 pause 的，正常情况下这里始终为空；
 * 留一份余量只为兜住 pause 生效前底层已经读上来的那一次数据。
 */
const MAX_EARLY_BYTES = 1024 * 1024;

export type PumpSocket = {
  write(data: Uint8Array): number;
  /** 只关写半边、保留读半边。返回 false 表示环境不支持，socket 已被整条关掉。 */
  endWrite(): boolean;
  /** 两个方向都结束后的正常收尾（发 FIN，不发 RST）。 */
  close(): void;
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
  /** socket 真正处置掉（close/error/拨号失败）时回调一次，用来归还并发名额。 */
  onDisposed: (() => void) | null;
};

export function createPumpSocketData(): PumpSocketData {
  return { pump: null, early: [], earlyBytes: 0, fin: false, closed: false, onDisposed: null };
}

/** 幂等：无论 socket 是自己关的还是拨号失败被丢弃的，名额只归还一次。 */
export function disposePumpSocketData(data: PumpSocketData): void {
  const done = data.onDisposed;
  data.onDisposed = null;
  done?.();
}

export function attachPump(data: PumpSocketData, pump: TcpStreamPump): void {
  data.pump = pump;
  pump.start();
  data.earlyBytes = 0;
  for (const chunk of data.early.splice(0)) pump.onData(chunk);
  if (data.fin) pump.onEnd();
  if (data.closed) pump.onClose();
  pump.resumeReads();
}

/** 返回 false 表示拨号窗口里攒过了上限，调用方应直接断开这条连接。 */
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

/** 把 Bun 的 socket 适配成泵要的形状：写半边关闭走 POSIX shutdown，退化时才整条关。 */
export function bunPumpSocket(socket: Bun.Socket<PumpSocketData>): PumpSocket {
  const quietly = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // 已经关闭
    }
  };
  return {
    write: (data) => socket.write(data),
    endWrite: () => {
      if (!halfCloseSupported()) {
        quietly(() => socket.end());
        return false;
      }
      // 与 socket.resume() 同一个 tick 里做 shutdown，Bun 会把读半边一起丢掉，推迟一个宏任务
      setTimeout(() => {
        if (!shutdownWriteHalf(socket)) quietly(() => socket.end());
      }, 0);
      return true;
    },
    close: () => quietly(() => socket.end()),
    terminate: () => quietly(() => socket.terminate()),
    pause: () => quietly(() => socket.pause()),
    resume: () => quietly(() => socket.resume()),
  };
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
  private writeHalfClosed = false;
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

  /** 拨号期间可能被停读过，接上泵之后由泵决定继续读还是保持暂停。 */
  resumeReads(): void {
    if (this.paused || this.destroyed || this.socketClosed) return;
    this.socket.resume();
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

  /** 本地 socket 收到 FIN：读半边到头，写半边照旧。 */
  onEnd(): void {
    if (this.localFin) return;
    this.localFin = true;
    if (!this.uploading) void this.endStream();
    if (this.remoteEnded) this.socket.close();
  }

  /** 本地 socket 关闭。对端已经 END 时视为正常收尾，不再回 RST。 */
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
    this.socket.terminate();
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

  /**
   * 对端 END：把 FIN 传给本地 socket，但保留读半边——目标服务完全可能读到 EOF 之后才产生响应。
   * 两个方向都结束时才整条关闭。
   */
  private finishWriteHalf(): void {
    if (this.writeHalfClosed || this.socketClosed || this.destroyed) return;
    this.writeHalfClosed = true;
    if (this.localFin) {
      this.socket.close();
      return;
    }
    this.socket.endWrite();
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
      this.finishWriteHalf();
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
