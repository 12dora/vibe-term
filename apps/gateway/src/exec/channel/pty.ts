import type { ExecSignal } from '@vibeterm/shared/exec-channel';
import { ExecChannelError, spawnFailed } from './errors';
import { GroupControl, toProcessExit } from './process-group';
import type { ExecProcess, ExecProcessExit } from './process-types';
import { PtyOutput } from './pty-output';

const PTY_CLOSE_GRACE_MS = 500;
const PTY_WRITE_DRAIN_TIMEOUT_MS = 5_000;
const EOT = new Uint8Array([0x04]);

export type PtySpawnOptions = {
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  term: string;
  onExit: () => void;
};

type PtyTerminal = {
  readonly closed: boolean;
  write(data: string | BufferSource): number;
  resize(cols: number, rows: number): void;
  close(): void;
};

type PtyProc = {
  pid: number;
  terminal?: PtyTerminal;
  exited: Promise<number>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | number | null;
};

export function ptySupported(): boolean {
  return typeof (Bun as { Terminal?: unknown }).Terminal === 'function';
}

export function spawnPtyProcess(argv: string[], opts: PtySpawnOptions): ExecProcess {
  if (!ptySupported()) {
    throw new ExecChannelError('pty_unsupported', 'this Bun runtime has no PTY support');
  }
  const output = new PtyOutput();
  const events = new PtyEvents(output);
  let proc: PtyProc;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env,
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        name: opts.term,
        data: (_term, bytes) => events.onData(bytes),
        exit: () => events.onTerminalClosed(),
        drain: () => events.onDrain(),
      },
    }) as unknown as PtyProc;
  } catch (err) {
    throw spawnFailed(err);
  }
  if (!proc.terminal) {
    try {
      process.kill(proc.pid, 'SIGKILL');
    } catch {
      // 已退出
    }
    throw new ExecChannelError('pty_unsupported', 'this Bun runtime has no PTY support');
  }
  return new PtyProcess(proc, proc.terminal, output, events, opts.onExit);
}

class PtyEvents {
  private terminalClosed = false;
  private processExited = false;
  private finished = false;
  private drainWaiter: (() => void) | null = null;
  onOverflow: () => void = () => {};
  onFinish: () => void = () => {};

  constructor(private readonly output: PtyOutput) {}

  onData(bytes: Uint8Array): void {
    if (this.output.push(bytes)) this.onOverflow();
  }

  onTerminalClosed(): void {
    this.terminalClosed = true;
    this.maybeFinish();
  }

  onProcessExited(): void {
    this.processExited = true;
    this.releaseDrain();
    if (this.maybeFinish()) return;
    setTimeout(() => this.finish(), PTY_CLOSE_GRACE_MS).unref();
  }

  onDrain(): void {
    this.releaseDrain();
  }

  waitDrain(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.releaseDrain(), PTY_WRITE_DRAIN_TIMEOUT_MS);
      this.drainWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private releaseDrain(): void {
    const waiter = this.drainWaiter;
    this.drainWaiter = null;
    waiter?.();
  }

  private maybeFinish(): boolean {
    if (!this.terminalClosed || !this.processExited) return false;
    this.finish();
    return true;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.output.end();
    this.onFinish();
  }
}

class PtyProcess implements ExecProcess {
  readonly pty = true;
  readonly exited: Promise<ExecProcessExit>;
  private readonly control: GroupControl;
  private hasExited = false;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly proc: PtyProc,
    private readonly terminal: PtyTerminal,
    private readonly output: PtyOutput,
    private readonly events: PtyEvents,
    onExit: () => void
  ) {
    this.control = new GroupControl(proc.pid, () => this.hasExited);
    events.onOverflow = () => this.control.signal('SIGKILL');
    events.onFinish = () => this.closeTerminal();
    this.exited = proc.exited.then((rawCode) => {
      this.hasExited = true;
      this.control.settle();
      onExit();
      events.onProcessExited();
      return toProcessExit(proc, rawCode);
    });
  }

  get pid(): number | null {
    return this.proc.pid;
  }

  readStdout(): Promise<Uint8Array | null> {
    return this.output.read();
  }

  readStderr(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  writeStdin(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return Promise.resolve();
    return this.enqueueWrite(bytes);
  }

  endStdin(): Promise<void> {
    return this.enqueueWrite(EOT);
  }

  resize(cols: number, rows: number): void {
    if (this.terminal.closed) return;
    try {
      this.terminal.resize(cols, rows);
    } catch {
      // 终端已关闭
    }
  }

  signal(sig: ExecSignal): void {
    this.control.signal(sig);
  }

  kill(): void {
    this.control.kill();
  }

  private enqueueWrite(bytes: Uint8Array): Promise<void> {
    const run = this.writeTail.then(async () => {
      if (this.hasExited || this.terminal.closed) return;
      try {
        this.terminal.write(bytes);
      } catch {
        return;
      }
      await this.events.waitDrain();
    });
    this.writeTail = run;
    return run;
  }

  private closeTerminal(): void {
    try {
      this.terminal.close();
    } catch {
      // 已关闭
    }
  }
}
