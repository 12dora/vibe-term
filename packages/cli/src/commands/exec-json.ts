// exec 的 `--json` 输出：单对象 / NDJSON 事件流，写入带背压，输出端关闭（EPIPE）时静默收场。

import type { ExecReady } from '@vibeterm/shared/exec-channel';
import { type FlagValues, flagBool, flagNumber } from '../core/args';
import type { CliContext } from '../core/context';
import { CliError, NotFoundError, UsageError } from '../core/errors';
import type { ExecChannelResult } from '../core/exec-channel';
import {
  EXEC_INLINE_HINT_BYTES,
  EXEC_MAX_MAX_BYTES,
  EXEC_MIN_MAX_BYTES,
  EXEC_STREAM_CLOSED,
  ExecStreamClosedError,
} from '../core/exec-client';
import type { RemoteRunSinks } from '../core/remote-run';
import { fdWriter, isOutputClosed } from '../core/remote-run-io';
import { type ExecFiles, StreamCollector, writeSink } from './exec-sink';

/** 被 SIGPIPE 杀掉的退出码（128 + 13）。 */
export const SIGPIPE_EXIT = 141;

export type JsonPlan = {
  enabled: boolean;
  stream: boolean;
  maxBytes: number;
  tailBytes: number | undefined;
};

export type OutputPlan = {
  sinks: Partial<RemoteRunSinks>;
  onReady?: (ready: ExecReady) => void;
  finish(result: ExecChannelResult): Promise<void>;
  fail(error: unknown): Promise<void>;
};

type Collectors = { stdout: StreamCollector; stderr: StreamCollector };
type StreamName = 'stdout' | 'stderr';
const STREAMS: readonly StreamName[] = ['stdout', 'stderr'];

type JsonLines = {
  emit: (row: unknown) => Promise<void>;
  /** 等已写入的内容真正落到 fd；此前发生的 EPIPE 在这里抛 OutputClosedError。 */
  flush: () => Promise<void>;
};

/** 一行一个 JSON；写满等 drain，对端关闭时抛 OutputClosedError。 */
export function jsonLineWriter(stream: NodeJS.WritableStream): JsonLines {
  const write = fdWriter(stream);
  return {
    emit: (row) => write(Buffer.from(`${JSON.stringify(row)}\n`)),
    async flush() {
      await new Promise<void>((resolve) => {
        stream.write('', () => resolve());
      });
      await write(new Uint8Array(0));
    },
  };
}

/** 吞掉「输出端已关闭」：调用方在收场路径上用，其余错误照常抛。 */
async function unlessClosed(task: Promise<void>): Promise<void> {
  try {
    await task;
  } catch (error) {
    if (!isOutputClosed(error)) throw error;
  }
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function pathOf(files: ExecFiles, name: StreamName): string | null {
  return name === 'stdout' ? files.stdoutPath : files.stderrPath;
}

function jsonPayload(result: ExecChannelResult, files: ExecFiles, c: Collectors): unknown {
  const row: Record<string, unknown> = {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    truncated: { stdout: c.stdout.truncated, stderr: c.stderr.truncated },
    reason: result.reason,
  };
  for (const name of STREAMS) {
    const path = pathOf(files, name);
    if (path) {
      row[`${name}Path`] = path;
      row[`${name}Bytes`] = c[name].bytes;
    } else {
      row[name] = c[name].text();
    }
  }
  return row;
}

function hintLargeInline(ctx: CliContext, files: ExecFiles, c: Collectors): void {
  for (const name of STREAMS) {
    if (pathOf(files, name) === null && c[name].bytes > EXEC_INLINE_HINT_BYTES) {
      ctx.out.warn(
        `${name} is ${c[name].bytes} bytes; pass --tail N or --${name}-file <path> to keep JSON small`
      );
    }
  }
}

function byteBound(flags: FlagValues, key: string, min: number): number | undefined {
  const raw = flagNumber(flags, key);
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < min || raw > EXEC_MAX_MAX_BYTES) {
    throw new UsageError(`--${key} must be an integer between ${min} and ${EXEC_MAX_MAX_BYTES}`);
  }
  return raw;
}

