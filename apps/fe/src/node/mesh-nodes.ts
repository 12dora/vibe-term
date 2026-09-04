// mesh 节点视图：`GET /api/mesh/nodes` 的宿主级单例 store + `/mesh/ws` NODE_EVENT 实时投影
// + hub 机 node 的发现与 `GET /n/<hub>/api/hub/nodes` 合并。
//
// 为什么不用 react-query：这份列表是**入口级**的（永远打 entry 自身，不带 `/n/:id` 前缀），
// 而侧边栏/设备页可能挂在任意 node 的 QueryClient 下——放进某个 node 的缓存会在切 node 时
// 重复拉取，也拿不到跨边界的实时事件。用一个模块级 store + useSyncExternalStore 更直接。

import { isAuthTransitionActive } from '@/auth/auth-transition';
import { SELF_NODE_ID } from '@tmex/api-client';
import type {
  AuthApi,
  AuthModeResponse,
  AuthRequiredDetail,
  MeshNode,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi, onAuthRequired } from '@tmex/api-client/auth/index';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type PollingControls,
  type PollingTimingOptions,
  createPollingHandle,
  createStateStore,
  startPollingLoop,
} from './create-polling-store';
import { HubApi, HubApiError, type HubNodeRow } from './hub-api';
import {
  type HubFailureReason,
  HubLoadCoordinator,
  type HubRequest,
  isHubAuthCode,
} from './hub-load-coordinator';
import { HUB_POLL_MS, startHubPolling } from './hub-polling';
import { type MeshEventSource, type NodeEventPayload, sharedMeshEvents } from './mesh-events';

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

/** NODE_EVENT 投影到列表：只改已知 node 的在线态 / 到达路径 / inventory，不新增行。 */
export function patchNodesWithEvent(nodes: MeshNode[], event: NodeEventPayload): MeshNode[] {
  // revoked 的 node 直接从列表移除：证书已失效，任何操作都不该再指向它。
  if (event.status === 'revoked') {
    const filtered = nodes.filter((node) => node.id !== event.nodeId);
    return filtered.length === nodes.length ? nodes : filtered;
  }
  let changed = false;
  const next = nodes.map((node) => {
    if (node.id !== event.nodeId) return node;
    changed = true;
    const online = event.status === 'online';
    const transport = online ? pick(event.transport, node.transport) : null;
    const reach = online ? event.reach : null;
    // 只 REST 下发的链路现场（对端地址、建立时刻、未直连原因）：事件里没有这几段。承载与到达
    // 路径都没变才是同一条链路，可以留用；一旦换了链路，旧地址与旧时长必须清掉，否则会一直显示
    // 到下一次轮询。
    const sameLink = online && transport === (node.transport ?? null) && reach === node.reach;
    return {
      ...node,
      online,
      reach,
      transport,
      rttMs: online ? pick(event.rttMs, node.rttMs) : null,
      peerAddress: sameLink ? (node.peerAddress ?? null) : null,
      linkSinceAt: sameLink ? (node.linkSinceAt ?? null) : null,
      directFailure: sameLink ? (node.directFailure ?? null) : null,
      inventory: event.inventory ?? node.inventory,
      version: event.version ?? versionOf(event.inventory) ?? node.version,
      direct_capable: event.direct_capable ?? node.direct_capable,
      name: event.name ?? node.name,
    } satisfies MeshNode;
  });
  return changed ? next : nodes;
}

/** 事件里没带这一段（老 node 的帧）时保留上一次列表里的值，别把已知信息清成未知。 */
function pick<T>(fromEvent: T | undefined, previous: T | undefined): T | null {
  if (fromEvent !== undefined) return fromEvent;
  return previous ?? null;
}

function versionOf(inventory: unknown): string | null {
  if (!inventory || typeof inventory !== 'object') return null;
  const value = (inventory as { version?: unknown }).version;
  return typeof value === 'string' ? value : null;
}

