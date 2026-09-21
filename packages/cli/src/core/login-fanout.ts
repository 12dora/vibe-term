// `vibeterm login` 的 fan-out 辅助：有界并发、per-node 超时常量、网络类失败分类、TOTP 重试收敛。
// worker 永不抛：非登录码错误收成结果行，避免 Promise.all 提前拒绝导致会话私钥被清零。

import {
  type AuthMode,
  LOGIN_TIMEOUT,
  TOTP_KEY_UNAVAILABLE,
  loginFailure,
  unexpectedLoginCode,
} from './auth';
import type { CliContext } from './context';
import { EXIT_AUTH, EXIT_NETWORK, NetworkError, UsageError, exitCodeOf } from './errors';

/** 单个 node 整次登录（challenge + login）的墙上时钟缺省；可用 `--node-timeout` 覆盖。 */
export const DEFAULT_NODE_TIMEOUT_MS = 25_000;

/** entry 之外同时登录的并发上限缺省；可用 `--concurrency` 覆盖。 */
export const DEFAULT_LOGIN_CONCURRENCY = 4;

export interface LoginTarget {
  nodeId: string;
  name: string;
  publicKey: string | null;
}

export interface TargetOutcome {
  node: string;
  name: string;
  ok: boolean;
  code?: string;
  nodePk?: string;
}

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

function caughtOutcome(target: LoginTarget, error: unknown): TargetOutcome {
  return {
    node: target.nodeId,
    name: target.name,
    ok: false,
    code: unexpectedLoginCode(error),
  };
}

/** 单个 fan-out 目标：异常一律收成 outcome，调用方的 Promise.all 不会提前拒绝。 */
export async function runFanoutTarget(args: {
  out: LoginProgressOut;
  target: LoginTarget;
  attempt: () => Promise<TargetOutcome>;
  emitDone: boolean | ((outcome: TargetOutcome) => boolean);
}): Promise<TargetOutcome> {
  emitLoginStart(args.out, args.target.name);
  let outcome: TargetOutcome;
  try {
    outcome = await args.attempt();
  } catch (error) {
    outcome = caughtOutcome(args.target, error);
  }
  const shouldEmit = typeof args.emitDone === 'function' ? args.emitDone(outcome) : args.emitDone;
  if (shouldEmit) emitLoginDone(args.out, args.target.name, outcome);
  return outcome;
}

function applyTotpUnavailable(
  outcomes: TargetOutcome[],
  retryAt: readonly number[]
): TargetOutcome[] {
  const next = outcomes.slice();
  for (const index of retryAt) {
    next[index] = { ...next[index], code: TOTP_KEY_UNAVAILABLE };
  }
  return next;
}

function emitTotpPendingDone(
  ctx: CliContext,
  targets: readonly LoginTarget[],
  outcomes: readonly TargetOutcome[],
  retryAt: readonly number[]
): void {
  for (const index of retryAt) emitLoginDone(ctx.out, targets[index].name, outcomes[index]);
}

async function retryTotpTargets(args: {
  ctx: CliContext;
  targets: readonly LoginTarget[];
  first: TargetOutcome[];
  attempt: (target: LoginTarget) => Promise<TargetOutcome>;
  concurrency: number;
  retryAt: readonly number[];
}): Promise<TargetOutcome[]> {
  const retried = await mapBounded(args.retryAt, args.concurrency, (index) => {
    const target = args.targets[index];
    return runFanoutTarget({
      out: args.ctx.out,
      target,
      attempt: () => args.attempt(target),
      emitDone: true,
    });
  });
  const next = args.first.slice();
  args.retryAt.forEach((index, i) => {
    next[index] = retried[i];
  });
  return next;
}

