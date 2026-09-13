import { logAt } from '../log/level';
import type { InputSubmission } from './input-submission';

export const INPUT_PENDING_MAX_ENTRIES = 256;
/**
 * pending argv 字节上限。WS 输入帧天花板是 1 MiB（`DEFAULT_MAX_FRAME_BYTES`）；
 * `send-keys -H` 按 256 字节切块后 argv 为 hex（2×）加每块命令前缀，1 MiB 粘贴约 2.16 MiB argv
 * （paneId `%1`：4096 × 527）。取 3 MiB 让单次 1 MiB 粘贴在空窗上能入队。
 */
export const INPUT_PENDING_MAX_BYTES = 3 * 1024 * 1024;
const FULL_WARN_INTERVAL_MS = 5_000;

export class InputQueueFullError extends Error {
  readonly code = 'input_queue_full' as const;
  constructor() {
    super('input_queue_full');
    this.name = 'InputQueueFullError';
  }
}

export function isQueueFullError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === 'input_queue_full' || code === 'control_queue_full';
}

interface InputCommandJob {
  submission?: InputSubmission;
  bytes: number;
  run(): Promise<unknown>;
  resolve(): void;
  reject(error: unknown): void;
}

function argvBytes(argv: string[]): number {
  let n = 0;
  for (const part of argv) n += part.length;
  return n;
}

export class InputCommandWindow {
  private readonly pending: InputCommandJob[] = [];
  private pendingBytes = 0;
  private inFlight = 0;
  private pumping = false;
  private closed: Error | null = null;
  private lastFullWarnAt = 0;

  constructor(private readonly capacity: () => number) {}

  get disposed(): boolean {
    return this.closed !== null;
  }

  enqueue(
    commands: readonly string[][],
    execute: (argv: string[]) => Promise<unknown>,
    submission?: InputSubmission
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (commands.length === 0) return Promise.resolve();
    if (this.wouldExceed(commands)) {
      this.warnFull();
      return Promise.reject(new InputQueueFullError());
    }
    const completions = commands.map(
      (argv) =>
        new Promise<void>((resolve, reject) => {
          const bytes = argvBytes(argv);
          this.pending.push({ run: () => execute(argv), resolve, reject, submission, bytes });
          this.pendingBytes += bytes;
        })
    );
    const result = Promise.all(completions).then(() => undefined);
    const unsubscribe = submission?.onCancel(() => this.cancelPending(submission));
    if (unsubscribe) void result.then(unsubscribe, unsubscribe);
    this.pump();
    return result;
  }

  dispose(reason: string): void {
    if (this.closed) return;
    this.closed = new Error(reason);
    this.pendingBytes = 0;
    for (const job of this.pending.splice(0)) job.reject(this.closed);
  }

  private wouldExceed(commands: readonly string[][]): boolean {
    if (this.pending.length >= INPUT_PENDING_MAX_ENTRIES) return true;
    let extraBytes = 0;
    for (const argv of commands) extraBytes += argvBytes(argv);
    return this.pendingBytes + extraBytes > INPUT_PENDING_MAX_BYTES;
  }

  private warnFull(): void {
    const now = Date.now();
    if (now - this.lastFullWarnAt < FULL_WARN_INTERVAL_MS) return;
    this.lastFullWarnAt = now;
    logAt(
      'warn',
      `[tmux] input_queue_full pending=${this.pending.length} bytes=${this.pendingBytes}`
    );
  }

  private cancelPending(submission: InputSubmission): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index].submission !== submission) continue;
      const [job] = this.pending.splice(index, 1);
      this.pendingBytes = Math.max(0, this.pendingBytes - (job?.bytes ?? 0));
      job?.resolve();
    }
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.startPending();
    } finally {
      this.pumping = false;
    }
  }

  private startPending(): void {
    while (!this.closed && this.inFlight < this.capacity()) {
      const job = this.pending.shift();
      if (!job) return;
      this.pendingBytes = Math.max(0, this.pendingBytes - job.bytes);
      if (job.submission && !job.submission.isValid()) {
        job.resolve();
        continue;
      }
      this.inFlight += 1;
      let result: Promise<unknown>;
      try {
        result = job.run();
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        () => {
          job.resolve();
          this.finish();
        },
        (error) => {
          job.reject(error);
          this.finish();
        }
      );
    }
  }

  private finish(): void {
    this.inFlight -= 1;
    this.pump();
  }
}