/**
 * hub 机 node 的 id。**只认契约字段**：`/api/mesh/nodes` 的 `isHub`（hub 经 `node.list`
 * 下发、node 侧持久化），以及 `/api/auth/mode` 的 `hubNodeId`。
 *
 * 之前那套「inventory 猜角色 → entry 自身 → 任意在线 node」的启发式已删除：逐个探测
 * `/n/<id>/api/hub/nodes` 会把管理面请求发给不是 hub 的机器，第一个恰好返回 200 的还会被
 * 当成 hub。
 */
export function findHubNodeId(nodes: MeshNode[], modeHubNodeId?: string | null): string | null {
  // 多 hub 下 `isHub` 会命中任意一台（很可能是 standby，管理写入一律被拒），而
  // `/api/auth/mode` 的 `hubNodeId` 指的就是当前 writer：列表里认得出它时以它为准。
  const writer = modeHubNodeId
    ? nodes.find((node) => node.id === modeHubNodeId && node.isHub === true)
    : undefined;
  if (writer) return writer.id;
  const flagged = nodes.find((node) => node.isHub === true);
  if (flagged) return flagged.id;
  return modeHubNodeId || null;
}

/**
 * 管理面可用的 hub 机顺序：写者优先，其余 hub 机兜底——standby 会把管理写入转发给写者，
 * 写者暂时打不通（或还没登录）时不该整页判「hub 不可达」。
 */
