import { describe, expect, test } from 'bun:test';
import { APICallError, RetryError } from 'ai';
import { decideRunRetry, isRetryableLlmError, toErrorMessage } from './retry-policy';

function apiError(statusCode: number | undefined, isRetryable?: boolean): APICallError {
  return new APICallError({
    message: 'api',
    url: 'http://example.test',
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

describe('toErrorMessage', () => {
  test('Error 取 message，其它值 String()', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('plain')).toBe('plain');
    expect(toErrorMessage(404)).toBe('404');
  });
});

describe('isRetryableLlmError', () => {
  test('RetryError 整轮可重试', () => {
    expect(
      isRetryableLlmError(
        new RetryError({
          message: 'retries exceeded',
          reason: 'maxRetriesExceeded',
          errors: [new Error('x')],
        })
      )
    ).toBe(true);
  });

  test('APICallError：isRetryable 或 5xx 可重试', () => {
    expect(isRetryableLlmError(apiError(500))).toBe(true);
    expect(isRetryableLlmError(apiError(503, false))).toBe(true);
    expect(isRetryableLlmError(apiError(429, true))).toBe(true);
    expect(isRetryableLlmError(apiError(400, false))).toBe(false);
    expect(isRetryableLlmError(apiError(undefined, false))).toBe(false);
  });

  test('网络类 TypeError 可重试，代码型不可重试', () => {
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isRetryableLlmError(new TypeError('terminated', { cause: new Error('ECONNRESET') }))
    ).toBe(true);
    const withCode = new TypeError('request failed');
    (withCode as { cause?: unknown }).cause = Object.assign(new Error('boom'), {
      code: 'ECONNREFUSED',
    });
    expect(isRetryableLlmError(withCode)).toBe(true);
    expect(isRetryableLlmError(new TypeError('undefined is not a function'))).toBe(false);
    expect(isRetryableLlmError(new Error('random'))).toBe(false);
    expect(isRetryableLlmError('string')).toBe(false);
  });
});

describe('decideRunRetry', () => {
  const delays = [1000, 2000, 4000] as const;
  const retryable = new TypeError('fetch failed');
  const notRetryable = new TypeError('undefined is not a function');

  test('决策表：aborted 优先，其次 delays[attempt]，耗尽或不可重试则 fail', () => {
    const rows: Array<{
      name: string;
      aborted: boolean;
      attempt: number;
      error: unknown;
      expected: ReturnType<typeof decideRunRetry>;
    }> = [
      {
        name: 'abort 压过可重试错误',
        aborted: true,
        attempt: 0,
        error: retryable,
        expected: { action: 'aborted' },
      },
      {
        name: 'attempt 0 可重试 → delays[0]',
        aborted: false,
        attempt: 0,
        error: retryable,
        expected: { action: 'retry', delayMs: 1000 },
      },
      {
        name: 'attempt 1 可重试 → delays[1]',
        aborted: false,
        attempt: 1,
        error: retryable,
        expected: { action: 'retry', delayMs: 2000 },
      },
      {
        name: 'attempt 2 可重试 → delays[2]',
        aborted: false,
        attempt: 2,
        error: retryable,
        expected: { action: 'retry', delayMs: 4000 },
      },
      {
        name: 'attempt 3 耗尽',
        aborted: false,
        attempt: 3,
        error: retryable,
        expected: { action: 'fail' },
      },
      {
        name: '不可重试即使 attempt 未耗尽',
        aborted: false,
        attempt: 0,
        error: notRetryable,
        expected: { action: 'fail' },
      },
      {
        name: '空 delays 不可重试',
        aborted: false,
        attempt: 0,
        error: retryable,
        expected: { action: 'fail' },
      },
      {
        name: '5xx 可重试',
        aborted: false,
        attempt: 0,
        error: apiError(500),
        expected: { action: 'retry', delayMs: 1000 },
      },
    ];

    for (const row of rows) {
      const retryDelaysMs = row.name === '空 delays 不可重试' ? [] : delays;
      const actual = decideRunRetry({
        aborted: row.aborted,
        attempt: row.attempt,
        retryDelaysMs,
        error: row.error,
      });
      expect({ name: row.name, ...actual }).toEqual({ name: row.name, ...row.expected });
    }
  });
});
