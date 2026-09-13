// POST /api/exec：消费 NDJSON 事件，映射退出码。

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
}

export interface ExecRequestBody {
  deviceId: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: { text: string } | { base64: string };
  timeoutMs?: number;
  shell?: boolean;
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
  };
}

function applyChunk(
  result: ExecResult,
  live: { stdout: (bytes: Uint8Array) => void; stderr: (bytes: Uint8Array) => void } | null,
  stream: 'stdout' | 'stderr',
  raw: unknown
): 'continue' {
  const bytes = decodeChunk(raw);
  if (live) live[stream](bytes);
  result[stream] += Buffer.from(bytes).toString('utf8');
  return 'continue';
}

function applyExit(result: ExecResult, row: ExecEvent): 'done' {
  result.exitCode = typeof row.code === 'number' ? row.code : null;
  result.signal = typeof row.signal === 'string' ? row.signal : null;
  result.durationMs = typeof row.durationMs === 'number' ? row.durationMs : null;
  result.truncated = asTruncated(row.truncated);
  if (result.reason !== 'timeout') result.reason = 'exit';
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

export function applyExecEvent(
  result: ExecResult,
  event: unknown,
  live: { stdout: (bytes: Uint8Array) => void; stderr: (bytes: Uint8Array) => void } | null,
  streamJson: ((event: unknown) => void) | null
): 'continue' | 'done' {
  if (streamJson) streamJson(event);
  if (!event || typeof event !== 'object') return 'continue';
  const row = event as ExecEvent;
  if (row.type === 'stdout') return applyChunk(result, live, 'stdout', row.base64);
  if (row.type === 'stderr') return applyChunk(result, live, 'stderr', row.base64);
  if (row.type === 'exit') return applyExit(result, row);
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

export async function runExecRequest(
  ctx: CliContext,
  nodeId: string,
  body: ExecRequestBody,
  live: { stdout: (bytes: Uint8Array) => void; stderr: (bytes: Uint8Array) => void } | null,
  streamJson: ((event: unknown) => void) | null
): Promise<ExecResult> {
  const result = emptyExecResult();
  const events = ctx.http.ndjson(nodeId, '/api/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  });
  try {
    for await (const event of events) {
      if (applyExecEvent(result, event, live, streamJson) === 'done') break;
    }
  } catch (error) {
    if (
      error instanceof AuthError ||
      error instanceof NetworkError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    mapExecFailure(
      codeFromHttpError(error),
      error instanceof Error ? error.message : String(error)
    );
  }
  if (result.reason === 'error' && !result.errorCode && result.exitCode === null) {
    result.errorCode = 'exec_spawn_failed';
    result.errorMessage = 'exec stream ended without an exit event';
  }
  return result;
}
