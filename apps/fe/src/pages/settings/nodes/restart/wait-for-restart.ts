// 等待网关重启完成的唯一实现（向导、本机区块、HTTPS 区块共用）。
//
// `/api/setup/hub|join`、`/api/settings/restart` 返回后网关会退出，由 launchd / systemd 拉起新进程。
// 轮询期间「连不上」是正常态，不能当成失败；判定重启成功的唯一依据是 `/healthz.startedAt` 变了
// （进程换了）。提交前没读到 startedAt 时（老网关 / 读失败）退化为「先看到一次不可达，再看到一次健康」。
//
// 每次探活都带自己的 AbortSignal，超时预算取「离总截止还剩多久」：反代或隧道可以把 `/healthz`
// 挂住到天荒地老，只靠外层 60 秒截止是拦不住的。

import type { FetchLike } from '@tmex/api-client';
import { sleepOrAbort } from '@tmex/shared';

export type RestartOutcome = 'restarted' | 'timeout' | 'aborted';

export const RESTART_POLL_INTERVAL_MS = 1000;
export const RESTART_TIMEOUT_MS = 60_000;
export const HEALTH_READ_TIMEOUT_MS = 5000;

export interface HealthProbeResult {
  /** HTTP 层是否拿到 2xx；进程不在、请求被中断时为 false。 */
  ok: boolean;
  /** `/healthz.startedAt`；不可达或字段缺失为 null。 */
  startedAt: number | null;
}

export interface WaitForRestartOptions {
  /** 提交前读到的 startedAt；读不到传 null。 */
  previousStartedAt: number | null;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  intervalMs?: number;
  /** 外层取消（组件卸载）：立即中断在途请求并返回 `aborted`。 */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  onElapsed?: (elapsedMs: number) => void;
}

/** 探活：网络错误、非 2xx、被中断都不抛，交给调用方按状态机处理。 */
export async function probeHealth(
  fetchImpl: FetchLike,
  budgetMs: number,
  signal?: AbortSignal
): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(budgetMs, 0));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const res = await fetchImpl('/healthz', { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return { ok: false, startedAt: null };
    try {
      const body = (await res.json()) as { startedAt?: unknown };
      return { ok: true, startedAt: typeof body.startedAt === 'number' ? body.startedAt : null };
    } catch {
      // 回了 2xx 就说明进程活着，body 解析失败只是没有 startedAt 可用。
      return { ok: true, startedAt: null };
    }
  } catch {
    return { ok: false, startedAt: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** 读 `/healthz.startedAt`；不可达或字段缺失返回 null。重启提交前调用。 */
export async function readStartedAt(
  fetchImpl: FetchLike,
  budgetMs: number = HEALTH_READ_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<number | null> {
  return (await probeHealth(fetchImpl, budgetMs, signal)).startedAt;
}

/** 轮询 `/healthz` 直到进程换代、超时或被取消。 */
export async function waitForRestart(options: WaitForRestartOptions): Promise<RestartOutcome> {
  const {
    previousStartedAt,
    fetchImpl,
    timeoutMs = RESTART_TIMEOUT_MS,
    intervalMs = RESTART_POLL_INTERVAL_MS,
    signal,
    now = () => Date.now(),
    sleep = sleepOrAbort,
    onElapsed,
  } = options;

  const startedWaitingAt = now();
  const deadline = startedWaitingAt + timeoutMs;
  let sawDowntime = false;

  while (true) {
    if (signal?.aborted) return 'aborted';
    const remaining = deadline - now();
    if (remaining <= 0) return 'timeout';

    const health = await probeHealth(fetchImpl, remaining, signal);
    if (signal?.aborted) return 'aborted';

    if (!health.ok) {
      sawDowntime = true;
    } else if (previousStartedAt === null) {
      if (sawDowntime) return 'restarted';
    } else if (health.startedAt !== null && health.startedAt !== previousStartedAt) {
      return 'restarted';
    }

    onElapsed?.(now() - startedWaitingAt);
    if (now() + intervalMs > deadline) return 'timeout';
    await sleep(intervalMs, signal);
  }
}
