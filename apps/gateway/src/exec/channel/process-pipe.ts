import type { ExecSignal } from '@vibeterm/shared/exec-channel';
import { GroupControl, type ProcessExitSource, toProcessExit } from './process-group';
import type { ExecProcess, ExecProcessExit } from './process-types';

type FileSinkLike = {
  write(data: Uint8Array): number | Promise<number>;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
};

export type PipeProc = ProcessExitSource & {
  pid: number;
  stdin?: FileSinkLike | number | null;
  stdout: ReadableStream<Uint8Array> | number | null | undefined;
  stderr: ReadableStream<Uint8Array> | number | null | undefined;
  exited: Promise<number>;
};

const GONE = Symbol('gone');

function isBrokenPipe(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ('code' in err && err.code === 'EPIPE') return true;
  return err instanceof Error && /EPIPE|broken pipe/i.test(err.message);
}

class StdinPipe {
  private gone = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly goneSignal: Promise<typeof GONE>;

  constructor(
    private sink: FileSinkLike | null,
    exited: Promise<unknown>
  ) {
    this.goneSignal = exited.then(
      () => {
        this.gone = true;
        return GONE;
      },
      () => {
        this.gone = true;
        return GONE;
      }
    );
  }

  write(bytes: Uint8Array): Promise<void> {
    return this.enqueue(async (sink) => {
      await sink.write(bytes);
      await sink.flush();
    });
  }

  end(): Promise<void> {
    return this.enqueue(async (sink) => {
      this.sink = null;
      await sink.end();
    });
  }

  private enqueue(op: (sink: FileSinkLike) => Promise<void>): Promise<void> {
    const run = this.tail.then(() => this.run(op));
    this.tail = run;
    return run;
  }

  private async run(op: (sink: FileSinkLike) => Promise<void>): Promise<void> {
    const sink = this.sink;
    if (!sink || this.gone) return;
    const work = op(sink);
    work.catch(() => {});
    try {
      await Promise.race([work, this.goneSignal]);
    } catch (err) {
      if (!isBrokenPipe(err) && !this.gone) throw err;
      this.gone = true;
    }
  }
}

class OutputPipe {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null;

  constructor(stream: ReadableStream<Uint8Array> | number | null | undefined) {
    this.reader = typeof stream === 'object' && stream !== null ? stream.getReader() : null;
  }

  async read(): Promise<Uint8Array | null> {
    const reader = this.reader;
    if (!reader) return null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          this.reader = null;
          return null;
        }
        if (value && value.byteLength > 0) return value;
      }
    } catch {
      this.reader = null;
      return null;
    }
  }
}

export function createPipeProcess(proc: PipeProc, onExit: () => void): ExecProcess {
  let hasExited = false;
  const control = new GroupControl(proc.pid, () => hasExited);
  const sink = typeof proc.stdin === 'object' && proc.stdin !== null ? proc.stdin : null;
  const stdin = new StdinPipe(sink, proc.exited);
  const stdout = new OutputPipe(proc.stdout);
  const stderr = new OutputPipe(proc.stderr);
  const exited = proc.exited.then((rawCode): ExecProcessExit => {
    hasExited = true;
    control.settle();
    onExit();
    return toProcessExit(proc, rawCode);
  });
  return {
    pid: proc.pid,
    pty: false,
    readStdout: () => stdout.read(),
    readStderr: () => stderr.read(),
    writeStdin: (bytes) => stdin.write(bytes),
    endStdin: () => stdin.end(),
    resize: () => {},
    signal: (sig: ExecSignal) => control.signal(sig),
    kill: () => control.kill(),
    exited,
  };
}
