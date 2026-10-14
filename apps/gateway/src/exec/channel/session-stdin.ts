import type { ExecProcess } from './process';

const ACK_STEP_BYTES = 64 * 1024;

export class StdinPump {
  received = 0;
  eof = false;
  private written = 0;
  private lastAcked = 0;
  private queue: Uint8Array[] = [];
  private running = false;
  private ended = false;
  private stopped = false;

  constructor(
    private readonly proc: ExecProcess,
    private readonly sendAck: (written: number) => void
  ) {}

  push(bytes: Uint8Array): void {
    this.received += bytes.byteLength;
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

  private async run(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next && !this.stopped; next = this.queue.shift()) {
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
