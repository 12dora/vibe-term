// 中继运营面的宿主级单例 store：`GET /api/relay/status` + `GET /api/relay/health`。
//
// 与 `mesh-hubs.ts` 同一套做法（模块级 store + useSyncExternalStore + 30 秒兜底轮询）。
// 中继没有事件流，只能定时拉；隐藏的页面跳拍由 `startPollingLoop` 统一处理。
//
// 这份状态还兼着**标签入口的门禁**：`relay` 角色缺席时整族路由都不存在，status 回 404，
// 于是 `availability` 落到 `unavailable`，设置页据此不渲染「中继」标签（见 SettingsPage）。

import { isAuthTransitionActive } from '@/auth/auth-transition';
import {
  type PollingTimingOptions,
  createPollingHandle,
  createStateStore,
  startPollingLoop,
} from '@/node/create-polling-store';
import {
  type RelayAdminApi,
  type RelayHealthResponse,
  type RelayStatusResponse,
  defaultRelayAdminApi,
  isRelayNotEnabled,
  isRelayUnauthorized,
} from '@tmex/api-client/relay/admin-api';
import { errorMessage } from '@tmex/shared';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/** 中继状态与 hub 管理面同一档：30 秒一拍。 */
export const RELAY_ADMIN_POLL_MS = 30_000;

/**
 * `unknown` 只在首次探测落地前出现；`unavailable` 是**确凿的** 404（本机没有 relay 角色）；
 * `unauthorized` 是 401（未登录），下次挂载会重探一次。
 */
export type RelayAvailability = 'unknown' | 'available' | 'unavailable' | 'unauthorized';

export interface RelayAdminState {
  availability: RelayAvailability;
  status: RelayStatusResponse | null;
  health: RelayHealthResponse | null;
  loading: boolean;
  /** 只装「拉失败」；404 / 401 走 `availability`，不算错误。 */
  error: string | null;
  loadedAt: number | null;
}

const EMPTY_STATE: RelayAdminState = {
  availability: 'unknown',
  status: null,
  health: null,
  loading: false,
  error: null,
  loadedAt: null,
};

const store = createStateStore<RelayAdminState>(EMPTY_STATE, () => {
  inFlight = null;
});

export const getRelayAdminState = store.get;
export const subscribeRelayAdmin = store.subscribe;
export const setRelayAdminStateForTest = store.set;
export const resetRelayAdminStateForTest = store.reset;

/** 失败归类：404 = 角色缺席，401 = 未登录，其余都是真错误。 */
export function classifyRelayFailure(error: unknown): 'unavailable' | 'unauthorized' | 'error' {
  if (isRelayNotEnabled(error)) return 'unavailable';
  if (isRelayUnauthorized(error)) return 'unauthorized';
  return 'error';
}

function failurePatch(error: unknown): Partial<RelayAdminState> {
  switch (classifyRelayFailure(error)) {
    case 'unavailable':
      // 角色确实不在：把上一份数据一并清掉，别让隐藏的标签还留着旧租户表。
      return {
        availability: 'unavailable',
        status: null,
        health: null,
        loading: false,
        error: null,
      };
    case 'unauthorized':
      return { availability: 'unauthorized', loading: false, error: null };
    default:
      // 网络抖动不该抹掉已经摆出来的租户表，只记错误。
      return { loading: false, error: errorMessage(error) };
  }
}

let inFlight: Promise<void> | null = null;

/** 拉一次状态；health 是尽力而为（拿不到就留上一份），status 决定 `availability`。 */
export async function refreshRelayAdmin(api: RelayAdminApi = defaultRelayAdminApi): Promise<void> {
  // 退出 mesh 期间本机会话已被清空，再拉只会稳定拿 401。
  if (isAuthTransitionActive()) return;
  if (inFlight) return inFlight;
  store.set({ loading: true });
  inFlight = (async () => {
    const [status, health] = await Promise.allSettled([api.status(), api.health()]);
    if (status.status === 'rejected') {
      store.set(failurePatch(status.reason));
    } else {
      store.set({
        availability: 'available',
        status: status.value,
        health: health.status === 'fulfilled' ? health.value : store.get().health,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      });
    }
    inFlight = null;
  })();
  return inFlight;
}

/** 门禁探测：只在结论还没落地（或上次是 401）时打一次。 */
export function probeRelayAdmin(api: RelayAdminApi = defaultRelayAdminApi): void {
  const { availability } = store.get();
  if (availability === 'available' || availability === 'unavailable') return;
  void refreshRelayAdmin(api);
}

export interface RelayAdminPollingOptions extends PollingTimingOptions {
  api?: RelayAdminApi;
  refresh?: (api: RelayAdminApi) => void;
}

function startPolling(options: RelayAdminPollingOptions): () => void {
  const api = options.api ?? defaultRelayAdminApi;
  const refresh = options.refresh ?? ((target: RelayAdminApi) => void refreshRelayAdmin(target));
  return startPollingLoop(options, {
    defaultIntervalMs: RELAY_ADMIN_POLL_MS,
    defaultThrottleMs: 2_000,
    refresh: () => refresh(api),
  });
}

const acquirePolling = createPollingHandle(startPolling);

/** 取用宿主级**唯一**的回路，返回归还函数（幂等）。 */
export function acquireRelayAdminPolling(options: RelayAdminPollingOptions = {}): () => void {
  return acquirePolling(options);
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface UseRelayAdminOptions {
  api?: RelayAdminApi;
  /** 只有「中继」标签本体传 true：由它拥有 30 秒轮询。 */
  owner?: boolean;
  pollIntervalMs?: number;
}

export interface UseRelayAdminResult extends RelayAdminState {
  refresh: () => void;
}

export function useRelayAdmin(options: UseRelayAdminOptions = {}): UseRelayAdminResult {
  const api = options.api ?? defaultRelayAdminApi;
  const owner = options.owner ?? false;
  const pollIntervalMs = options.pollIntervalMs ?? RELAY_ADMIN_POLL_MS;
  const snapshot = useSyncExternalStore(
    subscribeRelayAdmin,
    getRelayAdminState,
    getRelayAdminState
  );

  const refresh = useCallback(() => {
    void refreshRelayAdmin(api);
  }, [api]);

  useEffect(() => {
    if (!owner) return;
    return acquireRelayAdminPolling({ api, intervalMs: pollIntervalMs });
  }, [api, owner, pollIntervalMs]);

  return { ...snapshot, refresh };
}

/**
 * 标签门禁：进设置页探一次 `/api/relay/status`，404 就再也不问（结论对本次会话有效）。
 * 401 会在下次挂载重探——用户可能刚登录完。
 */
export function useRelayAvailability(api: RelayAdminApi = defaultRelayAdminApi): RelayAvailability {
  const snapshot = useSyncExternalStore(
    subscribeRelayAdmin,
    getRelayAdminState,
    getRelayAdminState
  );
  useEffect(() => {
    probeRelayAdmin(api);
  }, [api]);
  return snapshot.availability;
}
