import { EXEC_CHUNK_BYTES, EXEC_KILL_GRACE_MS, EXEC_STREAM_CAP_BYTES } from './constants';
import { emptyStreamCap, encodeBase64, takeStreamBytes } from './stream-cap';
import type { ExecSink } from './types';

export type ExecProc = {
  pid?: number;
  stdin: unknown;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
  exitCode: number | null;
  signalCode: NodeJS.Signals | number | null;
};

export type RunChildOpts = {
  stdin?: Uint8Array;
  timeoutMs: number;
  signal?: AbortSignal;
  sink: ExecSink;
  device: { id: string; type: 'local' | 'ssh' };
  maxBytes?: number;
};

export async function runChild(proc: ExecProc, opts: RunChildOpts): Promise<void> {
  const startedAt = Date.now();
  const stdoutCap = emptyStreamCap();
  const stderrCap = emptyStreamCap();
  opts.sink.emit({
    type: 'start',
    pid: typeof proc.pid === 'number' ? proc.pid : null,
    device: opts.device,
  });
  const timedOut = { value: false };
  const stopKill = armTimeout(proc, opts, timedOut);
  const limit = opts.maxBytes ?? EXEC_STREAM_CAP_BYTES;
  try {
    await Promise.all([
      pumpStdin(proc, opts.stdin),
      pumpStream(proc.stdout, 'stdout', stdoutCap, opts.sink, limit),
      pumpStream(proc.stderr, 'stderr', stderrCap, opts.sink, limit),
      proc.exited,
    ]);
  } finally {
    stopKill();
  }
  emitExit({
    proc,
    sink: opts.sink,
    startedAt,
    timedOut: timedOut.value,
    truncated: { stdout: stdoutCap.truncated, stderr: stderrCap.truncated },
  });
}

type StdinSink = {
  write?: (data: Uint8Array) => unknown;
  end?: () => unknown;
};

async function pumpStdin(proc: ExecProc, bytes: Uint8Array | undefined): Promise<void> {
  if (!proc.stdin || typeof proc.stdin === 'number') return;
  const sink = proc.stdin as StdinSink;
  const gone = { value: false };
  const markGone = () => {
    gone.value = true;
  };
  void proc.exited.then(markGone, markGone);
  try {
    await writeStdinChunks(sink, bytes, gone);
    if (!gone.value) await settle(sink.end?.());
  } catch (err) {
    if (isBrokenPipe(err) || gone.value) return;
    throw err;
  }
}

async function writeStdinChunks(
  sink: StdinSink,
  bytes: Uint8Array | undefined,
  gone: { value: boolean }
): Promise<void> {
  if (!bytes || bytes.byteLength === 0) return;
  for (let off = 0; off < bytes.byteLength; off += EXEC_CHUNK_BYTES) {
    if (gone.value) return;
    const end = Math.min(off + EXEC_CHUNK_BYTES, bytes.byteLength);
    await settle(sink.write?.(bytes.subarray(off, end)));
  }
}

async function settle(value: unknown): Promise<void> {
  if (value != null && typeof value === 'object' && 'then' in value) {
    await (value as Promise<unknown>);
  }
}

function isBrokenPipe(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ('code' in err && err.code === 'EPIPE') return true;
  return err instanceof Error && /EPIPE|broken pipe/i.test(err.message);
}

function armTimeout(proc: ExecProc, opts: RunChildOpts, timedOut: { value: boolean }): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const killOnce = () => escalateKill(proc, timers);
  const onAbort = () => killOnce();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  timers.push(
    setTimeout(() => {
      timedOut.value = true;
      killOnce();
    }, opts.timeoutMs)
  );
  if (opts.signal?.aborted) killOnce();
  return () => {
    opts.signal?.removeEventListener('abort', onAbort);
    for (const t of timers) clearTimeout(t);
  };
}

function escalateKill(proc: ExecProc, timers: ReturnType<typeof setTimeout>[]): void {
  try {
    proc.kill('SIGTERM');
  } catch {
    // already gone
  }
  timers.push(
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, EXEC_KILL_GRACE_MS)
  );
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null,
  kind: 'stdout' | 'stderr',
  cap: { sent: number; truncated: boolean },
  sink: ExecSink,
  limit: number
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0 || !sink.isOpen()) continue;
    for (const chunk of takeStreamBytes(cap, value, EXEC_CHUNK_BYTES, limit)) {
      sink.emit({ type: kind, base64: encodeBase64(chunk) });
    }
  }
}

function emitExit(input: {
  proc: ExecProc;
  sink: ExecSink;
  startedAt: number;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
}): void {
  if (!input.sink.isOpen()) return;
  input.sink.emit({
    type: 'exit',
    code: input.timedOut ? null : input.proc.exitCode,
    signal: input.timedOut ? 'SIGTERM' : signalName(input.proc.signalCode),
    durationMs: Date.now() - input.startedAt,
    truncated: input.truncated,
    reason: input.timedOut ? 'exec_timeout' : 'exit',
  });
  if (input.timedOut) {
    input.sink.emit({ type: 'error', code: 'exec_timeout', message: 'exec timed out' });
  }
}

function signalName(code: NodeJS.Signals | number | null): string | null {
  return typeof code === 'string' ? code : null;
}