async function finishFanout(args: {
  ctx: CliContext;
  targets: readonly LoginTarget[];
  first: TargetOutcome[];
  totp: { code: string | null };
  hasTotpKey: boolean;
  interactive: boolean;
  promptTotp: () => Promise<string>;
  attempt: (target: LoginTarget) => Promise<TargetOutcome>;
  concurrency: number;
}): Promise<TargetOutcome[]> {
  const retryAt = totpRetryIndices(args.first);
  if (retryAt.length === 0) return args.first;
  if (args.totp.code) {
    emitTotpPendingDone(args.ctx, args.targets, args.first, retryAt);
    return args.first;
  }
  const status = await takeTotpForRetry({
    totp: args.totp,
    hasTotpKey: args.hasTotpKey,
    interactive: args.interactive,
    prompt: args.promptTotp,
  });
  if (status === 'ready') return retryTotpTargets({ ...args, retryAt });
  const finalized =
    status === 'unavailable' ? applyTotpUnavailable(args.first, retryAt) : args.first;
  emitTotpPendingDone(args.ctx, args.targets, finalized, retryAt);
  return finalized;
}

export async function loginOthers(args: {
  ctx: CliContext;
  targets: readonly LoginTarget[];
  totp: { code: string | null };
  hasTotpKey: boolean;
  interactive: boolean;
  promptTotp: () => Promise<string>;
  concurrency: number;
  attempt: (target: LoginTarget) => Promise<TargetOutcome>;
}): Promise<TargetOutcome[]> {
  if (args.targets.length === 0) return [];
  const first = await mapBounded(args.targets, args.concurrency, (target) =>
    runFanoutTarget({
      out: args.ctx.out,
      target,
      attempt: () => args.attempt(target),
      emitDone: (outcome) => outcome.ok || outcome.code !== 'TOTP_REQUIRED',
    })
  );
  return finishFanout({ ...args, first });
}

export function reportLoginOutcomes(ctx: CliContext, outcomes: TargetOutcome[]): void {
  if (ctx.globals.json) {
    ctx.out.data({ entry: ctx.globals.entry, nodes: outcomes });
    return;
  }
  ctx.out.table(outcomes, [
    { header: 'NODE', value: (row) => row.node },
    { header: 'NAME', value: (row) => row.name },
    { header: 'STATUS', value: (row) => (row.ok ? 'ok' : (row.code ?? 'failed')) },
  ]);
}

export function throwIfSelfFailed(
  outcome: TargetOutcome,
  policy: AuthMode['secondFactorPolicy']
): void {
  if (outcome.ok) return;
  if (outcome.code === 'NODE_UNREACHABLE') {
    throw new NetworkError('login to node self failed: NODE_UNREACHABLE');
  }
  throw loginFailure('self', outcome.code ?? 'UNKNOWN', policy);
}

function emitNetworkSkipSummary(ctx: CliContext, outcomes: TargetOutcome[]): void {
  const network = outcomes.filter((row) => !row.ok && isNetworkLoginCode(row.code));
  if (network.length === 0) return;
  const okCount = outcomes.filter((row) => row.ok).length;
  const unreachable = network.filter((row) => row.code === 'NODE_UNREACHABLE').length;
  const timedOut = network.filter((row) => row.code === LOGIN_TIMEOUT).length;
  ctx.out.info(formatNetworkSkipSummary(okCount, unreachable, timedOut));
}

/** 全是鉴权拒绝 → 3；夹杂 HTTP_5xx 等非鉴权码 → 1。 */
export function reportRejected(ctx: CliContext, mode: AuthMode, rejected: TargetOutcome[]): number {
  let authOnly = true;
  for (const outcome of rejected) {
    const error = loginFailure(outcome.node, outcome.code ?? 'UNKNOWN', mode.secondFactorPolicy);
    ctx.out.warn(`node ${outcome.node} (${outcome.name}): ${error.message}`);
    if (error.hint) ctx.out.warn(`  ${error.hint}`);
    if (exitCodeOf(error) !== EXIT_AUTH) authOnly = false;
  }
  return authOnly ? EXIT_AUTH : 1;
}

export function reportLoginFailures(
  ctx: CliContext,
  mode: AuthMode,
  outcomes: TargetOutcome[],
  explicitTarget: boolean
): number {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const network = failed.filter((outcome) => isNetworkLoginCode(outcome.code));
  const rejected = failed.filter((outcome) => !isNetworkLoginCode(outcome.code));
  // `--node` 时进度行已经打过 skipped / timeout，这里只决定退出码，不再重复 warn。
  if (explicitTarget && network.length > 0) return EXIT_NETWORK;
  if (rejected.length === 0) {
    emitNetworkSkipSummary(ctx, outcomes);
    return 0;
  }
  return reportRejected(ctx, mode, rejected);
}
