// mesh 节点视图的 React 绑定：宿主级单例轮询回路、`useMeshNodes`。
//
// 状态本体（store、`/api/auth/mode`、`/api/mesh/nodes`、首帧缓存与有界重试）在
// `./mesh-nodes-store`；这里原样再导出一遍，调用方仍然只 import 本模块。

import type { AuthApi, AuthRequiredDetail } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi, onAuthRequired } from '@vibeterm/api-client/auth/index';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  type PollingControls,
  type PollingTimingOptions,
  createPollingHandle,
  startPollingLoop,
} from './create-polling-store';
import { type MeshEventSource, type NodeEventPayload, sharedMeshEvents } from './mesh-events';
import {
  applyMeshNodeEvent,
  ensureAuthMode,
  ensureFreshMeshNodes,
  getMeshNodesState,
  meshEnabledOf,
  refreshMeshNodes,
  subscribeMeshNodes,
} from './mesh-nodes-store';

import type { MeshNodesState, SharedAuthMode } from './mesh-nodes-store';
import { clearAllNodeBackoff } from './node-unreachable-backoff';

export type { MeshNodesState, SharedAuthMode } from './mesh-nodes-store';
export {
  applyMeshNodeEvent,
  ensureAuthMode,
  ensureFreshMeshNodes,
  getMeshNodesState,
  hydrateMeshNodesFromCache,
  markLoggedIn,
  markLoggedOut,
  meshEnabledOf,
  patchNodesWithEvent,
  refreshMeshNodes,
  resetMeshNodesStateForTest,
  retryUnsettledOnRecovery,
  setEntryNodeId,
  setMeshNodesStateForTest,
  setRetrySchedulersForTest,
  subscribeMeshNodes,
} from './mesh-nodes-store';

/**
 * `/api/auth/mode` 的共享读法：任何消费方挂上来都会保证它被拉过一次。
 */
