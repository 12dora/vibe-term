// 中继（relay）链路视图：`GET /api/mesh/relay/status` 的宿主级单例 store。
//
// 与 `mesh-hubs.ts` 同一套做法（模块级 store + useSyncExternalStore + 30 秒兜底轮询）：
// 这份数据是**入口级**的（永远打本机自己），放进某个 node 的 QueryClient 会在切 node 时重复拉取。
//
// 中继链路同样没有专属事件流：hub / 中继本身也是节点，它上下线时 `/mesh/ws` 会推 NODE_EVENT，
// 据此立刻补一次；旧节点没有这条路由（404），此时恒为「非中继模式」，页面退化成原来的 hub 版式。

import { isAuthTransitionActive } from '@/auth/auth-transition';
import type {
  RelayLinkStatus,
  RelayTenantApi,
  RelayTenantStatus,
  RelayUplinkMode,
} from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi, isRelayRoutesMissing } from '@tmex/api-client/relay/tenant-api';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  type PollingTimingOptions,
  createPollingHandle,
  createStateStore,
  startPollingLoop,
} from './create-polling-store';
import { sharedMeshEvents } from './mesh-events';
import type { MeshEventSubscriber } from './mesh-nodes';

/** 与 hub 集合同一档：中继链路没有专属事件流，30 秒一拍。 */
export const MESH_RELAY_POLL_MS = 30_000;

/** 事件触发的补拉节流窗口：一串节点上下线事件最多换来一次 REST。 */
export const MESH_RELAY_REFRESH_THROTTLE_MS = 2_000;

export interface MeshRelayState extends RelayTenantStatus {
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  /** 节点没有这族路由（版本太老）：整套中继 UI 不出现，也不报错。 */
  unsupported: boolean;
}

const EMPTY_STATE: MeshRelayState = {
  mode: 'none',
  quota: null,
  tenantId: null,
  relays: [],
  metaEpoch: 0,
  nodesViaRelay: 0,
  reauthRequired: false,
  readmitPending: 0,
  loading: false,
  error: null,
  loadedAt: null,
  unsupported: false,
};

const store = createStateStore<MeshRelayState>(EMPTY_STATE, () => {
  inFlight = null;
});

export const getMeshRelayState = store.get;
export const subscribeMeshRelay = store.subscribe;

/** 仅测试使用：直接注入一份状态。 */
export const setMeshRelayStateForTest = store.set;

export const resetMeshRelayStateForTest = store.reset;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export function isRelayMode(snapshot: MeshRelayState): boolean {
  return snapshot.mode === 'relay';
}

/**
 * 当场问网关本机走的是不是中继，**不读这份 30 秒轮询的快照**。
 *
 * 「要不要紧跟一条 `meta-key`」这种判定不能吃陈旧值：刚接入中继就吊销一台节点时，
 * 快照还停在 `hub`，整条换代会被静默跳过。路由不存在（旧版本）或问不到一律当作不是。
 */
export async function fetchRelayMode(
  api: RelayTenantApi = defaultRelayTenantApi
): Promise<boolean> {
  try {
    return (await api.status()).mode === 'relay';
  } catch {
    return false;
  }
}

/** 本机 uplink 当前挂着的那条中继；没挂上时为 `null`。 */
export function attachedRelay(snapshot: MeshRelayState): RelayLinkStatus | null {
  return snapshot.relays.find((row) => row.attached) ?? null;
}

/**
 * 中继模式下管理写入是否可用。
 *
 * 密钥日志记录要经 uplink 送到中继才算数（`POST /api/auth/keylog?hub=sync`），一条中继都没
 * 挂上时提交必然超时，不如先禁掉。**只在确凿为中继模式时判**：mode 未知一律按可用处理。
 */
export function relayWritable(snapshot: MeshRelayState): boolean {
  if (!isRelayMode(snapshot)) return true;
  return attachedRelay(snapshot) !== null;
}

/** 令牌被作废（改密踢人 / 运营者手动踢）：需要重新输入中继口令。 */
export function relayKicked(snapshot: MeshRelayState): boolean {
  return snapshot.reauthRequired || snapshot.relays.some((row) => row.kicked === true);
}

/** 按 priority 升序（即 failover 顺序）排一份；同优先级按地址稳定排序。 */
export function orderedRelays(snapshot: MeshRelayState): RelayLinkStatus[] {
  return [...snapshot.relays].sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url));
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

let inFlight: Promise<void> | null = null;

