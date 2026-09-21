// `vibeterm login` 的 fan-out 辅助：有界并发、per-node 超时常量、网络类失败分类、TOTP 重试收敛。

import { LOGIN_TIMEOUT } from './auth';
import { UsageError } from './errors';

/** 单个 node 整次登录（challenge + login）的墙上时钟缺省；可用 `--node-timeout` 覆盖。 */
export const DEFAULT_NODE_TIMEOUT_MS = 25_000;

/** entry 之外同时登录的并发上限缺省；可用 `--concurrency` 覆盖。 */
export const DEFAULT_LOGIN_CONCURRENCY = 4;

export function isNetworkLoginCode(code: string | undefined): boolean {
  return code === 'NODE_UNREACHABLE' || code === LOGIN_TIMEOUT;
}

export function networkSkipLabel(code: string | undefined): string {
  return code === LOGIN_TIMEOUT ? 'timeout' : 'unreachable';
}

export function formatNetworkSkipSummary(
  okCount: number,
  unreachable: number,
  timedOut: number
): string {
  const noun = okCount === 1 ? 'node' : 'nodes';
  const skips: string[] = [];
  if (unreachable > 0) skips.push(`${unreachable} unreachable`);
  if (timedOut > 0) skips.push(`${timedOut} timeout`);
  return `logged in to ${okCount} ${noun}, skipped ${skips.join(', ')}`;
}

export function requirePositiveInt(
  flag: string,
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${flag} must be a positive integer, got ${value}`);
  }
  return value;
}

/** 保序的有界并发：结果下标与输入一致，不因完成先后乱序。 */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  const width = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: width }, () => run()));
  return results;
}

export interface LoginProgressOut {
  warn(text: string): void;
}

export function emitLoginStart(out: LoginProgressOut, name: string): void {
  out.warn(`logging in to ${name} ...`);
}

export function emitLoginDone(
  out: LoginProgressOut,
  name: string,
  outcome: { ok: boolean; code?: string }
): void {
  if (outcome.ok) {
    out.warn(`logged in to ${name}: ok`);
    return;
  }
  if (isNetworkLoginCode(outcome.code)) {
    out.warn(`skipped ${name}: ${networkSkipLabel(outcome.code)}`);
    return;
  }
  out.warn(`login to ${name} failed: ${outcome.code ?? 'failed'}`);
}

export function totpRetryIndices(outcomes: readonly { ok: boolean; code?: string }[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    if (!outcomes[index].ok && outcomes[index].code === 'TOTP_REQUIRED') indices.push(index);
  }
  return indices;
}

export type TotpRetryStatus = 'ready' | 'unavailable' | 'missing';

/** 并发路径上 TOTP 交互只在这里发生一次：有码就复用，没有才 prompt。 */
export async function takeTotpForRetry(args: {
  totp: { code: string | null };
  hasTotpKey: boolean;
  interactive: boolean;
  prompt: () => Promise<string>;
}): Promise<TotpRetryStatus> {
  if (args.totp.code) return 'ready';
  if (!args.hasTotpKey) return 'unavailable';
  if (!args.interactive) return 'missing';
  const code = (await args.prompt()).trim();
  if (!code) return 'missing';
  args.totp.code = code;
  return 'ready';
}
