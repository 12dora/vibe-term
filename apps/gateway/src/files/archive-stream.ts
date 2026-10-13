import { errorMessage } from '@vibeterm/shared';
import { logAt } from '../log/level';

/** 正在等上游输出（有 pull 挂起）时，超过这么久没有任何数据就判定打包卡死。 */
export const ARCHIVE_IDLE_TIMEOUT_MS = 120_000;
/** 没有 pull 挂起（等下游来取）时，超过这么久没人取数据就判定客户端已断流。 */
export const ARCHIVE_STALL_TIMEOUT_MS = 15 * 60_000;
const STDERR_TAIL_CHARS = 2048;

export interface ArchiveProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

function spawnArchiveProcess(argv: string[], env?: Record<string, string>): ArchiveProcess {
  const proc = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill();
      } catch {
        // 已退出
      }
    },
  };
}

export const fileArchiveIo = {
  spawn: spawnArchiveProcess,
};

/** tar 的条目参数：名字一律以 `./` 开头，开头为 `-` 的文件名不会被当成选项；`.` 表示整个工作目录。 */
export function tarNameArgs(names: readonly string[]): string[] {
  return names.map((name) => (name === '.' ? '.' : `./${name}`));
}

export function tarArchiveArgs(parentDir: string, names: readonly string[]): string[] {
  return ['tar', '-czf', '-', '-C', parentDir, ...tarNameArgs(names)];
}

export interface ArchiveLimits {
  /** 仅在有 pull 挂起（等 tar 出数据）时计时，默认 `ARCHIVE_IDLE_TIMEOUT_MS`。 */
  idleMs?: number;
  /** 仅在没有 pull 挂起（等客户端来取）时计时，默认 `ARCHIVE_STALL_TIMEOUT_MS`。 */
  stallMs?: number;
  /** 累计输出字节上限，超过即终止。 */
  maxBytes: number;
  /** 流结束（正常 / 出错 / 取消）时恰好调用一次，用来释放 ssh spec。 */
  onClose?: () => void;
}

export interface ArchiveStreamOptions extends ArchiveLimits {
  argv: string[];
  env?: Record<string, string>;
}

class ArchiveRun {
  private finished = false;
  private total = 0;
  // 两种互斥的等待各用一个计时器：等上游（idle）与等下游（stall）。客户端慢但持续在读，
  // 只会反复进入 stall 并被下一次 pull 解除，不会误杀；tar 真的不出数据时 idle 到点即杀。
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stderrDone: Promise<void>;
  private readonly settled: Promise<undefined>;
  private release: () => void = () => {};

  constructor(
    private readonly proc: ArchiveProcess,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly opts: ArchiveLimits
  ) {
    this.reader = proc.stdout.getReader();
    this.stderrDone = this.drainStderr(proc.stderr);
    this.settled = new Promise<undefined>((resolve) => {
      this.release = () => resolve(undefined);
    });
    this.arm('stall');
  }

  async pull(): Promise<void> {
    if (this.finished) return;
    this.arm('idle');
    try {
      const chunk = await Promise.race([this.reader.read(), this.settled]);
      if (!chunk || this.finished) return;
      if (chunk.done) {
        await this.complete();
        return;
      }
      this.push(chunk.value);
    } catch (error) {
      this.fail(error);
    }
  }

  cancel(): void {
    if (!this.settle()) return;
    this.teardown(true);
  }

  private push(value: Uint8Array): void {
    this.total += value.byteLength;
    if (this.total > this.opts.maxBytes) {
      this.fail(new Error('archive_too_large'));
      return;
    }
    this.controller.enqueue(value);
    this.arm('stall');
  }

  /** stdout 读完后还要等进程退出码：tar 失败时必须让浏览器看到下载中断，而不是一个被截断的“成功”。 */
  private async complete(): Promise<void> {
    const code = await Promise.race([
      Promise.all([this.proc.exited, this.stderrDone]).then(([exitCode]) => exitCode),
      this.settled,
    ]);
    if (code === undefined || this.finished) return;
    if (code !== 0) {
      this.fail(new Error(`archive_exit_${code}`));
      return;
    }
    if (!this.settle()) return;
    this.controller.close();
    this.teardown(false);
  }

  private fail(error: unknown): void {
    if (!this.settle()) return;
    const tail = this.stderrTail.trim();
    logAt('warn', `[files] archive failed: ${errorMessage(error)}${tail ? ` stderr=${tail}` : ''}`);
    this.teardown(true);
    try {
      this.controller.error(error);
    } catch {
      // 控制器已关闭
    }
  }

  private settle(): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.disarm();
    this.release();
    return true;
  }

  private teardown(kill: boolean): void {
    if (kill) {
      this.proc.kill();
      this.reader.cancel().catch(() => {});
    }
    try {
      this.opts.onClose?.();
    } catch {
      // 释放失败不影响流的结束
    }
  }

  private arm(kind: 'idle' | 'stall'): void {
    this.disarm();
    if (this.finished) return;
    const ms =
      kind === 'idle'
        ? (this.opts.idleMs ?? ARCHIVE_IDLE_TIMEOUT_MS)
        : (this.opts.stallMs ?? ARCHIVE_STALL_TIMEOUT_MS);
    this.timer = setTimeout(() => this.fail(new Error(`archive_${kind}_timeout`)), ms);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async drainStderr(stderr: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stderr) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(
          -STDERR_TAIL_CHARS
        );
      }
    } catch {
      // 进程被杀时 stderr 管道可能直接报错，尾部日志尽力而为
    }
  }
}

/** 把已启动的子进程 stdout 变成可直接作为 Response body 的流，语义同 `createArchiveStream`。 */
export function createArchiveStreamFromProcess(
  proc: ArchiveProcess,
  limits: ArchiveLimits
): ReadableStream<Uint8Array> {
  let run: ArchiveRun | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      run = new ArchiveRun(proc, controller, limits);
    },
    pull() {
      return run?.pull();
    },
    cancel() {
      run?.cancel();
    },
  });
}

/**
 * 起进程并返回流：客户端取消即杀进程，非零退出 / 空闲或停滞超时 / 超过字节上限都会 `controller.error`。
 * spawn 同步失败时先调 `onClose` 再抛出。
 */
export function createArchiveStream(opts: ArchiveStreamOptions): ReadableStream<Uint8Array> {
  let proc: ArchiveProcess;
  try {
    proc = fileArchiveIo.spawn(opts.argv, opts.env);
  } catch (error) {
    opts.onClose?.();
    throw error;
  }
  return createArchiveStreamFromProcess(proc, opts);
}
