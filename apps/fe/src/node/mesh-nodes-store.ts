// mesh 成员列表的宿主级单例 store：`/api/auth/mode` 与 `/api/mesh/nodes` 的状态、
// NODE_EVENT 的就地投影，以及冷启动的三条兜底（localStorage 首帧缓存、有界重试、恢复信号）。
//
// 为什么不用 react-query：这份列表是**入口级**的（永远打 entry 自身，不带 `/n/:id` 前缀），
// 而侧边栏/设备页可能挂在任意 node 的 QueryClient 下——放进某个 node 的缓存会在切 node 时
// 重复拉取，也拿不到跨边界的实时事件。用一个模块级 store + useSyncExternalStore 更直接。

import { isAuthTransitionActive } from '@/auth/auth-transition';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { AuthApi, AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { createStateStore } from './create-polling-store';
import type { NodeEventPayload } from './mesh-events';
import { clearMeshNodesCache, readMeshNodesCache, writeMeshNodesCache } from './mesh-nodes-cache';
import { type RetrySchedulerOptions, createRetryScheduler, onPageRecovery } from './mesh-recovery';

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
  /** 当前 `nodes` 来自 localStorage 兜底缓存，还没被任何一次 REST 换过。 */
  stale: boolean;
  /**
   * 上一次成功的 `/api/auth/mode` 是不是 mesh（来自缓存）。只用来在 `modeLoaded` 之前
   * 决定要不要渲染聚合视图 / 起 `/api/mesh/nodes`，**不**替代 `mode` 本身——鉴权相关的
   * 字段（通行密钥二次验证、本机登录状态）绝不能从盘上恢复。
   */
  cachedMesh: boolean;
}

const EMPTY_STATE: MeshNodesState = {
  nodes: [],
  entryNodeId: null,
  mode: null,
  modeLoaded: false,
  loading: false,
  error: null,
  loadedAt: null,
  stale: false,
  cachedMesh: false,
};

const store = createStateStore<MeshNodesState>(EMPTY_STATE, () => {
  modePromise = null;
  inFlight = null;
  trailingRequested = false;
  modeRetry.reset();
  nodesRetry.reset();
  clearMeshNodesCache();
});
const setState = store.set;

export const getMeshNodesState = store.get;
export const subscribeMeshNodes = store.subscribe;

/** 仅测试使用：直接注入一份状态。 */
export const setMeshNodesStateForTest = store.set;

export const resetMeshNodesStateForTest = store.reset;

let modeRetry = createRetryScheduler();
let nodesRetry = createRetryScheduler();

/** 仅测试使用：把恢复重试的定时器换成可控的一份（并清掉在途的）。 */
export function setRetrySchedulersForTest(options: RetrySchedulerOptions = {}): void {
  modeRetry.reset();
  nodesRetry.reset();
  modeRetry = createRetryScheduler(options);
  nodesRetry = createRetryScheduler(options);
  modeSettled = false;
}

/** 模块加载时把上次的列表读回来当第一帧；REST 落地即整份换掉。 */
export function hydrateMeshNodesFromCache(): boolean {
  const cached = readMeshNodesCache();
  if (!cached) return false;
  setState({
    nodes: cached.nodes,
    entryNodeId: cached.entryNodeId,
    cachedMesh: cached.mesh,
    stale: true,
  });
  return true;
}

hydrateMeshNodesFromCache();

function persistMeshNodes(): void {
  const snapshot = store.get();
  if (snapshot.mode !== null && snapshot.mode.mode !== 'mesh') return;
  writeMeshNodesCache({
    mesh: true,
    entryNodeId: snapshot.entryNodeId,
    nodes: snapshot.nodes,
    savedAt: Date.now(),
  });
}

let modePromise: Promise<void> | null = null;
/** 至少成功拉到过一次 `/api/auth/mode`；没有的话恢复信号要重试。 */
let modeSettled = false;

function applyAuthMode(mode: AuthModeResponse): void {
  const previous = store.get();
  const entryNodeId = mode.nodeId || null;
  // entry 换人（或退回 standalone）：缓存里那份属于上一个身份，整份丢掉。
  const stale = previous.stale && (mode.mode !== 'mesh' || previous.entryNodeId !== entryNodeId);
  if (stale) clearMeshNodesCache();
  setState({
    mode,
    modeLoaded: true,
    entryNodeId,
    cachedMesh: mode.mode === 'mesh',
    ...(stale ? { nodes: [], stale: false } : {}),
  });
  if (mode.mode !== 'mesh') clearMeshNodesCache();
}

/**
 * `/api/auth/mode` 全宿主只拉一次（standalone 判定与 entry nodeId 都从这里来）。
 *
 * 失败**不再**被 promise 永久记住：清掉在飞的 promise 并按 1 / 3 / 10 秒重试三次，
 * 页面重新可见 / 网络恢复时再重来一轮。移动端切回前台的第一秒射频还没起来，
 * 一次失败就把整页钉在「未知」形态上是这条链路最贵的一个坑。
 */
export function ensureAuthMode(api: AuthApi = defaultAuthApi): Promise<void> {
  if (modePromise) return modePromise;
  modePromise = api
    .getMode()
    .then((mode) => {
      modeSettled = true;
      modeRetry.reset();
      applyAuthMode(mode);
    })
    .catch(() => {
      // 拉不到就按「未知」处理：既不渲染 mesh UI，也不退化成 standalone 之外的形态。
      modePromise = null;
      setState({ modeLoaded: true });
      modeRetry.schedule(() => void ensureAuthMode(api));
    });
  return modePromise;
}

/**
 * 「页面重新可见 / 网络恢复」时把还没落地的那两条入口请求立刻重来一轮（并把退避倒回起点）。
 * 已经拿到结果的不动：这里不是又一个轮询器。
 */
export function retryUnsettledOnRecovery(api: AuthApi = defaultAuthApi): void {
  if (!modeSettled) {
    modeRetry.reset();
    void ensureAuthMode(api);
  }
  const { loadedAt, mode, cachedMesh } = store.get();
  if (loadedAt !== null) return;
  if (mode !== null && mode.mode !== 'mesh') return;
  if (mode === null && !cachedMesh) return;
  nodesRetry.reset();
  void refreshMeshNodes(api);
}

onPageRecovery(() => retryUnsettledOnRecovery());

export interface SharedAuthMode {
  mode: AuthModeResponse | null;
  loaded: boolean;
  /**
   * mesh 模式（非 standalone）。`/api/auth/mode` 还没落地时退回上次缓存的判定，
   * 冷启动第一帧就能渲染聚合视图并让 `/api/mesh/nodes` 与它并发发出去。
   */
  meshEnabled: boolean;
  entryNodeId: string | null;
}

/** 未加载完成时按缓存判定，加载完成后一律以真实 mode 为准。 */
export function meshEnabledOf(state: MeshNodesState): boolean {
  if (state.mode !== null) return state.mode.mode === 'mesh';
  return !state.modeLoaded && state.cachedMesh;
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
      nodesRetry.reset();
      setState({ nodes, loading: false, error: null, loadedAt: Date.now(), stale: false });
      persistMeshNodes();
    } catch (err) {
      setState({ loading: false, error: errorMessage(err) });
      // 首拉失败此前要等 5 分钟的兜底轮询才有下一次：冷启动那一下失败就等于整页没有节点。
      if (store.get().loadedAt === null) nodesRetry.schedule(() => void refreshMeshNodes(api));
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
