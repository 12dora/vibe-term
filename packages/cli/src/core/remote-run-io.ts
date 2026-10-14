// runRemote 的本地 IO 侧：终端探测、PTY 取舍（ssh -t/-tt/-T 语义）、stdin 来源、带背压的 fd 写入。

import { createReadStream } from 'node:fs';
import { constants, access } from 'node:fs/promises';
import type { ExecCommand } from '@vibeterm/shared/exec-channel';
import { UsageError } from './errors';

export type Terminal = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  term?: string;
};

export function processTerminal(): Terminal {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    term: process.env.TERM,
  };
}

export const isTty = (stream: { isTTY?: boolean }): boolean => stream.isTTY === true;

/** auto = 无 -t；force = -t；always = -tt；no = -T。 */
export type TtyMode = 'auto' | 'force' | 'always' | 'no';
export type StdinMode = 'auto' | 'none' | { file: string };

export const PTY_NOT_ALLOCATED = '标准输入不是终端，未分配伪终端（-tt 可强制分配）';

/** ssh 语义：自动分配只看 stdin 是否终端（无命令即登录 shell）；stdout 被重定向不影响。 */
export function decidePty(mode: TtyMode, command: ExecCommand, stdinIsTty: boolean): boolean {
  if (mode === 'no') return false;
  if (mode === 'always') return true;
  if (mode === 'force') return stdinIsTty;
  return command.kind === 'login' && stdinIsTty;
}

const PTY_MIN = 1;
const PTY_MAX = 1000;
const PTY_DEFAULT = { cols: 80, rows: 24 };

function clampSize(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.min(PTY_MAX, Math.max(PTY_MIN, Math.floor(value)));
}

export function ptySpec(term: Terminal): { cols: number; rows: number; term?: string } {
  const spec = {
    cols: clampSize(term.stdout.columns, PTY_DEFAULT.cols),
    rows: clampSize(term.stdout.rows, PTY_DEFAULT.rows),
  };
  return term.term ? { ...spec, term: term.term } : spec;
}

export type StdinPlan = {
  /** 子进程是否有 stdin（spec.stdin）。 */
  forward: boolean;
  /** 由终端本身供给 stdin（PTY 且 stdin 是 TTY）：交给通道的 tty，不再给流。 */
  useTty: boolean;
  /** 每次尝试各开一次；返回的流由 `release` 收尾。 */
  open(): NodeJS.ReadableStream | null;
  release(stream: NodeJS.ReadableStream | null): void;
};

const NO_STDIN: StdinPlan = {
  forward: false,
  useTty: false,
  open: () => null,
  release: () => {},
};

async function filePlan(path: string): Promise<StdinPlan> {
  try {
    await access(path, constants.R_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`cannot read stdin file ${path}: ${detail}`);
  }
  return {
    forward: true,
    useTty: false,
    open: () => createReadStream(path),
    release: (stream) => (stream as { destroy?: () => void } | null)?.destroy?.(),
  };
}

/**
 * auto：一律转发 stdin（与 ssh 一致）。TTY 且未分配 PTY 时按行模式（不进 raw 模式）读，
 * Ctrl-D 即 EOF；分配了 PTY 时终端本身就是输入。`-n`（none）才不读取。
 */
export async function planStdin(mode: StdinMode, term: Terminal, pty: boolean): Promise<StdinPlan> {
  if (mode === 'none') return NO_STDIN;
  if (typeof mode === 'object') return filePlan(mode.file);
  const useTty = isTty(term.stdin) && pty;
  return {
    forward: true,
    useTty,
    open: () => (useTty ? null : term.stdin),
    release: () => {
      if (!useTty) term.stdin.pause();
    },
  };
}

/** 本地输出端已关闭（EPIPE，如 `| head`）：干净地停下，不当作错误。 */
export class OutputClosedError extends Error {
  constructor() {
    super('output closed');
    this.name = 'OutputClosedError';
  }
}

/** 本地输出端关闭：本文件的 OutputClosedError，或通道层在本地写 EPIPE 后抛出的 LocalOutputClosedError。 */
export function isOutputClosed(error: unknown): boolean {
  return (
    error instanceof OutputClosedError ||
    (error instanceof Error && error.name === 'LocalOutputClosedError')
  );
}

type StreamState = { failure: Error | null };
const states = new WeakMap<object, StreamState>();

function stateOf(stream: NodeJS.WritableStream): StreamState {
  let state = states.get(stream);
  if (state) return state;
  const created: StreamState = { failure: null };
  states.set(stream, created);
  state = created;
  // 常驻监听：EPIPE 往往在 write 返回之后才异步触发，没人接会变成未捕获异常。
  stream.on('error', (error: Error) => {
    created.failure ??= error;
  });
  return state;
}

const CLOSED_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

function failureOf(stream: NodeJS.WritableStream, state: StreamState): Error | null {
  if (state.failure) {
    const code = (state.failure as NodeJS.ErrnoException).code;
    return code && CLOSED_CODES.has(code) ? new OutputClosedError() : state.failure;
  }
  return (stream as { destroyed?: boolean }).destroyed ? new OutputClosedError() : null;
}

/** 写满即等 drain（背压）；对端关闭 / 流出错时在下一次写入抛出。 */
export function fdWriter(stream: NodeJS.WritableStream): (bytes: Uint8Array) => Promise<void> {
  const state = stateOf(stream);
  return async (bytes) => {
    const before = failureOf(stream, state);
    if (before) throw before;
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (stream.write(chunk)) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        stream.removeListener('drain', done);
        stream.removeListener('close', done);
        stream.removeListener('error', done);
        resolve();
      };
      stream.once('drain', done);
      stream.once('close', done);
      stream.once('error', done);
    });
    const after = failureOf(stream, state);
    if (after) throw after;
  };
}
