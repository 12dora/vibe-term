// hub 集合视图：`GET /api/mesh/hubs` 的宿主级单例 store。
//
// 与 `mesh-nodes.ts` 同一套做法（模块级 store + useSyncExternalStore）：这份数据是**入口级**的
// （永远打 entry 自身），放进某个 node 的 QueryClient 会在切 node 时重复拉取。
//
// hub 集合没有自己的事件流，兜底轮询 30 秒一拍；hub 机本身也是 node，它上下线时
// `/mesh/ws` 会推 NODE_EVENT，据此立刻补一次，不必等下一拍。

import { isAuthTransitionActive } from '@/auth/auth-transition';
import type {
  AuthApi,
  MeshAttachedHub,
  MeshHubEndpoint,
  MeshHubsResponse,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  type PollingTimingOptions,
  createPollingHandle,
  createStateStore,
  startPollingLoop,
} from './create-polling-store';
import { sharedMeshEvents } from './mesh-events';
import type { MeshEventSubscriber } from './mesh-nodes';

/** hub 集合的轮询间隔：它没有专属事件流，与 hub 管理面保持同一档 30 秒。 */
export const MESH_HUBS_POLL_MS = 30_000;

/** 事件触发的补拉节流窗口：一串 hub 上下线事件最多换来一次 REST。 */
export const MESH_HUBS_REFRESH_THROTTLE_MS = 2_000;

/** uplink 的一个候选地址与它最近一次失败原因（诊断用）。 */
export type MeshHubCandidate = MeshHubsResponse['candidates'][number];

export interface MeshHubsState {
  hubs: MeshHubEndpoint[];
  /** uplink 候选地址的尝试记录；旧后端不下发时为空数组。 */
  candidates: MeshHubCandidate[];
  /** 本机 uplink 当前挂载的那台 hub；未连上或旧后端为 `null`。 */
  attached: MeshAttachedHub | null;
  /** 当前接受管理写入的 hub（active 中 writerEpoch 最高的一台）；一台 active 都没有时为 `null`。 */
  writerHubId: string | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
}

const EMPTY_STATE: MeshHubsState = {
  hubs: [],
  candidates: [],
  attached: null,
  writerHubId: null,
  loading: false,
  error: null,
  loadedAt: null,
};

const store = createStateStore<MeshHubsState>(EMPTY_STATE, () => {
  inFlight = null;
});
const setState = store.set;

export const getMeshHubsState = store.get;
export const subscribeMeshHubs = store.subscribe;

/** 仅测试使用：直接注入一份状态。 */
export const setMeshHubsStateForTest = store.set;

export const resetMeshHubsStateForTest = store.reset;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 当前 writer hub 的那一行；`writerHubId` 为空或集合里没有它时为 `null`。 */
export function writerHub(snapshot: MeshHubsState): MeshHubEndpoint | null {
  if (!snapshot.writerHubId) return null;
  return snapshot.hubs.find((hub) => hub.nodeId === snapshot.writerHubId) ?? null;
}

/** writer hub 的对外地址：`HUB_NOT_WRITER` 的文案要靠它指路。 */
export function writerHubUrl(snapshot: MeshHubsState): string | null {
  return writerHub(snapshot)?.publicUrl ?? null;
}

/** 本机 uplink 挂载的那台 hub 的 nodeId；未知为 `null`。 */
export function attachedHubId(snapshot: MeshHubsState): string | null {
  return snapshot.attached?.hubNodeId ?? null;
}

/**
 * 管理写入（加入 / 重命名 / 吊销）当前是否不可用。
 *
 * **只在有确凿证据时才判 true**：hub 集合还没拉到（旧入口没有这条路由、首屏未加载）一律按
 * 「可用」处理，否则单 hub 用户会平白多出一行禁用提示。
 */
