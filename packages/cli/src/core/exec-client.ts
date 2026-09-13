// POST /api/exec：消费 NDJSON 事件，映射退出码。

import { JSON_BODY_MAX_BYTES } from '@vibeterm/shared/http';
import type { CliContext } from './context';
import {
  AuthError,
  CliError,
  EXIT_NETWORK,
  NetworkError,
  NotFoundError,
  UsageError,
} from './errors';

export const EXEC_TIMEOUT_EXIT = 124;
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
export const MAX_EXEC_TIMEOUT_MS = 3_600_000;
export const EXEC_STREAM_CLOSED = 'EXEC_STREAM_CLOSED';
/** 早期上限：给 JSON 信封 / 转义留余量，最终以序列化后的体为准。 */
export const MAX_EXEC_STDIN_BYTES = 740 * 1024;
export const EXEC_JSON_BODY_BUDGET = JSON_BODY_MAX_BYTES - 4096;
export const EXEC_MIN_MAX_BYTES = 1024;
export const EXEC_MAX_MAX_BYTES = 8 * 1024 * 1024;
export const EXEC_INLINE_HINT_BYTES = 64 * 1024;

export type ExecReason = 'exit' | 'timeout' | 'error';

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  truncated: { stdout: boolean; stderr: boolean };
  reason: ExecReason;
  errorCode: string | null;
  errorMessage: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutPath: string | null;
  stderrPath: string | null;
}

/** NDJSON 在收到 `exit` 前被掐断：HTTP 空闲、mesh RST、对端关闭。 */
export class ExecStreamClosedError extends NetworkError {
  readonly code = EXEC_STREAM_CLOSED;
  constructor(
    readonly reason: string,
    readonly elapsedMs: number,
    readonly stdoutBytes = 0,
    readonly stderrBytes = 0
  ) {
    super(`exec stream closed before exit (reason: ${reason}); the remote child receives SIGTERM`);
    this.name = 'ExecStreamClosedError';
  }
}

interface ExecEvent {
  type?: unknown;
  pid?: unknown;
  device?: unknown;
  base64?: unknown;
  code?: unknown;
  signal?: unknown;
  durationMs?: unknown;
  truncated?: unknown;
  message?: unknown;
  reason?: unknown;
  t?: unknown;
}

export interface ExecRequestBody {
  deviceId: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: { text: string } | { base64: string };
  timeoutMs?: number;
  shell?: boolean;
  maxBytes?: number;
}

export type ExecCollect = {
  tailBytes?: number;
  omitStdout?: boolean;
  omitStderr?: boolean;
  stdoutBag: Uint8Array;
  stderrBag: Uint8Array;
  stdoutDecoder: TextDecoder;
  stderrDecoder: TextDecoder;
};

export type ExecLiveWrites = {
  stdout: (bytes: Uint8Array) => void | Promise<void>;
  stderr: (bytes: Uint8Array) => void | Promise<void>;
};

export function createExecCollect(
  opts: {
    tailBytes?: number;
    omitStdout?: boolean;
    omitStderr?: boolean;
  } = {}
): ExecCollect {
  return {
    tailBytes: opts.tailBytes,
    omitStdout: opts.omitStdout,
    omitStderr: opts.omitStderr,
    stdoutBag: new Uint8Array(),
    stderrBag: new Uint8Array(),
    stdoutDecoder: new TextDecoder('utf-8'),
    stderrDecoder: new TextDecoder('utf-8'),
  };
}

/** `--tail` 切口可能落在码点中间：丢掉开头的 UTF-8 续字节再解码，避免 U+FFFD。 */
export function decodeUtf8Tail(bytes: Uint8Array): string {
  let start = 0;
  while (start < bytes.length && start < 4 && (bytes[start] & 0xc0) === 0x80) start += 1;
  if (start >= bytes.length) return '';
  return Buffer.from(bytes.subarray(start)).toString('utf8');
}

