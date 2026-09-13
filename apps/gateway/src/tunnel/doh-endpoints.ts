/**
 * DoH JSON 端点一律用 IP 字面量：系统解析器坏掉时（如 VPN 残留的分流 DNS）域名形式的端点自己就解析不出来；
 * 境内可达的阿里 / DNSPod 在前，Cloudflare / Google 兜底。`VIBETERM_DOH_ENDPOINTS`（逗号分隔）整体覆盖。
 *
 * 查询采用 happy-eyeballs：端点依次间隔 `DOH_STAGGER_MS` 发出，首个成功应答胜出并中止其余。
 * 超时端点记入模块级记忆（`DOH_ENDPOINT_TIMEOUT_TTL_MS`），重试不再撞黑洞；HTTP 4xx 等非超时错误只跳过本次。
 */
import { errorMessage } from '@vibeterm/shared';
import { sleepOrAbort } from '@vibeterm/shared/async';

export const DOH_ENDPOINTS = [
  'https://223.5.5.5/resolve',
  'https://120.53.53.53/dns-query',
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/resolve',
] as const;
export const DOH_ENDPOINTS_ENV = 'VIBETERM_DOH_ENDPOINTS';
export const DOH_STAGGER_MS = 300;
export const DOH_ENDPOINT_TIMEOUT_TTL_MS = 60_000;
export const DOH_REQUEST_TIMEOUT_MS = 2_000;

const MAX_ERROR_LEN = 160;

export type DohFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DohRunState = { preferred: string | null; timedOut: Set<string> };

export type DohQueryCtx = {
  fetchImpl: DohFetch;
  signal: AbortSignal | undefined;
  deadline: number;
  now: () => number;
  state: DohRunState;
  requestTimeoutMs: number;
};

type DohAnswer = { type: number; data: string };
type ScopedSignal = { signal: AbortSignal; readonly timedOut: boolean; done: () => void };

class DohTimeoutError extends Error {}

const endpointTimeoutUntil = new Map<string, number>();

export function dohEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[DOH_ENDPOINTS_ENV]?.trim();
  if (!raw) return [...DOH_ENDPOINTS];
  const list = raw
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(isUsableDohEndpoint);
  if (list.length > 0) return list;
  console.warn(`[tunnel] ${DOH_ENDPOINTS_ENV} had no usable https endpoints, using defaults`);
  return [...DOH_ENDPOINTS];
}

export function newDohRunState(): DohRunState {
  return { preferred: null, timedOut: new Set() };
}

export function resetDohEndpointMemoryForTest(): void {
  endpointTimeoutUntil.clear();
}

export async function dohQueryAny(ctx: DohQueryCtx, name: string, type: number): Promise<string[]> {
  const race = new AbortController();
  const unlink = linkAbort(ctx.signal, race);
  const raced: DohQueryCtx = { ...ctx, signal: race.signal };
  let lastError: unknown = new Error('no DoH endpoint attempted');
  let winner: string[] | undefined;
  const take = (answers: string[], endpoint: string): void => {
    if (winner) return;
    winner = answers;
    ctx.state.preferred = endpoint;
    race.abort();
  };
  const attempts: Promise<void>[] = [];
  try {
    const endpoints = endpointOrder(ctx.state, ctx.now());
    for (const endpoint of endpoints) {
      if (winner || race.signal.aborted) break;
      const attempt = raceOneDohEndpoint({
        ctx: raced,
        endpoint,
        name,
        type,
        take,
        fail: (error) => {
          lastError = error;
        },
      });
      attempts.push(attempt);
      if (winner || race.signal.aborted) break;
      await Promise.race([attempt, sleepOrAbort(DOH_STAGGER_MS, race.signal)]);
    }
    await Promise.all(attempts);
  } finally {
    unlink();
  }
  if (winner) return winner;
  throw new Error(`${name}/${type}: ${shortDohError(lastError)}`);
}

function isUsableDohEndpoint(item: string): boolean {
  try {
    const url = new URL(item);
    return url.protocol === 'https:' && Boolean(url.hostname) && url.pathname !== '/';
  } catch {
    return false;
  }
}