export function hubWritesBlocked(snapshot: MeshHubsState): boolean {
  if (snapshot.hubs.length === 0) return false;
  if (snapshot.attached?.mode === 'standby') return true;
  const writer = writerHub(snapshot);
  if (!writer) return true;
  return writer.online === false;
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

let inFlight: Promise<void> | null = null;

export async function refreshMeshHubs(api: AuthApi = defaultAuthApi): Promise<void> {
  // 退出 mesh 期间本机会话已被清空，再拉 `/api/mesh/*` 只会稳定拿 401。
  if (isAuthTransitionActive()) return;
  if (inFlight) return inFlight;
  setState({ loading: true });
  inFlight = (async () => {
    try {
      const payload = await api.listHubs();
      setState({
        hubs: payload.hubs,
        candidates: payload.candidates,
        attached: payload.attached,
        writerHubId: payload.writerHubId,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      });
    } catch (err) {
      // 失败保留上一份集合：一次网络抖动不该把已经展示出来的 hub 集合抹掉。
      setState({ loading: false, error: errorMessage(err) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ---------------------------------------------------------------------------
// 轮询回路
// ---------------------------------------------------------------------------

export interface MeshHubsPollingOptions extends PollingTimingOptions {
  api?: AuthApi;
  events?: MeshEventSubscriber;
  refresh?: (api: AuthApi) => void;
}

/**
 * 回路本体：
 *  - 页面隐藏期间跳过这一拍；重新可见时立刻补一次（30 秒一拍的数据在后台待久了必然过期）；
 *  - `/mesh/ws` 连上（含重连）后补一次；
 *  - 已知 hub 机的 NODE_EVENT（上线 / 下线 / 吊销）触发补一次——主 hub 掉线是这里最要紧的
 *    一件事，等下一拍会让用户对着一份「writer 仍在线」的旧集合操作。
 */
function startPolling(options: MeshHubsPollingOptions): () => void {
  const api = options.api ?? defaultAuthApi;
  const refresh = options.refresh ?? ((target: AuthApi) => void refreshMeshHubs(target));
  const events = options.events ?? sharedMeshEvents();

  return startPollingLoop(options, {
    defaultIntervalMs: MESH_HUBS_POLL_MS,
    defaultThrottleMs: MESH_HUBS_REFRESH_THROTTLE_MS,
    refresh: () => refresh(api),
    wire: ({ requestRefresh }) => {
      const stopStatus = events.onStatusChange(() => {
        if (events.connected) requestRefresh();
      });
      const stopEvents = events.onNodeEvent((event) => {
        if (!getMeshHubsState().hubs.some((hub) => hub.nodeId === event.nodeId)) return;
        requestRefresh();
      });
      return () => {
        stopStatus();
        stopEvents();
      };
    },
  });
}

const acquirePolling = createPollingHandle(startPolling);

/** 取用宿主级**唯一**的回路，返回归还函数（幂等）。 */
export function acquireMeshHubsPolling(options: MeshHubsPollingOptions = {}): () => void {
  return acquirePolling(options);
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface UseMeshHubsOptions {
  /** standalone 下必须传 false：不发任何 `/api/mesh/*` 请求。 */
  enabled?: boolean;
  api?: AuthApi;
  events?: MeshEventSubscriber;
  /**
   * 轮询的所有者。只有节点管理页传 true；其余消费方（本机区块）只订阅同一份 store，
   * 首屏没有任何数据时才补拉一次，单飞会与 owner 的首拉合并。
   */
  owner?: boolean;
  pollIntervalMs?: number;
}

export interface UseMeshHubsResult extends MeshHubsState {
  /** writer hub 的对外地址；未知为 `null`。 */
  writerPublicUrl: string | null;
  /** 管理写入是否不可用（挂在 standby 上，或 writer 缺席 / 离线）。 */
  writesBlocked: boolean;
  refresh: () => void;
}

export function useMeshHubs(options: UseMeshHubsOptions = {}): UseMeshHubsResult {
  const enabled = options.enabled ?? true;
  const owner = options.owner ?? false;
  const api = options.api ?? defaultAuthApi;
  const pollIntervalMs = options.pollIntervalMs ?? MESH_HUBS_POLL_MS;
  const events = options.events;
  const snapshot = useSyncExternalStore(subscribeMeshHubs, getMeshHubsState, getMeshHubsState);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void refreshMeshHubs(api);
  }, [api, enabled]);

  const polls = enabled && owner;
  useEffect(() => {
    if (!polls) return;
    return acquireMeshHubsPolling({ api, intervalMs: pollIntervalMs, events });
  }, [api, polls, pollIntervalMs, events]);

  const listUnknown = enabled && !owner && snapshot.loadedAt === null && snapshot.error === null;
  useEffect(() => {
    if (listUnknown) void refreshMeshHubs(api);
  }, [api, listUnknown]);

  return {
    ...snapshot,
    writerPublicUrl: writerHubUrl(snapshot),
    writesBlocked: hubWritesBlocked(snapshot),
    refresh,
  };
}