export function hubCandidateIds(nodes: MeshNode[], modeHubNodeId?: string | null): string[] {
  const primary = findHubNodeId(nodes, modeHubNodeId);
  const ids: string[] = primary ? [primary] : [];
  for (const node of nodes) {
    if (node.isHub === true && node.online !== false && !ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}

export interface HubLoadDeps {
  list: (hubNodeId: string) => Promise<HubNodeRow[]>;
  /** 对该 hub 机做静默节点登录；成功才重试一次。失败码用于区分「hub 拒登」与「打不通」。 */
  login: (hubNodeId: string) => Promise<{ ok: boolean; code?: string }>;
}

export interface HubLoadResult {
  hubNodeId: string;
  rows: HubNodeRow[];
}

function isNodeLoginRequired(error: unknown): boolean {
  return error instanceof HubApiError && error.status === 401;
}

/**
 * 依次尝试候选 hub 机：401 `NODE_LOGIN_REQUIRED` 先补一次节点登录再重试（浏览器此前可能
 * 从未登录过新升上来的写者），仍失败才换下一台；全部失败抛最后一个错误。
 *
 * 静默登录被 hub 以鉴权码拒掉时，**抛出去的必须是那次登录失败**：列表那条 401 只说明
 * 「还没登录」，把它一路抛到界面只会显示成一句「Hub 不可达」，掩盖掉真正的原因
 * （通行密钥 / TOTP 没过）。
 *
 * 全部候选都失败时抛**最可操作**的那一个：拒登（用户能去补验证）优先于打不通，否则
 * 「写者拒登 → 备机 503」会被后一条盖成「Hub 不可达」。多台都拒登时以第一台（写者）为准。
 */
export async function loadHubNodes(
  candidates: string[],
  deps: HubLoadDeps
): Promise<HubLoadResult> {
  let lastError: unknown = new Error('hub_unreachable');
  let authError: HubApiError | null = null;
  for (const hubNodeId of candidates) {
    try {
      return { hubNodeId, rows: await deps.list(hubNodeId) };
    } catch (error) {
      lastError = error;
      if (!isNodeLoginRequired(error)) continue;
      const login = await deps
        .login(hubNodeId)
        .catch((): { ok: boolean; code?: string } => ({ ok: false }));
      if (!login.ok) {
        if (isHubAuthCode(login.code)) {
          const rejected = new HubApiError(login.code, 401);
          lastError = rejected;
          authError ??= rejected;
        }
        continue;
      }
      try {
        return { hubNodeId, rows: await deps.list(hubNodeId) };
      } catch (retryError) {
        lastError = retryError;
      }
    }
  }
  throw authError ?? lastError;
}

function silentNodeLogin(hubNodeId: string): Promise<{ ok: boolean }> {
  return import('@/auth/session-key-store').then((mod) => mod.ensureNodeLogin(hubNodeId));
}

// ---------------------------------------------------------------------------
// 宿主级 store
// ---------------------------------------------------------------------------

export interface MeshNodesState {
  nodes: MeshNode[];
  /** entry 自身的 nodeId（来自 `/api/auth/mode`），未知为 `null`。 */
  entryNodeId: string | null;
  /** `/api/auth/mode` 的结果；standalone 时 `mode==='none'`，此时不发任何 `/api/mesh/*` 请求。 */
  mode: AuthModeResponse | null;
  modeLoaded: boolean;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
}

const EMPTY_STATE: MeshNodesState = {
  nodes: [],
  entryNodeId: null,
  mode: null,
  modeLoaded: false,
  loading: false,
  error: null,
  loadedAt: null,
};

const store = createStateStore<MeshNodesState>(EMPTY_STATE, () => {
  modePromise = null;
  inFlight = null;
  trailingRequested = false;
});
const setState = store.set;

export const getMeshNodesState = store.get;
export const subscribeMeshNodes = store.subscribe;

/** 仅测试使用：直接注入一份状态。 */
export const setMeshNodesStateForTest = store.set;

export const resetMeshNodesStateForTest = store.reset;

let modePromise: Promise<void> | null = null;

/** `/api/auth/mode` 全宿主只拉一次（standalone 判定与 entry nodeId 都从这里来）。 */
export function ensureAuthMode(api: AuthApi = defaultAuthApi): Promise<void> {
  if (modePromise) return modePromise;
  modePromise = api
    .getMode()
    .then((mode) => {
      setState({ mode, modeLoaded: true, entryNodeId: mode.nodeId || null });
    })
    .catch(() => {
      // 拉不到就按「未知」处理：既不渲染 mesh UI，也不退化成 standalone 之外的形态。
      setState({ modeLoaded: true });
    });
  return modePromise;
}

export interface SharedAuthMode {
  mode: AuthModeResponse | null;
  loaded: boolean;
  /** mesh 模式（非 standalone）。未加载完成时为 `false`。 */
  meshEnabled: boolean;
  entryNodeId: string | null;
}

export function useSharedAuthMode(api: AuthApi = defaultAuthApi): SharedAuthMode {
  const snapshot = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  useEffect(() => {
    void ensureAuthMode(api);
  }, [api]);
  return {
    mode: snapshot.mode,
    loaded: snapshot.modeLoaded,
    meshEnabled: snapshot.mode?.mode === 'mesh',
    entryNodeId: snapshot.entryNodeId,
  };
}

export function applyMeshNodeEvent(event: NodeEventPayload): void {
  const { nodes } = store.get();
  const next = patchNodesWithEvent(nodes, event);
  if (next !== nodes) setState({ nodes: next });
}

let inFlight: Promise<void> | null = null;
let trailingRequested = false;

export async function refreshMeshNodes(api: AuthApi = defaultAuthApi): Promise<void> {
  // 退出 mesh 期间本机会话已被清空，再拉 `/api/mesh/nodes` 只会稳定拿 401：
  // 白发一轮请求不说，还会把拦截器反复喊起来。
  if (isAuthTransitionActive()) return;
  if (inFlight) return inFlight;
  setState({ loading: true });
  inFlight = (async () => {
    try {
      const nodes = await api.listNodes();
      setState({ nodes, loading: false, error: null, loadedAt: Date.now() });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = null;
      if (trailingRequested) {
        trailingRequested = false;
        void refreshMeshNodes(api);
      }
    }
  })();
  return inFlight;
}

/**
 * 「一定要拿到比现在更新的一份列表」。
 *
 * 与 `refreshMeshNodes` 的区别只在**在途**那一刻：后者会直接复用在飞的请求，而事件驱动的
 * 补拉不能这么做——事件说明数据刚变了，在飞的那次请求可能早于变化就发出去了，复用它只会
 * 拿回一份仍然缺新成员的旧响应。这里改成排一次尾随请求，等在飞的落地后再发一次；
 * 期间重复触发只合并成同一次尾随。
 */
export function ensureFreshMeshNodes(api: AuthApi = defaultAuthApi): void {
  if (isAuthTransitionActive()) return;
  if (inFlight) {
    trailingRequested = true;
    return;
  }
  void refreshMeshNodes(api);
}

/** 返回列表是否真的被改动过（调用方据此决定要不要回源）。 */
function setLoggedIn(nodeId: string, loggedIn: boolean): boolean {
  const snapshot = store.get();
  const target = nodeId === SELF_NODE_ID ? snapshot.entryNodeId : nodeId;
  if (!target) return false;
  let changed = false;
  const next = snapshot.nodes.map((node) => {
    if (node.id !== target || node.loggedIn === loggedIn) return node;
    changed = true;
    return { ...node, loggedIn };
  });
  if (changed) setState({ nodes: next });
  return changed;
}

/**
 * 某台 node 登录成功后就地把它标成已登录，不必等下一次 `/api/mesh/nodes` 轮询。
 * `self` 按 entry 自身的 nodeId 解析；列表里没有这一行时什么都不做。
 */
export function markLoggedIn(nodeId: string): boolean {
  return setLoggedIn(nodeId, true);
}

/**
 * 该 node 的会话确认作废（401 `NODE_LOGIN_REQUIRED` 之后连静默重登都没成功）时标未登录，
 * 让「用到才登录」的门闸退回登录入口。
 *
 * **只允许 `node-session-recovery` 在重登失败后调用**：光有一次 401 不足以判会话没了
 * （转发路径本身会产生会话仍有效的 401），就地登出会抽掉整棵 node 子树再静默登回来，
 * 表现为设备卡片闪断。
 */
export function markLoggedOut(nodeId: string): boolean {
  return setLoggedIn(nodeId, false);
}

export function setEntryNodeId(nodeId: string | null): void {
  if (store.get().entryNodeId === nodeId) return;
  setState({ entryNodeId: nodeId });
}

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
    void refreshMeshNodes(api);
  }, [api, enabled]);

  useMeshNodesPoller(api, enabled && owner, pollIntervalMs, options.events);

  // 非 owner 只订阅 store。唯一的例外是「一份数据都还没有」：常驻 owner 不在场时
  // （单测、或 standalone→mesh 刚切过来的一瞬）总得有人把首份列表拉回来。
  const listUnknown = enabled && !owner && snapshot.loadedAt === null && snapshot.error === null;
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