export function useSharedAuthMode(api: AuthApi = defaultAuthApi): SharedAuthMode {
  const snapshot = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  useEffect(() => {
    void ensureAuthMode(api);
  }, [api]);
  return {
    mode: snapshot.mode,
    loaded: snapshot.modeLoaded,
    meshEnabled: meshEnabledOf(snapshot),
    entryNodeId: snapshot.entryNodeId,
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export {
  mergeNodes,
  publicKeyFingerprint,
  sortNodes,
  toRuntimeNodeId,
} from './merge-nodes';
export type { MergeContext, NodeRow, PendingAdmitMaterial } from './merge-nodes';

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface UseMeshNodesOptions {
  /** standalone（`mode:'none'`）下必须传 false：不发任何 `/api/mesh/*` 请求。 */
  enabled?: boolean;
  api?: AuthApi;
  events?: MeshEventSource;
  /** 轮询间隔；0 表示只在挂载时拉一次（事件流负责后续更新）。 */
  pollIntervalMs?: number;
  /**
   * 轮询的所有者。**只有常驻的 `MeshNodesResident` 传 true**：这份列表是宿主级单例，
   * 每多一个消费方装一个定时器就多一轮 `/api/mesh/nodes`。其余消费方只订阅 store，
   * 首屏若还没有任何数据才补拉一次（单飞会与 owner 的首拉合并）。
   */
  owner?: boolean;
}

export interface UseMeshNodesResult extends MeshNodesState {
  refresh: () => void;
}

/**
 * `/api/mesh/nodes` 的**兜底**轮询间隔。实时更新走 `/mesh/ws` 的 NODE_EVENT，REST 只负责
 * 成员集、公钥与只有 REST 才下发的链路现场，所以拉长到 5 分钟；成员变动与事件断流由下面
 * 的即时补拉覆盖。
 */
export const MESH_NODES_POLL_MS = 300_000;

/** 回到前台时判定「列表已经旧了」的阈值：切回标签页应当很快看到新鲜列表。 */
export const MESH_NODES_STALE_MS = 30_000;

/** 事件触发的补拉节流窗口：一串事件（如整片 node 同时上线）最多换来一次 REST。 */
export const MESH_NODES_REFRESH_THROTTLE_MS = 2_000;

/** 轮询回路只需要事件源的这三件事，测试注入一个假的即可。 */
export interface MeshEventSubscriber {
  readonly connected: boolean;
  onStatusChange(listener: () => void): () => void;
  onNodeEvent(listener: (event: NodeEventPayload) => void): () => void;
}

export interface MeshPollingOptions extends PollingTimingOptions {
  api?: AuthApi;
  /** 回到前台的过期阈值；缺省 `MESH_NODES_STALE_MS`。 */
  staleMs?: number;
  /** 事件源（测试注入）；缺省用宿主级共享的那一份。 */
  events?: MeshEventSubscriber;
  /** 401 `NODE_LOGIN_REQUIRED` 的订阅入口（测试注入）；缺省用 api-client 的拦截器事件。 */
  authRequired?: (listener: (detail: AuthRequiredDetail) => void) => () => void;
  refresh?: (api: AuthApi) => void;
}

/**
 * 轮询回路本体：
 *  - 页面隐藏期间跳过这一拍——手机上锁屏 / 切去别的 app 时不该再唤醒射频；
 *  - 重新可见时若距上次成功刷新已超过 `staleMs`，立刻补一次，不必等下一拍；
 *  - `/mesh/ws` 连上（含重连）后补一次：断流期间的事件已经错过了；
 *  - 收到列表里没有的 node 的事件时补一次：事件只改已知行，新成员得靠 REST 才进得来；
 *  - 某台 node 的会话失效（401 `NODE_LOGIN_REQUIRED`）时就地标未登录并补一次。
 *
 * 后四条都走同一个节流窗口，一串事件最多换来一次 REST。所有刷新都经 `ensureFreshMeshNodes`：
 * 在途的那次请求可能早于变化发出，直接复用它会拿回一份仍然过时的响应。
 */
function startPolling(options: MeshPollingOptions): () => void {
  const api = options.api ?? defaultAuthApi;
  const staleMs = options.staleMs ?? MESH_NODES_STALE_MS;
  const refresh = options.refresh ?? ensureFreshMeshNodes;
  const now = options.now ?? Date.now;
  const events = options.events ?? sharedMeshEvents();
  const authRequired = options.authRequired ?? onAuthRequired;

  // 已经为之补拉过的陌生 node：REST 有可能压根不返回它（如公钥无效的 node 会被投影丢掉），
  // 它每次上下线都补拉一轮就成了新的定时器。每个兜底拍才放行一次重试。
  const unknownSeen = new Set<string>();
  const authSeen = new Set<string>();

  const sweep = (controls: PollingControls) => {
    unknownSeen.clear();
    authSeen.clear();
    controls.runRefresh();
  };

  return startPollingLoop(options, {
    defaultIntervalMs: MESH_NODES_POLL_MS,
    defaultThrottleMs: MESH_NODES_REFRESH_THROTTLE_MS,
    refresh: () => refresh(api),
    wire: ({ requestRefresh }) => {
      const stopStatus = events.onStatusChange(() => {
        if (events.connected) requestRefresh();
      });
      const stopEvents = events.onNodeEvent((event) => {
        // revoked 由 `patchNodesWithEvent` 就地摘行，不必回源；列表还没到时也别抢在首拉前面。
        if (event.status === 'revoked') return;
        const { nodes, loadedAt } = getMeshNodesState();
        if (loadedAt === null) return;
        if (nodes.some((node) => node.id === event.nodeId)) return;
        if (unknownSeen.has(event.nodeId)) return;
        unknownSeen.add(event.nodeId);
        requestRefresh();
      });
      // 节点级 401 只回源、**绝不就地翻 loggedIn**：转发路径（直连/中转切换、节点侧 via 校验）
      // 会产生会话仍有效的 401，就地登出会抽掉整个节点子树再静默登回来，表现为设备卡片闪断。
      // REST 按 cookie 判定登录态，真实过期时 cookie 已随会话到期消失，回源一次即可反映。
      // 同一 node 每个兜底拍只放行一次（`authSeen` 随 sweep 清空），避免持续 401 变成新的定时器。
      const stopAuthRequired = authRequired((detail) => {
        if (detail.scope !== 'node') return;
        console.warn(`[mesh] node 401 node=${detail.nodeId} path=${detail.path}`);
        if (authSeen.has(detail.nodeId)) return;
        authSeen.add(detail.nodeId);
        requestRefresh();
      });
      return () => {
        stopStatus();
        stopEvents();
        stopAuthRequired();
      };
    },
    tick: sweep,
    onVisible: (controls) => {
      const { loadedAt } = getMeshNodesState();
      if (loadedAt === null || now() - loadedAt >= staleMs) sweep(controls);
    },
  });
}

const acquirePolling = createPollingHandle(startPolling);

/**
 * 取用宿主级**唯一**的轮询回路，返回归还函数（幂等）。
 *
 * 定时器只有一份：`useMeshNodes({ owner: true })` 之外的消费方都不该取用它，但即便将来
 * 多接了一处，引用计数也保证不会出现第二个 `/api/mesh/nodes` 定时器。首个取用方的 options
 * 决定这一轮回路的接线，后来者只加引用计数。
 */
export function acquireMeshNodesPolling(options: MeshPollingOptions = {}): () => void {
  return acquirePolling(options);
}

function useMeshNodesPoller(
  api: AuthApi,
  active: boolean,
  intervalMs: number,
  events?: MeshEventSubscriber
): void {
  useEffect(() => {
    if (!active) return;
    return acquireMeshNodesPolling({ api, intervalMs, events });
  }, [api, active, intervalMs, events]);
}

export function useMeshNodes(options: UseMeshNodesOptions = {}): UseMeshNodesResult {
  const enabled = options.enabled ?? true;
  const owner = options.owner ?? false;
  const api = options.api ?? defaultAuthApi;
  const pollIntervalMs = options.pollIntervalMs ?? MESH_NODES_POLL_MS;
  const snapshot = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);

  const refresh = useCallback(() => {
    if (!enabled) return;
    // 只有界面会调它（节点管理页进入 / 刷新）：用户此刻正盯着这些 node 的状态，
    // 打不通的那几台该重新试一次，而不是继续躺在退避窗口里。
    clearAllNodeBackoff();
    void refreshMeshNodes(api);
  }, [api, enabled]);

  useMeshNodesPoller(api, enabled && owner, pollIntervalMs, options.events);

  // 非 owner 只订阅 store。唯一的例外是「一份数据都还没有」：常驻 owner 不在场时
  // （单测、或 standalone→mesh 刚切过来的一瞬）总得有人把首份列表拉回来。
  // 失败过同样算「还没有」——`refreshMeshNodes` 单飞，且失败后只由有界重试兜着，
  // 这里不会变成循环。
  const listUnknown = enabled && !owner && snapshot.loadedAt === null;
  useEffect(() => {
    if (listUnknown) void refreshMeshNodes(api);
  }, [api, listUnknown]);

  useEffect(() => {
    if (!enabled) return;
    const source = options.events ?? sharedMeshEvents();
    source.start();
    return source.onNodeEvent(applyMeshNodeEvent);
  }, [enabled, options.events]);

  return { ...snapshot, refresh };
}
