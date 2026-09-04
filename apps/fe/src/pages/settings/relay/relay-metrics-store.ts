// 中继运行指标的宿主级单例 store：`GET /api/relay/metrics`。
//
// 与 `relay-status-store.ts` 同一套骨架（模块级 store + useSyncExternalStore + 轮询回路），
// 区别只在节奏：指标是 5 秒一拍的采样，页面隐藏时 `startPollingLoop` 会跳过这一拍。
//
// 拉失败不清空已有数据——面板宁可摆一份「已过期」的旧值，也不该在网络抖一下时整排闪成空白。

import { isAuthTransitionActive } from '@/auth/auth-transition';
import {
  type PollingTimingOptions,
  createPollingHandle,
  createStateStore,
  startPollingLoop,
} from '@/node/create-polling-store';
import type { ApiClient } from '@tmex/api-client/client';
import { RelayAdminApi, defaultRelayAdminApi } from '@tmex/api-client/relay/admin-api';
import type { RelayMetricsResponse } from '@tmex/api-client/relay/metrics-types';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { classifyRelayFailure } from './relay-status-store';

/** 采样间隔与服务端 `history.intervalMs` 对齐。 */
export const RELAY_METRICS_POLL_MS = 5_000;

/** 只取 `RelayAdminApi` 的 metrics 一支：测试注入假 client 时不必凑齐整套写操作。 */
export interface RelayMetricsApi {
  metrics(): Promise<RelayMetricsResponse>;
}

export function createRelayMetricsApi(client: ApiClient): RelayMetricsApi {
  return new RelayAdminApi(client);
}

export const defaultRelayMetricsApi: RelayMetricsApi = defaultRelayAdminApi;

export interface RelayMetricsState {
  data: RelayMetricsResponse | null;
  loading: boolean;
  /** 只装「拉失败」；404 / 401 走 `unavailable`，不当错误摆给用户。 */
  lastError: string | null;
  /** 本机没有 relay 角色，或会话已过期：调用方应整块隐藏。 */
  unavailable: boolean;
  loadedAt: number | null;
}

const EMPTY_STATE: RelayMetricsState = {
  data: null,
  loading: false,
  lastError: null,
  unavailable: false,
  loadedAt: null,
};

const store = createStateStore<RelayMetricsState>(EMPTY_STATE, () => {
  inFlight = null;
});

export const getRelayMetricsState = store.get;
export const subscribeRelayMetrics = store.subscribe;
export const setRelayMetricsStateForTest = store.set;
export const resetRelayMetricsStateForTest = store.reset;

function failurePatch(error: unknown): Partial<RelayMetricsState> {
  const kind = classifyRelayFailure(error);
  if (kind === 'error') {
    return { loading: false, lastError: error instanceof Error ? error.message : String(error) };
  }
  return { loading: false, lastError: null, unavailable: true, data: null };
}

let inFlight: Promise<void> | null = null;

/** 拉一次采样。并发调用共用同一次在途请求。 */
export async function refreshRelayMetrics(
  api: RelayMetricsApi = defaultRelayMetricsApi
): Promise<void> {
  if (isAuthTransitionActive()) return;
  if (inFlight) return inFlight;
  store.set({ loading: true });
  inFlight = (async () => {
    try {
      const data = await api.metrics();
      store.set({
        data,
        loading: false,
        lastError: null,
        unavailable: false,
        loadedAt: Date.now(),
      });
    } catch (error) {
      store.set(failurePatch(error));
    }
    inFlight = null;
  })();
  return inFlight;
}

export interface RelayMetricsPollingOptions extends PollingTimingOptions {
  api?: RelayMetricsApi;
  refresh?: (api: RelayMetricsApi) => void;
}

function startPolling(options: RelayMetricsPollingOptions): () => void {
  const api = options.api ?? defaultRelayMetricsApi;
  const refresh =
    options.refresh ?? ((target: RelayMetricsApi) => void refreshRelayMetrics(target));
  return startPollingLoop(options, {
    defaultIntervalMs: RELAY_METRICS_POLL_MS,
    defaultThrottleMs: 1_000,
    refresh: () => refresh(api),
  });
}

const acquirePolling = createPollingHandle(startPolling);

/** 取用宿主级**唯一**的回路，返回归还函数（幂等）。 */
export function acquireRelayMetricsPolling(options: RelayMetricsPollingOptions = {}): () => void {
  return acquirePolling(options);
}

export interface UseRelayMetricsOptions {
  api?: RelayMetricsApi;
  /** false 时只读状态、不参与轮询（同一页里多处摆指标时只让一处拥有回路）。 */
  enabled?: boolean;
  pollIntervalMs?: number;
}

export interface UseRelayMetricsResult extends RelayMetricsState {
  refresh: () => void;
}

export function useRelayMetrics(options: UseRelayMetricsOptions = {}): UseRelayMetricsResult {
  const api = options.api ?? defaultRelayMetricsApi;
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? RELAY_METRICS_POLL_MS;
  const snapshot = useSyncExternalStore(
    subscribeRelayMetrics,
    getRelayMetricsState,
    getRelayMetricsState
  );

  const refresh = useCallback(() => {
    void refreshRelayMetrics(api);
  }, [api]);

  useEffect(() => {
    if (!enabled) return;
    return acquireRelayMetricsPolling({ api, intervalMs: pollIntervalMs });
  }, [api, enabled, pollIntervalMs]);

  return { ...snapshot, refresh };
}