export interface HubNodeState {
  hubNodeId: string | null;
  hubApi: HubApi | null;
  hubNodes: HubNodeRow[] | null;
  /** hub 管理面是否可用（探测成功且最近一次 list 成功）。 */
  online: boolean;
  loading: boolean;
  /** 最近一次失败的性质；从未失败或已恢复为 `null`。 */
  failure: HubFailureReason | null;
  refresh: () => void;
}

export interface UseHubNodeOptions {
  enabled?: boolean;
  /** 覆盖列表请求（测试注入）。 */
  probe?: (nodeId: string) => Promise<HubNodeRow[]>;
  /** `/api/auth/mode` 下发的 hub nodeId；mesh 列表还没到时用它。 */
  hubNodeId?: string | null;
  pollIntervalMs?: number;
  /** 覆盖节点登录（测试注入）；缺省懒加载 `ensureNodeLogin`。 */
  login?: (hubNodeId: string) => Promise<{ ok: boolean }>;
}

interface HubStateSetters {
  setHubNodes: (rows: HubNodeRow[] | null) => void;
  setLoading: (value: boolean) => void;
  setFailure: (reason: HubFailureReason | null) => void;
}

/** 协调器只建一次（`useState` 的 setter 恒等），挂载/卸载切它的写状态开关。 */
function useHubLoadCoordinator(setters: HubStateSetters): HubLoadCoordinator {
  const { setHubNodes, setLoading, setFailure } = setters;
  const ref = useRef<HubLoadCoordinator | null>(null);
  if (ref.current === null) {
    ref.current = new HubLoadCoordinator({
      // 换目标（切 hub / 启停）开跑时清掉上一台的失败：A 的拒登提示不该挂在 B 的加载上。
      loading: (value, switched) => {
        setLoading(value);
        if (value && switched) setFailure(null);
      },
      reset: () => {
        setHubNodes(null);
        setLoading(false);
        setFailure(null);
      },
      rows: (rows) => {
        setHubNodes(rows);
        setFailure(null);
      },
      failed: (reason) => {
        setHubNodes(null);
        setFailure(reason);
      },
    });
  }
  const coordinator = ref.current;
  useEffect(() => {
    coordinator.activate();
    return () => coordinator.dispose();
  }, [coordinator]);
  return coordinator;
}

