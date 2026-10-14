import { ExecChannelError } from './errors';

export const PTY_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const PTY_LOW_WATER_BYTES = 1024 * 1024;
export const PTY_HARD_CAP_BYTES = 64 * 1024 * 1024;

type Waiter = { resolve: (chunk: Uint8Array | null) => void };

export type PtyFlowControl = {
  pause: () => void;
  resume: () => void;
};

export type PtyOutputOptions = Partial<PtyFlowControl> & {
  highWater?: number;
  lowWater?: number;
  hardCap?: number;
};

const noop = () => {};

/**
 * Bun 的 Terminal 推送式回调无法暂停：队列越过高水位时暂停子进程（SIGSTOP），
 * 被消费到低水位以下再恢复；硬上限只兜底暂停来不及生效的极端情况，
 * 触发后保留已排队数据，投递完毕再以错误结束。
 */
export class PtyOutput {
  flow: PtyFlowControl;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly hardCap: number;
  private chunks: Uint8Array[] = [];
  private queued = 0;
  private waiter: Waiter | null = null;
  private ended = false;
  private paused = false;
  private flowDisabled = false;
  private failure: Error | null = null;
  private overflowed = false;

  constructor(options: PtyOutputOptions = {}) {
    this.highWater = options.highWater ?? PTY_HIGH_WATER_BYTES;
    this.lowWater = Math.min(options.lowWater ?? PTY_LOW_WATER_BYTES, this.highWater);
    this.hardCap = Math.max(options.hardCap ?? PTY_HARD_CAP_BYTES, this.highWater);
    this.flow = { pause: options.pause ?? noop, resume: options.resume ?? noop };
  }

  get pausedByFlowControl(): boolean {
    return this.paused;
  }

  /** 返回 true 表示越过硬上限（已转为失败态，调用方应终止进程）。 */
  push(data: Uint8Array): boolean {
    if (this.ended || this.overflowed || data.byteLength === 0) return false;
    const chunk = data.slice();
    if (this.waiter) {
      this.settleWaiter((w) => w.resolve(chunk));
      return false;
    }
    this.chunks.push(chunk);
    this.queued += chunk.byteLength;
    if (this.queued > this.hardCap) {
      this.overflowed = true;
      this.failure = new ExecChannelError('exec_spawn_failed', 'pty output overflow');
      return true;
    }
    if (!this.paused && !this.flowDisabled && this.queued > this.highWater) {
      this.paused = true;
      this.flow.pause();
    }
    return false;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.releasePause();
    if (this.chunks.length === 0 && !this.failure) this.settleWaiter((w) => w.resolve(null));
  }

  /** 进程即将被终止：解除暂停并不再暂停，否则待处理的 SIGTERM 会被随后的 SIGSTOP 压住。 */
  stopFlowControl(): void {
    this.flowDisabled = true;
    this.releasePause();
  }

  /** 解除暂停（进程需要接收信号、被终止或已结束时调用）。 */
  releasePause(): void {
    if (!this.paused) return;
    this.paused = false;
    this.flow.resume();
  }

  read(): Promise<Uint8Array | null> {
    const next = this.chunks.shift();
    if (next) {
      this.queued -= next.byteLength;
      if (this.paused && this.queued <= this.lowWater) this.releasePause();
      return Promise.resolve(next);
    }
    if (this.failure) return this.consumeFailure();
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = { resolve };
    });
  }

  private consumeFailure(): Promise<Uint8Array | null> {
    const err = this.failure;
    this.failure = null;
    this.ended = true;
    return err ? Promise.reject(err) : Promise.resolve(null);
  }

  private settleWaiter(fn: (waiter: Waiter) => void): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) fn(waiter);
  }
}