export async function refreshMeshRelay(api: RelayTenantApi = defaultRelayTenantApi): Promise<void> {
  // 退出 mesh 期间本机会话已被清空，再拉 `/api/mesh/*` 只会稳定拿 401。
  if (isAuthTransitionActive()) return;
  if (inFlight) return inFlight;
  store.set({ loading: true });
  inFlight = (async () => {
    try {
      const status = await api.status();
      store.set({
        ...status,
        loading: false,
        error: null,
        unsupported: false,
        loadedAt: Date.now(),
      });
    } catch (err) {
      // 路由不存在不是错误：把它记成「本版本没有中继」，UI 一行提示都不出。
      if (isRelayRoutesMissing(err)) {
        store.set({ ...EMPTY_STATE, unsupported: true, loadedAt: Date.now() });
        return;
      }
      // 失败保留上一份链路：一次网络抖动不该把已经展示出来的中继列表抹掉。
      store.set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * 切到另一条已配置的中继（make-before-break）。
 *
 * `POST /switch` 直接回一份新状态，就地落进 store：等 30 秒轮询那一拍，界面在切完之后
 * 还会指着旧的那条。失败原样抛出，由调用方查错误表。
 */
export async function switchMeshRelay(
  url: string,
  api: RelayTenantApi = defaultRelayTenantApi
): Promise<void> {
  const status = await api.switchRelay(url);
  store.set({ ...status, loading: false, error: null, unsupported: false, loadedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// 轮询回路
// ---------------------------------------------------------------------------

export interface MeshRelayPollingOptions extends PollingTimingOptions {
  api?: RelayTenantApi;
  events?: MeshEventSubscriber;
  refresh?: (api: RelayTenantApi) => void;
}

function startPolling(options: MeshRelayPollingOptions): () => void {
  const api = options.api ?? defaultRelayTenantApi;
  const refresh = options.refresh ?? ((target: RelayTenantApi) => void refreshMeshRelay(target));
  const events = options.events ?? sharedMeshEvents();

  return startPollingLoop(options, {
    defaultIntervalMs: MESH_RELAY_POLL_MS,
    defaultThrottleMs: MESH_RELAY_REFRESH_THROTTLE_MS,
    refresh: () => refresh(api),
    wire: ({ requestRefresh }) => {
      const stopStatus = events.onStatusChange(() => {
        if (events.connected) requestRefresh();
      });
      // 节点上下线会改「经中继可见的节点数」，也常常与 uplink 切换同时发生。
      const stopEvents = events.onNodeEvent(() => requestRefresh());
      return () => {
        stopStatus();
        stopEvents();
      };
    },
  });
}

const acquirePolling = createPollingHandle(startPolling);

/** 取用宿主级**唯一**的回路，返回归还函数（幂等）。 */
export function acquireMeshRelayPolling(options: MeshRelayPollingOptions = {}): () => void {
  return acquirePolling(options);
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface UseMeshRelayOptions {
  /** standalone 下必须传 false：不发任何 `/api/mesh/*` 请求。 */
  enabled?: boolean;
  api?: RelayTenantApi;
  events?: MeshEventSubscriber;
  /** 轮询的所有者；只有节点管理页传 true，其余消费方只订阅同一份 store。 */
  owner?: boolean;
  pollIntervalMs?: number;
}

export interface UseMeshRelayResult extends MeshRelayState {
  mode: RelayUplinkMode;
  /** 本机走中继。 */
  relayMode: boolean;
  attached: RelayLinkStatus | null;
  /** 按 failover 顺序排好的中继列表。 */
  ordered: RelayLinkStatus[];
  /** 管理写入当前可用（非中继模式恒为 true）。 */
  writable: boolean;
  kicked: boolean;
  refresh: () => void;
  /** 切到另一条已配置的中继；失败原样抛出。 */
  switchRelay: (url: string) => Promise<void>;
}

export function useMeshRelay(options: UseMeshRelayOptions = {}): UseMeshRelayResult {
  const enabled = options.enabled ?? true;
  const owner = options.owner ?? false;
  const api = options.api ?? defaultRelayTenantApi;
  const pollIntervalMs = options.pollIntervalMs ?? MESH_RELAY_POLL_MS;
  const events = options.events;
  const snapshot = useSyncExternalStore(subscribeMeshRelay, getMeshRelayState, getMeshRelayState);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void refreshMeshRelay(api);
  }, [api, enabled]);

  const switchRelay = useCallback((url: string) => switchMeshRelay(url, api), [api]);

  const polls = enabled && owner;
  useEffect(() => {
    if (!polls) return;
    return acquireMeshRelayPolling({ api, intervalMs: pollIntervalMs, events });
  }, [api, polls, pollIntervalMs, events]);

  const unknown = enabled && !owner && snapshot.loadedAt === null && snapshot.error === null;
  useEffect(() => {
    if (unknown) void refreshMeshRelay(api);
  }, [api, unknown]);

  return {
    ...snapshot,
    relayMode: isRelayMode(snapshot),
    attached: attachedRelay(snapshot),
    ordered: orderedRelays(snapshot),
    writable: relayWritable(snapshot),
    kicked: relayKicked(snapshot),
    refresh,
    switchRelay,
  };
}
