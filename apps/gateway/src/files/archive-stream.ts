import { errorMessage } from '@vibeterm/shared';
import { logAt } from '../log/level';

/** 超过这么久没有任何输出就判定打包卡死。 */
export const ARCHIVE_IDLE_TIMEOUT_MS = 120_000;
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
  /** 流整个生命周期内，多久没有向下游交付新数据就终止，默认 `ARCHIVE_IDLE_TIMEOUT_MS`。 */
  idleMs?: number;
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
    // 计时覆盖整个流的生命周期：客户端不读（背压）而连接不断时，进程也不能一直挂着
    this.armIdle();
  }

  async pull(): Promise<void> {
    if (this.finished) return;
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
    this.armIdle();
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
    this.disarmIdle();
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

  private armIdle(): void {
    this.disarmIdle();
    this.timer = setTimeout(
      () => this.fail(new Error('archive_idle_timeout')),
      this.opts.idleMs ?? ARCHIVE_IDLE_TIMEOUT_MS
    );
  }

  private disarmIdle(): void {
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
 * 起进程并返回流：客户端取消即杀进程，非零退出 / 空闲超时 / 超过字节上限都会 `controller.error`。
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
