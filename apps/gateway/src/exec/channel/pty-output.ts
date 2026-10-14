import { ExecChannelError } from './errors';

export const PTY_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

type Waiter = { resolve: (chunk: Uint8Array | null) => void };

/** Bun 的 Terminal 推送式回调没有暂停手段，这里排队并在超限时由调用方终止进程。 */
export class PtyOutput {
  private chunks: Uint8Array[] = [];
  private queued = 0;
  private waiter: Waiter | null = null;
  private ended = false;
  private failure: Error | null = null;

  constructor(private readonly limit = PTY_OUTPUT_LIMIT_BYTES) {}

  /** 返回 true 表示队列已溢出（已转为失败态）。 */
  push(data: Uint8Array): boolean {
    if (this.ended || this.failure || data.byteLength === 0) return false;
    const chunk = data.slice();
    if (this.waiter) {
      this.settleWaiter((w) => w.resolve(chunk));
      return false;
    }
    this.chunks.push(chunk);
    this.queued += chunk.byteLength;
    if (this.queued <= this.limit) return false;
    this.fail(new ExecChannelError('exec_spawn_failed', 'pty output overflow'));
    return true;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.chunks.length === 0) this.settleWaiter((w) => w.resolve(null));
  }

  read(): Promise<Uint8Array | null> {
    const next = this.chunks.shift();
    if (next) {
      this.queued -= next.byteLength;
      return Promise.resolve(next);
    }
    if (this.failure) return this.consumeFailure();
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = { resolve };
    });
  }

  private fail(err: Error): void {
    this.chunks = [];
    this.queued = 0;
    this.failure = err;
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