function endpointOrder(state: DohRunState, nowMs: number): string[] {
  const all = dohEndpoints();
  const usable = all.filter(
    (endpoint) => !state.timedOut.has(endpoint) && !isRememberedTimeout(endpoint, nowMs)
  );
  const list = usable.length > 0 ? usable : all;
  const preferred = state.preferred;
  if (!preferred || !list.includes(preferred)) return list;
  return [preferred, ...list.filter((endpoint) => endpoint !== preferred)];
}

function isRememberedTimeout(endpoint: string, nowMs: number): boolean {
  const until = endpointTimeoutUntil.get(endpoint);
  if (until === undefined) return false;
  if (until <= nowMs) {
    endpointTimeoutUntil.delete(endpoint);
    return false;
  }
  return true;
}

function noteDohEndpointFailure(ctx: DohQueryCtx, endpoint: string, error: unknown): void {
  if (!(error instanceof DohTimeoutError)) return;
  ctx.state.timedOut.add(endpoint);
  endpointTimeoutUntil.set(endpoint, ctx.now() + DOH_ENDPOINT_TIMEOUT_TTL_MS);
}

function linkAbort(outer: AbortSignal | undefined, inner: AbortController): () => void {
  if (!outer) return () => undefined;
  const onAbort = (): void => inner.abort(outer.reason);
  if (outer.aborted) {
    inner.abort(outer.reason);
    return () => undefined;
  }
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

function requestSignal(outer: AbortSignal | undefined, ms: number): ScopedSignal {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error(`timed out after ${ms}ms`));
  }, ms);
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut(): boolean {
      return state.timedOut;
    },
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

function parseDohAnswers(body: unknown, type: number): string[] {
  if (!body || typeof body !== 'object') return [];
  const rec = body as { Status?: unknown; Answer?: unknown };
  if (typeof rec.Status === 'number' && rec.Status !== 0) {
    throw new Error(`DoH status ${rec.Status}`);
  }
  if (!Array.isArray(rec.Answer)) return [];
  const out: string[] = [];
  for (const item of rec.Answer as DohAnswer[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== type || typeof item.data !== 'string') continue;
    out.push(item.data);
  }
  return out;
}

type DohRaceAttempt = {
  ctx: DohQueryCtx;
  endpoint: string;
  name: string;
  type: number;
  take: (answers: string[], endpoint: string) => void;
  fail: (error: unknown) => void;
};

async function raceOneDohEndpoint(attempt: DohRaceAttempt): Promise<void> {
  if (attempt.ctx.signal?.aborted) return;
  if (attempt.ctx.deadline - attempt.ctx.now() <= 0) return;
  try {
    const answers = await dohQuery(attempt.ctx, attempt.endpoint, attempt.name, attempt.type);
    attempt.take(answers, attempt.endpoint);
  } catch (error) {
    attempt.fail(error);
    noteDohEndpointFailure(attempt.ctx, attempt.endpoint, error);
  }
}

async function dohQuery(
  ctx: DohQueryCtx,
  endpoint: string,
  name: string,
  type: number
): Promise<string[]> {
  const budget = ctx.deadline - ctx.now();
  const timeout = Math.max(1, Math.min(ctx.requestTimeoutMs, budget));
  const scoped = requestSignal(ctx.signal, timeout);
  try {
    const url = new URL(endpoint);
    url.searchParams.set('name', name);
    url.searchParams.set('type', String(type));
    const res = await ctx.fetchImpl(url.toString(), {
      headers: { accept: 'application/dns-json' },
      signal: scoped.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDohAnswers(await res.json(), type);
  } catch (error) {
    if (scoped.timedOut) throw new DohTimeoutError(`timed out after ${timeout}ms`);
    throw error;
  } finally {
    scoped.done();
  }
}

function shortDohError(error: unknown): string {
  const trimmed = errorMessage(error).trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_ERROR_LEN ? `${trimmed.slice(0, MAX_ERROR_LEN)}…` : trimmed;
}
