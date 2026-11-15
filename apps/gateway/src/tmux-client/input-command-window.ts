import { logAt } from '../log/level';
import {
  SEND_KEYS_HEX_CHUNK_BYTES,
  buildSendKeysArgv,
  parseSendKeysHexArgv,
} from './input-encoder';
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

export type InputCommandExecute = (argv: string[], onAck?: () => void) => Promise<unknown>;

interface JobCompletion {
  resolve(): void;
  reject(error: unknown): void;
}

interface InputCommandJob {
  argv: string[];
  submission?: InputSubmission;
  bytes: number;
  execute: InputCommandExecute;
  acks: Array<() => void>;
  completions: JobCompletion[];
}

function argvBytes(argv: readonly string[]): number {
  let n = 0;
  for (const part of argv) n += part.length;
  return n;
}

function resolveJob(job: InputCommandJob): void {
  for (const completion of job.completions) completion.resolve();
}

function rejectJob(job: InputCommandJob, error: unknown): void {
  for (const completion of job.completions) completion.reject(error);
}

function fireAcks(job: InputCommandJob): () => void {
  return () => {
    for (const ack of job.acks) ack();
  };
}

function mergedSendKeysArgv(last: readonly string[], incoming: readonly string[]): string[] | null {
  const left = parseSendKeysHexArgv(last);
  const right = parseSendKeysHexArgv(incoming);
  if (!left || !right || left.paneId !== right.paneId) return null;
  if (left.hex.length + right.hex.length > SEND_KEYS_HEX_CHUNK_BYTES) return null;
  return buildSendKeysArgv(left.paneId, left.hex.concat(right.hex));
}

function canMergeJobs(last: InputCommandJob, incoming: InputCommandJob): string[] | null {
  if (last.submission !== incoming.submission) return null;
  return mergedSendKeysArgv(last.argv, incoming.argv);
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

  get pendingJobCount(): number {
    return this.pending.length;
  }

  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  enqueue(
    commands: readonly string[][],
    execute: InputCommandExecute,
    submission?: InputSubmission,
    onAck?: () => void
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (commands.length === 0) return Promise.resolve();
    if (this.wouldExceed(commands, submission)) {
      this.warnFull();
      return Promise.reject(new InputQueueFullError());
    }
    const result = this.accept(commands, execute, submission, onAck);
    const unsubscribe = submission?.onCancel(() => this.cancelPending(submission));
    if (unsubscribe) void result.then(unsubscribe, unsubscribe);
    this.pump();
    return result;
  }

  dispose(reason: string): void {
    if (this.closed) return;
    this.closed = new Error(reason);
    this.pendingBytes = 0;
    for (const job of this.pending.splice(0)) rejectJob(job, this.closed);
  }

  private accept(
    commands: readonly string[][],
    execute: InputCommandExecute,
    submission: InputSubmission | undefined,
    onAck: (() => void) | undefined
  ): Promise<void> {
    const completions = commands.map(
      (argv) =>
        new Promise<void>((resolve, reject) => {
          this.pushJob({
            argv: argv.slice(),
            bytes: argvBytes(argv),
            execute,
            submission,
            acks: onAck ? [onAck] : [],
            completions: [{ resolve, reject }],
          });
        })
    );
    return Promise.all(completions).then(() => undefined);
  }

  private pushJob(job: InputCommandJob): void {
    if (this.mergeIntoLast(job)) return;
    this.pending.push(job);
    this.pendingBytes += job.bytes;
  }

  private mergeIntoLast(incoming: InputCommandJob): boolean {
    const last = this.pending.at(-1);
    if (!last) return false;
    const merged = canMergeJobs(last, incoming);
    if (!merged) return false;
    const previousBytes = last.bytes;
    last.argv = merged;
    last.bytes = argvBytes(merged);
    last.completions.push(...incoming.completions);
    last.acks.push(...incoming.acks);
    this.pendingBytes += last.bytes - previousBytes;
    return true;
  }

  private wouldExceed(commands: readonly string[][], submission?: InputSubmission): boolean {
    const extra = this.extraCost(commands, submission);
    if (extra.entries > 0 && this.pending.length >= INPUT_PENDING_MAX_ENTRIES) return true;
    return this.pendingBytes + extra.bytes > INPUT_PENDING_MAX_BYTES;
  }

  private extraCost(
    commands: readonly string[][],
    submission?: InputSubmission
  ): { entries: number; bytes: number } {
    const last = this.pending.at(-1);
    let lastArgv = last?.argv;
    let lastBytes = last?.bytes ?? 0;
    let lastSubmission = last?.submission;
    let entries = 0;
    let bytes = 0;
    for (const argv of commands) {
      const merged =
        lastArgv && lastSubmission === submission ? mergedSendKeysArgv(lastArgv, argv) : null;
      if (merged) {
        const mergedBytes = argvBytes(merged);
        bytes += mergedBytes - lastBytes;
        lastArgv = merged;
        lastBytes = mergedBytes;
        continue;
      }
      entries += 1;
      const size = argvBytes(argv);
      bytes += size;
      lastArgv = argv;
      lastBytes = size;
      lastSubmission = submission;
    }
    return { entries, bytes };
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
      if (job) resolveJob(job);
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
        resolveJob(job);
        continue;
      }
      this.startJob(job);
    }
  }

  private startJob(job: InputCommandJob): void {
    this.inFlight += 1;
    let result: Promise<unknown>;
    try {
      result = job.execute(job.argv, fireAcks(job));
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      () => {
        resolveJob(job);
        this.finish();
      },
      (error) => {
        rejectJob(job, error);
        this.finish();
      }
    );
  }

  private finish(): void {
    this.inFlight -= 1;
    this.pump();
  }
}
