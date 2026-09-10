// CLI 的退出码与错误类型。命令只抛这些错误，退出码由 main.ts 统一翻译。

export const EXIT_OK = 0;
export const EXIT_GENERIC = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_NETWORK = 5;
/** SIGINT / SIGTERM 清理完后的约定退出码（128 + 2）。 */
export const EXIT_INTERRUPTED = 130;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_GENERIC,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_USAGE, hint);
    this.name = 'UsageError';
  }
}

/** 需要登录 / 需要二次验证：退出码 3，message 里必须写清下一步命令。 */
export class AuthError extends CliError {
  constructor(
    message: string,
    hint?: string,
    readonly code?: string
  ) {
    super(message, EXIT_AUTH, hint);
    this.name = 'AuthError';
  }
}

/**
 * 服务端明确拒绝（403 且不是会话问题，如 `outside_roots` / `FORBIDDEN`）：退出码 1，
 * `code` 保留服务端给的业务码，message 里必须带上它。重登录救不了这类错误。
 */
export class PermissionError extends CliError {
  constructor(
    message: string,
    readonly code?: string,
    hint?: string
  ) {
    super(message, EXIT_GENERIC, hint);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_NOT_FOUND, hint);
    this.name = 'NotFoundError';
  }
}

/** 连不上 / 超时 / DNS：退出码 5。服务端给出的业务码一律不算网络错误。 */
export class NetworkError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_NETWORK, hint);
    this.name = 'NetworkError';
  }
}

/** 用户中断（SIGINT/SIGTERM）：清理完后退出 130。 */
export class InterruptError extends CliError {
  constructor(message = 'interrupted') {
    super(message, EXIT_INTERRUPTED);
    this.name = 'InterruptError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InterruptError();
}

export function rethrowIfAborted(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || error instanceof InterruptError) throw new InterruptError();
  throw error;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function exitCodeOf(error: unknown): number {
  return error instanceof CliError ? error.exitCode : EXIT_GENERIC;
}

export function hintOf(error: unknown): string | undefined {
  return error instanceof CliError ? error.hint : undefined;
}