export function planJson(ctx: CliContext, flags: FlagValues): JsonPlan {
  const enabled = ctx.globals.json;
  const stream = flagBool(flags, 'stream');
  const maxBytes = byteBound(flags, 'max-bytes', EXEC_MIN_MAX_BYTES);
  const tailBytes = byteBound(flags, 'tail', 1);
  if (!enabled) {
    if (stream) throw new UsageError('--stream requires --json');
    if (maxBytes !== undefined) throw new UsageError('--max-bytes requires --json');
    if (tailBytes !== undefined) throw new UsageError('--tail requires --json');
  }
  return { enabled, stream, maxBytes: maxBytes ?? EXEC_MAX_MAX_BYTES, tailBytes };
}

/** 网关 NDJSON 的退出原因：超时叫 exec_timeout；通道新增的 killed 原样给出。 */
function streamReason(reason: ExecChannelResult['reason']): string {
  return reason === 'timeout' ? 'exec_timeout' : reason;
}

/** 旧 NDJSON 的 error 事件码：能对上网关码的对上，其余用错误自带码。 */
function errorCodeOf(error: unknown): string {
  if (error instanceof UsageError) return 'invalid_body';
  if (error instanceof NotFoundError) return 'device_not_found';
  if (error instanceof CliError && error.code) return error.code;
  return 'exec_failed';
}

function streamEvents(emit: JsonLines['emit'], files: ExecFiles, collectors: Collectors) {
  const sink = (name: StreamName) => async (bytes: Uint8Array) => {
    await writeSink(files[name], bytes);
    collectors[name].push(bytes);
    await emit({ type: name, base64: base64Of(bytes) });
  };
  return { stdout: sink('stdout'), stderr: sink('stderr') };
}

async function finishStream(emit: JsonLines['emit'], result: ExecChannelResult): Promise<void> {
  const { exitCode: code, signal, durationMs } = result;
  await emit({
    type: 'exit',
    code,
    signal,
    durationMs,
    truncated: { stdout: false, stderr: false },
    reason: streamReason(result.reason),
  });
  if (result.reason === 'timeout') {
    await emit({ type: 'error', code: 'exec_timeout', message: 'exec timed out' });
  }
}

function streamClosedRow(error: ExecStreamClosedError, files: ExecFiles): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ok: false,
    code: EXEC_STREAM_CLOSED,
    reason: error.reason,
    elapsedMs: error.elapsedMs,
    stdoutBytes: error.stdoutBytes,
    stderrBytes: error.stderrBytes,
  };
  if (files.stdoutPath) row.stdoutPath = files.stdoutPath;
  if (files.stderrPath) row.stderrPath = files.stderrPath;
  return row;
}

export function jsonOutput(ctx: CliContext, json: JsonPlan, files: ExecFiles): OutputPlan {
  const lines = jsonLineWriter(ctx.out.stdoutStream());
  const { emit } = lines;
  const collect = (name: StreamName) =>
    new StreamCollector({
      inline: !pathOf(files, name) && !json.stream,
      maxBytes: json.maxBytes,
      tailBytes: json.tailBytes,
    });
  const collectors: Collectors = { stdout: collect('stdout'), stderr: collect('stderr') };
  const sinks = json.stream
    ? streamEvents(emit, files, collectors)
    : {
        stdout: async (bytes: Uint8Array) => {
          await writeSink(files.stdout, bytes);
          collectors.stdout.push(bytes);
        },
        stderr: async (bytes: Uint8Array) => {
          await writeSink(files.stderr, bytes);
          collectors.stderr.push(bytes);
        },
      };
  let started = false;
  const onReady = (ready: ExecReady): void => {
    if (started) return;
    started = true;
    unlessClosed(emit({ type: 'start', pid: ready.pid, device: ready.device })).catch(() => {});
  };
  return {
    sinks,
    ...(json.stream ? { onReady } : {}),
    async finish(result) {
      if (json.stream) await finishStream(emit, result);
      else await emit(jsonPayload(result, files, collectors));
      await lines.flush();
      if (!json.stream) hintLargeInline(ctx, files, collectors);
    },
    async fail(error) {
      if (error instanceof ExecStreamClosedError) {
        await unlessClosed(emit(streamClosedRow(error, files)));
        return;
      }
      if (!json.stream || isOutputClosed(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      await unlessClosed(emit({ type: 'error', code: errorCodeOf(error), message }));
    },
  };
}