export function concatTail(
  prev: Uint8Array,
  incoming: Uint8Array,
  limit: number
): { bytes: Uint8Array; dropped: boolean } {
  if (limit <= 0) return { bytes: new Uint8Array(), dropped: incoming.byteLength > 0 };
  if (incoming.byteLength >= limit) {
    return { bytes: incoming.subarray(incoming.byteLength - limit), dropped: true };
  }
  const total = prev.byteLength + incoming.byteLength;
  if (total <= limit) {
    if (prev.byteLength === 0) return { bytes: incoming, dropped: false };
    const out = new Uint8Array(total);
    out.set(prev);
    out.set(incoming, prev.byteLength);
    return { bytes: out, dropped: false };
  }
  const out = new Uint8Array(limit);
  const keep = limit - incoming.byteLength;
  out.set(prev.subarray(prev.byteLength - keep));
  out.set(incoming, keep);
  return { bytes: out, dropped: true };
}

export function mapExecFailure(code: string | null, message: string): never {
  const text = message || code || 'exec failed';
  if (code === 'invalid_body') throw new UsageError(text);
  if (code === 'device_not_found') throw new NotFoundError(text);
  if (code === 'exec_timeout') {
    throw new CliError(text, EXEC_TIMEOUT_EXIT);
  }
  if (code === 'exec_spawn_failed' || code === 'exec_unsupported_device') {
    throw new NetworkError(text);
  }
  throw new CliError(text, EXIT_NETWORK);
}

function eventCode(event: ExecEvent): string | null {
  return typeof event.code === 'string' ? event.code : null;
}

function decodeChunk(raw: unknown): Uint8Array {
  if (typeof raw !== 'string' || !raw) return new Uint8Array();
  return Buffer.from(raw, 'base64');
}

function asTruncated(value: unknown): { stdout: boolean; stderr: boolean } {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { stdout: row.stdout === true, stderr: row.stderr === true };
}

export function emptyExecResult(): ExecResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: null,
    truncated: { stdout: false, stderr: false },
    reason: 'error',
    errorCode: null,
    errorMessage: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: null,
    stderrPath: null,
  };
}

function applyChunk(
  result: ExecResult,
  stream: 'stdout' | 'stderr',
  raw: unknown,
  collect?: ExecCollect
): Uint8Array {
  const bytes = decodeChunk(raw);
  if (stream === 'stdout') result.stdoutBytes += bytes.byteLength;
  else result.stderrBytes += bytes.byteLength;
  const omit = stream === 'stdout' ? collect?.omitStdout : collect?.omitStderr;
  if (omit) return bytes;
  const tail = collect?.tailBytes;
  if (tail !== undefined && collect) {
    applyTailChunk(result, collect, stream, bytes, tail);
    return bytes;
  }
  const decoder = stream === 'stdout' ? collect?.stdoutDecoder : collect?.stderrDecoder;
  if (decoder) {
    result[stream] += decoder.decode(bytes, { stream: true });
  } else {
    result[stream] += Buffer.from(bytes).toString('utf8');
  }
  return bytes;
}

function applyTailChunk(
  result: ExecResult,
  collect: ExecCollect,
  stream: 'stdout' | 'stderr',
  bytes: Uint8Array,
  tail: number
): void {
  const bagKey = stream === 'stdout' ? 'stdoutBag' : 'stderrBag';
  const next = concatTail(collect[bagKey], bytes, tail);
  collect[bagKey] = next.bytes;
  if (next.dropped) result.truncated[stream] = true;
  result[stream] = decodeUtf8Tail(next.bytes);
}

function flushStreamDecoder(
  result: ExecResult,
  collect: ExecCollect | undefined,
  stream: 'stdout' | 'stderr'
): void {
  if (!collect || collect.tailBytes !== undefined) return;
  const omit = stream === 'stdout' ? collect.omitStdout : collect.omitStderr;
  if (omit) return;
  const decoder = stream === 'stdout' ? collect.stdoutDecoder : collect.stderrDecoder;
  result[stream] += decoder.decode();
}

function applyExit(result: ExecResult, row: ExecEvent, collect?: ExecCollect): 'done' {
  flushStreamDecoder(result, collect, 'stdout');
  flushStreamDecoder(result, collect, 'stderr');
  result.exitCode = typeof row.code === 'number' ? row.code : null;
  result.signal = typeof row.signal === 'string' ? row.signal : null;
  result.durationMs = typeof row.durationMs === 'number' ? row.durationMs : null;
  const serverTruncated = asTruncated(row.truncated);
  result.truncated = {
    stdout: result.truncated.stdout || serverTruncated.stdout,
    stderr: result.truncated.stderr || serverTruncated.stderr,
  };
  if (row.reason === 'exec_timeout' || result.reason === 'timeout') {
    result.reason = 'timeout';
  } else {
    result.reason = 'exit';
  }
  return 'done';
}

