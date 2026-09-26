// 对一组节点做有界并发调用，把离线 / 过旧 / 未登录收成结果行，不让单台中断其余节点。

import { MIN_LOGIN_RECORDS_VERSION } from '@vibeterm/shared';
import type { AuthCallFailure, AuthSkip, AuthTarget } from './auth-nodes';
import { AuthError, NetworkError, NotFoundError, errorText, hintOf } from './errors';
import { mapBounded } from './login-fanout';

const FANOUT_CONCURRENCY = 4;

export interface AuthFanout<T> {
  values: Array<{ target: AuthTarget; value: T }>;
  skipped: AuthSkip[];
  failures: AuthCallFailure[];
}

function runtimeSkip(target: AuthTarget, error: unknown): AuthSkip | null {
  if (error instanceof NetworkError) {
    return { ...target, reason: 'unreachable', detail: 'unreachable' };
  }
  if (error instanceof NotFoundError) {
    return {
      ...target,
      reason: 'missing',
      detail: `needs upgrade to ${MIN_LOGIN_RECORDS_VERSION}`,
    };
  }
  return null;
}

function runtimeFailure(target: AuthTarget, error: unknown): AuthCallFailure {
  return {
    ...target,
    kind: error instanceof AuthError ? 'auth' : 'error',
    message: errorText(error),
    hint: hintOf(error),
  };
}

export async function callAuthNodes<T>(input: {
  targets: readonly AuthTarget[];
  call: (target: AuthTarget) => Promise<T>;
}): Promise<AuthFanout<T>> {
  const settled = await mapBounded(input.targets, FANOUT_CONCURRENCY, async (target) => {
    try {
      return { ok: true as const, target, value: await input.call(target) };
    } catch (error) {
      return { ok: false as const, target, error };
    }
  });
  const values: AuthFanout<T>['values'] = [];
  const skipped: AuthSkip[] = [];
  const failures: AuthCallFailure[] = [];
  for (const row of settled) {
    if (row.ok) {
      values.push({ target: row.target, value: row.value });
      continue;
    }
    const skip = runtimeSkip(row.target, row.error);
    if (skip) skipped.push(skip);
    else failures.push(runtimeFailure(row.target, row.error));
  }
  return { values, skipped, failures };
}
