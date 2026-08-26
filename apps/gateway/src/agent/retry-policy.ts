import { APICallError, RetryError } from 'ai';

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const NETWORK_ERROR_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'socket',
  'connection',
  'network',
  'und_err',
];

function isNetworkError(error: unknown, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) {
    return false;
  }
  const haystack =
    `${error.name} ${error.message} ${(error as { code?: unknown }).code ?? ''}`.toLowerCase();
  if (NETWORK_ERROR_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return true;
  }
  return isNetworkError(error.cause, depth + 1);
}

export function isRetryableLlmError(error: unknown): boolean {
  if (RetryError.isInstance(error)) {
    return true;
  }
  if (APICallError.isInstance(error)) {
    if (error.isRetryable) {
      return true;
    }
    return error.statusCode !== undefined && error.statusCode >= 500;
  }
  if (error instanceof TypeError) {
    return isNetworkError(error);
  }
  return false;
}

export type RunRetryDecision =
  | { action: 'aborted' }
  | { action: 'retry'; delayMs: number }
  | { action: 'fail' };

export function decideRunRetry(params: {
  aborted: boolean;
  attempt: number;
  retryDelaysMs: readonly number[];
  error: unknown;
}): RunRetryDecision {
  if (params.aborted) {
    return { action: 'aborted' };
  }
  if (params.attempt < params.retryDelaysMs.length && isRetryableLlmError(params.error)) {
    const delayMs = params.retryDelaysMs[params.attempt];
    if (delayMs !== undefined) {
      return { action: 'retry', delayMs };
    }
  }
  return { action: 'fail' };
}