function applyError(result: ExecResult, row: ExecEvent): 'continue' | 'done' {
  result.errorCode = eventCode(row);
  result.errorMessage = typeof row.message === 'string' ? row.message : result.errorCode;
  if (result.errorCode === 'exec_timeout') {
    result.reason = 'timeout';
    return 'continue';
  }
  result.reason = 'error';
  return 'done';
}

export async function applyExecEvent(
  result: ExecResult,
  event: unknown,
  live: ExecLiveWrites | null,
  streamJson: ((event: unknown) => void) | null,
  collect?: ExecCollect
): Promise<'continue' | 'done'> {
  // 网关每 10 s 发一条 ping 只为保活，逐行解析的脚本不需要看到它
  const isPing =
    Boolean(event) && typeof event === 'object' && (event as ExecEvent).type === 'ping';
  if (streamJson && !isPing) streamJson(event);
  if (!event || typeof event !== 'object') return 'continue';
  const row = event as ExecEvent;
  if (row.type === 'stdout' || row.type === 'stderr') {
    const bytes = applyChunk(result, row.type, row.base64, collect);
    if (live) await live[row.type](bytes);
    return 'continue';
  }
  if (row.type === 'exit') return applyExit(result, row, collect);
  if (row.type === 'error') return applyError(result, row);
  return 'continue';
}

export function execProcessExit(result: ExecResult): number {
  if (result.reason === 'timeout') return EXEC_TIMEOUT_EXIT;
  if (result.reason === 'error') {
    const code = result.errorCode;
    if (code === 'invalid_body') return 2;
    if (code === 'device_not_found') return 4;
    if (code === 'exec_spawn_failed' || code === 'exec_unsupported_device') return EXIT_NETWORK;
    return EXIT_NETWORK;
  }
  if (result.exitCode === null) return EXIT_NETWORK;
  return result.exitCode;
}

function codeFromHttpError(error: unknown): string | null {
  if (error instanceof CliError && typeof error.code === 'string' && error.code) return error.code;
  return null;
}

export type ExecRunOptions = {
  live?: ExecLiveWrites | null;
  streamJson?: ((event: unknown) => void) | null;
  collect?: ExecCollect;
};

function streamDeathReason(error: unknown): string | null {
  const name = (error as { name?: string } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError') return message || 'AbortError';
  if (error instanceof TypeError && /terminated/i.test(message)) return message;
  if (/terminated|socket connection was closed|socket closed/i.test(message)) return message;
  return null;
}

function throwIfStreamDeath(error: unknown, elapsedMs: number, result: ExecResult): void {
  const reason = streamDeathReason(error);
  if (reason) {
    throw new ExecStreamClosedError(reason, elapsedMs, result.stdoutBytes, result.stderrBytes);
  }
}

function finishExecStream(result: ExecResult, sawExit: boolean, elapsedMs: number): ExecResult {
  if (sawExit) return result;
  if (result.errorCode) return result;
  throw new ExecStreamClosedError(
    'ended without an exit event',
    elapsedMs,
    result.stdoutBytes,
    result.stderrBytes
  );
}

export async function runExecRequest(
  ctx: CliContext,
  nodeId: string,
  body: ExecRequestBody,
  options: ExecRunOptions = {}
): Promise<ExecResult> {
  const result = emptyExecResult();
  const live = options.live ?? null;
  const streamJson = options.streamJson ?? null;
  const collect = options.collect;
  const started = Date.now();
  const events = ctx.http.ndjson(nodeId, '/api/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  });
  let sawExit = false;
  try {
    for await (const event of events) {
      const status = await applyExecEvent(result, event, live, streamJson, collect);
      if (result.reason === 'exit' || result.reason === 'timeout') sawExit = true;
      if (status === 'done') break;
    }
  } catch (error) {
    if (
      error instanceof AuthError ||
      error instanceof NetworkError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    throwIfStreamDeath(error, Date.now() - started, result);
    mapExecFailure(
      codeFromHttpError(error),
      error instanceof Error ? error.message : String(error)
    );
  }
  return finishExecStream(result, sawExit, Date.now() - started);
}
