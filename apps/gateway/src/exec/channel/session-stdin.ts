import type { ExecProcess } from './process';

const ACK_STEP_BYTES = 64 * 1024;

export class StdinPump {
  received = 0;
  eof = false;
  private written = 0;
  private lastAcked = 0;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private running = false;
  private ended = false;
  private stopped = false;

  constructor(
    private readonly proc: ExecProcess,
    private readonly sendAck: (written: number) => void
  ) {}

  /** 已收到但子进程尚未写完的字节（含正在写入的一块）。 */
  get pending(): number {
    return this.received - this.written;
  }

  push(bytes: Uint8Array): void {
    this.received += bytes.byteLength;
    this.queued += bytes.byteLength;
    this.queue.push(bytes);
    this.kick();
  }

  end(): void {
    this.eof = true;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.queued = 0;
  }

  /**
   * resume 时调用：丢弃尚未开始写入的排队字节，返回客户端应据以补发的偏移。
   * 客户端 outbox 的确认偏移单调不回退，若保留排队字节，窗口会在断线重连后被重复计入。
   */
  rewind(): { stdin: number; closed: boolean } {
    if (this.queue.length > 0) {
      this.queue = [];
      this.received -= this.queued;
      this.queued = 0;
      this.eof = false;
    }
    return { stdin: this.received, closed: this.eof };
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.run();
  }

  private async writeOne(bytes: Uint8Array): Promise<void> {
    try {
      await this.proc.writeStdin(bytes);
    } catch {
      // 子进程已关闭 stdin：丢弃并继续计数，避免客户端窗口卡死
    }
    this.written += bytes.byteLength;
    if (this.written - this.lastAcked >= ACK_STEP_BYTES) this.flushAck();
  }

  private flushAck(): void {
    if (this.written === this.lastAcked) return;
    this.lastAcked = this.written;
    this.sendAck(this.written);
  }

  private take(): Uint8Array | undefined {
    const next = this.queue.shift();
    if (next) this.queued -= next.byteLength;
    return next;
  }

  private async run(): Promise<void> {
    try {
      for (let next = this.take(); next && !this.stopped; next = this.take()) {
        await this.writeOne(next);
      }
      this.flushAck();
      if (this.eof && !this.ended && !this.stopped) {
        this.ended = true;
        await this.proc.endStdin().catch(() => undefined);
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0 || (this.eof && !this.ended)) this.kick();
    }
  }
}