/**
 * 定位 hub 机的 node（`isHub` / `mode.hubNodeId`）并拉取 `GET /n/<hub>/api/hub/nodes`。
 * 定位不到就直接判定 hub 不可达，**不再**逐个探测其它 node。
 *
 * 初次加载 / 轮询 / 手动刷新三条来源共用 `HubLoadCoordinator`：并发调用合并成一次请求，
 * 慢的旧响应按代号丢弃，卸载后不再写状态。
 */
export function useHubNode(nodes: MeshNode[], options: UseHubNodeOptions = {}): HubNodeState {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? HUB_POLL_MS;
  const [hubNodes, setHubNodes] = useState<HubNodeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<HubFailureReason | null>(null);

  const resolved = useMemo(
    () => findHubNodeId(nodes, options.hubNodeId),
    [nodes, options.hubNodeId]
  );
  const candidatesKey = useMemo(
    () => hubCandidateIds(nodes, options.hubNodeId).join(','),
    [nodes, options.hubNodeId]
  );
  const probe = options.probe;
  const login = options.login ?? silentNodeLogin;
  // 真正应答的那台 hub 机（写者打不通时可能是 standby），管理动作也发给它。
  const [activeHubId, setActiveHubId] = useState<string | null>(null);

  // 请求闭包同时充当单飞的身份：目标（enabled / 候选集 / probe）一变就是新的一次加载。
  const request = useMemo<HubRequest | null>(() => {
    const candidates = candidatesKey ? candidatesKey.split(',') : [];
    if (!enabled || candidates.length === 0) return null;
    return async () => {
      const result = await loadHubNodes(candidates, {
        list: (id) => (probe ? probe(id) : new HubApi(id).listNodes()),
        login,
      });
      setActiveHubId(result.hubNodeId);
      return result.rows;
    };
  }, [enabled, probe, login, candidatesKey]);

  const coordinator = useHubLoadCoordinator({ setHubNodes, setLoading, setFailure });

  useEffect(() => {
    void coordinator.load(request);
  }, [coordinator, request]);

  useEffect(() => {
    if (!request || pollIntervalMs <= 0) return;
    return startHubPolling({
      intervalMs: pollIntervalMs,
      load: () => void coordinator.load(request),
    });
  }, [coordinator, request, pollIntervalMs]);

  // 变更之后的刷新必须比当前在飞的那一次更新，否则批准 / 吊销的结果会被旧响应盖回去。
  const refresh = useCallback(() => void coordinator.refresh(request), [coordinator, request]);
  const effectiveHubId = activeHubId ?? resolved;
  const hubApi = useMemo(
    () => (effectiveHubId ? new HubApi(effectiveHubId) : null),
    [effectiveHubId]
  );

  return {
    hubNodeId: effectiveHubId,
    hubApi,
    hubNodes,
    online: hubNodes !== null,
    loading,
    failure,
    refresh,
  };
}
