// 文件 API 的错误类型与响应解析，供 REST 端点与两段式传输共用。

import type { FileErrorCode } from '@vibeterm/shared';

export class FileApiError extends Error {
  status: number;
  /** 网关错误码；经 mesh 转发层时也可能是转发码（如 `NODE_LOGIN_REQUIRED`），按原样透传。 */
  code?: FileErrorCode;
  /** 网关随错误码附带的细分原因（如 `cross_device`、`source changed`） */
  detail?: string;
  constructor(status: number, message: string, code?: FileErrorCode, detail?: string) {
    super(message);
    this.name = 'FileApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 网络段重试用尽后抛出：连接中断 / 响应体被截断 / fetch 层 TypeError，没有任何服务端给出的原因。
 * 服务端明确回了错误（HTTP 错误包、NDJSON error 事件）时抛的是 `FileApiError`，不是它。
 */
export class TransferInterruptedError extends Error {
  constructor(
    readonly receivedBytes: number,
    readonly totalBytes: number,
    readonly cause: unknown
  ) {
    super(`transfer interrupted at ${receivedBytes}/${totalBytes} bytes`);
    this.name = 'TransferInterruptedError';
  }
}

/**
 * 把网络层失败（fetch TypeError、响应体中途被切断）归成 `TransferInterruptedError`。
 * 取消、服务端明确给出的错误（`FileApiError`）与协议解析错误（`SyntaxError`）原样保留。
 */
export function asInterrupted(err: unknown, receivedBytes: number, totalBytes: number): unknown {
  if (err instanceof TransferInterruptedError || err instanceof FileApiError) return err;
  if (err instanceof SyntaxError || (err as { name?: string } | null)?.name === 'AbortError') {
    return err;
  }
  return new TransferInterruptedError(receivedBytes, totalBytes, err);
}

/** 跑一段网络操作；失败按 `asInterrupted` 归类后抛出。 */
export async function guardNetwork<T>(
  run: () => Promise<T>,
  receivedBytes = 0,
  totalBytes = 0
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw asInterrupted(err, receivedBytes, totalBytes);
  }
}

/** 与网关 `file-http.ts` 的 `CODE_STATUS` 保持一致：NDJSON error 事件没有 HTTP 状态，按码还原。 */
const CODE_STATUS: Record<FileErrorCode, number> = {
  invalid: 400,
  outside_roots: 403,
  not_found: 404,
  not_a_directory: 400,
  is_directory: 400,
  too_large: 413,
  binary: 415,
  permission_denied: 403,
  already_exists: 409,
  device_not_found: 404,
  root_not_found: 404,
  root_disabled: 403,
  root_virtual: 400,
  connection_failed: 502,
  auth_unsupported: 400,
  rsync_missing_local: 502,
  rsync_missing_remote: 502,
  timeout: 504,
  unknown: 500,
};

export function httpStatusForCode(code: FileErrorCode | undefined): number {
  return (code && CODE_STATUS[code]) || 500;
}

/** NDJSON 流里的 `{type:'error', code, detail}` 事件 → 与 HTTP 错误包同形的 `FileApiError`。 */
export function fileErrorFromEvent(ev: { code?: FileErrorCode; detail?: string }): FileApiError {
  const code = ev.code ?? 'unknown';
  return new FileApiError(httpStatusForCode(code), ev.detail ?? code, code, ev.detail);
}

export function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

type ErrorBody = { error?: unknown; message?: unknown; code?: unknown; detail?: unknown };

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v !== '');
}

export async function parseError(res: Response): Promise<FileApiError> {
  let body: ErrorBody = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as ErrorBody;
  } catch {
    // 非 JSON 响应
  }
  const code = firstString(body.code) as FileErrorCode | undefined;
  const message = firstString(body.error, body.message, code) ?? `HTTP ${res.status}`;
  return new FileApiError(res.status, message, code, firstString(body.detail));
}
