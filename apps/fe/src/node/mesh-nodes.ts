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
  MeshNode,
  MeshNodeReach,
  MeshNodeTransport,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { bytesToHex, decodeBase64url, sha256 } from '@tmex/shared/auth';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { HubApi, type HubNodeRow } from './hub-api';
import { type MeshEventSource, type NodeEventPayload, sharedMeshEvents } from './mesh-events';

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 公钥指纹：sha256(pk) 的前 16 个十六进制字符（8 字节）。畸形 base64url 返回空串。 */
export function publicKeyFingerprint(publicKeyB64url: string): string {
  try {
    return bytesToHex(sha256(decodeBase64url(publicKeyB64url))).slice(0, 16);
  } catch {
    return '';
  }
}

/** mesh 列表里的 node id → 运行时 / 路由用的 nodeId（entry 自身退化成 `self`，保持旧路由）。 */
export function toRuntimeNodeId(nodeId: string, entryNodeId: string | null): string {
  return entryNodeId && nodeId === entryNodeId ? SELF_NODE_ID : nodeId;
}

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
    return {
      ...node,
      online,
      reach: online ? event.reach : null,
      transport: online ? pick(event.transport, node.transport) : null,
      rttMs: online ? pick(event.rttMs, node.rttMs) : null,
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
 * entry 自身排第一，其余按名称排序（在线优先）。
 *
 * store 里的 `nodes` 保持 `/api/mesh/nodes` 的原始顺序（NODE_EVENT 投影也只就地改字段），
 * 展示顺序一律由消费方现算：设置页经 `mergeNodes`，侧边栏经 `toSidebarEntries`，
 * 两处都走这个函数，缺省顺序才不会两边不一致。
 */
export function sortNodes(nodes: MeshNode[], entryNodeId: string | null): MeshNode[] {
  return [...nodes].sort((a, b) => {
    const aSelf = entryNodeId != null && a.id === entryNodeId;
    const bSelf = entryNodeId != null && b.id === entryNodeId;
    if (aSelf !== bSelf) return aSelf ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** 合并后的一行：mesh 视图（在线/到达/登录）+ hub 视图（心跳、状态、证书）。 */
export interface NodeRow {
  id: string;
  /** 路由 / 运行时用的 id：entry 自身为 `self`。 */
  runtimeNodeId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  online: boolean;
  reach: MeshNodeReach;
  /** peer link 的实际承载；未知为 `null`。 */
  transport: MeshNodeTransport;
  /** entry ↔ node 的 ping/pong 往返毫秒数；未测得为 `null`。 */
  rttMs: number | null;
  version: string | null;
  directCapable: boolean;
  loggedIn: boolean;
  inventory: unknown;
  isSelf: boolean;
  isHub: boolean;
  /** hub 侧 `last_seen_at`（毫秒）；hub 不可达时为 `null`。 */
  lastSeenAt: number | null;
  /** hub 侧 `nodes.status`；hub 不可达时为 `null`。 */
  status: string | null;
  certificate: string | null;
  certSig: string | null;
}

function reachOf(reach: string | null | undefined): MeshNodeReach {
  return reach === 'lan' || reach === 'wan' || reach === 'relay' ? reach : null;
}

function transportOf(transport: string | null | undefined): MeshNodeTransport {
  return transport === 'ws-secure' || transport === 'relay' || transport === 'dc'
    ? transport
    : null;
}

function rttOf(rttMs: number | null | undefined): number | null {
  return typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
}

/**
 * 合并 mesh 列表与 hub 列表。mesh 列表是**权威成员集**（未 admit / 已 revoke 的不出现），
 * hub 只补充心跳与状态；hub 不可达时全部补充字段为 `null`，UI 据此禁用管理动作。
 */
export function mergeNodes(
  meshNodes: MeshNode[],
  hubNodes: HubNodeRow[] | null,
  context: { entryNodeId: string | null; hubNodeId: string | null }
): NodeRow[] {
  const hubById = new Map((hubNodes ?? []).map((row) => [row.id, row]));
  return sortNodes(meshNodes, context.entryNodeId).map((node) => {
    const hub = hubById.get(node.id) ?? null;
    return {
      id: node.id,
      runtimeNodeId: toRuntimeNodeId(node.id, context.entryNodeId),
      name: hub?.name ?? node.name,
      publicKey: node.publicKey,
      fingerprint: publicKeyFingerprint(node.publicKey),
      online: node.online,
      reach: reachOf(node.reach),
      transport: transportOf(node.transport),
      rttMs: rttOf(node.rttMs),
      version: node.version ?? hub?.version ?? null,
      directCapable: node.direct_capable || (hub?.direct_capable ?? false),
      loggedIn: node.loggedIn,
      inventory: node.inventory ?? null,
      isSelf: context.entryNodeId != null && node.id === context.entryNodeId,
      isHub: node.isHub === true || (context.hubNodeId != null && node.id === context.hubNodeId),
      lastSeenAt: hub?.last_seen_at ?? null,
      status: hub?.status ?? null,
      certificate: hub?.certificate ?? null,
      certSig: hub?.cert_sig ?? null,
    };
  });
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
  const flagged = nodes.find((node) => node.isHub === true);
  if (flagged) return flagged.id;
  return modeHubNodeId || null;
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

let state: MeshNodesState = EMPTY_STATE;
const listeners = new Set<() => void>();

function setState(patch: Partial<MeshNodesState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getMeshNodesState(): MeshNodesState {
  return state;
}

export function subscribeMeshNodes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅测试使用：直接注入一份状态。 */
export function setMeshNodesStateForTest(patch: Partial<MeshNodesState>): void {
  setState(patch);
}

export function resetMeshNodesStateForTest(): void {
  state = EMPTY_STATE;
  modePromise = null;
  inFlight = null;
  for (const listener of listeners) listener();
}

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
  const next = patchNodesWithEvent(state.nodes, event);
  if (next !== state.nodes) setState({ nodes: next });
}

let inFlight: Promise<void> | null = null;

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
    }
  })();
  return inFlight;
}

/**
 * 某台 node 登录成功后就地把它标成已登录，不必等下一次 `/api/mesh/nodes` 轮询。
 * `self` 按 entry 自身的 nodeId 解析；列表里没有这一行时什么都不做。
 */
export function markLoggedIn(nodeId: string): void {
  const target = nodeId === SELF_NODE_ID ? state.entryNodeId : nodeId;
  if (!target) return;
  let changed = false;
  const next = state.nodes.map((node) => {
    if (node.id !== target || node.loggedIn) return node;
    changed = true;
    return { ...node, loggedIn: true };
  });
  if (changed) setState({ nodes: next });
}

export function setEntryNodeId(nodeId: string | null): void {
  if (state.entryNodeId === nodeId) return;
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
}

export interface UseMeshNodesResult extends MeshNodesState {
  refresh: () => void;
}

const DEFAULT_POLL_MS = 30_000;

export function useMeshNodes(options: UseMeshNodesOptions = {}): UseMeshNodesResult {
  const enabled = options.enabled ?? true;
  const api = options.api ?? defaultAuthApi;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const snapshot = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void refreshMeshNodes(api);
  }, [api, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refreshMeshNodes(api);
    if (pollIntervalMs <= 0) return;
    const timer = setInterval(() => void refreshMeshNodes(api), pollIntervalMs);
    return () => clearInterval(timer);
  }, [api, enabled, pollIntervalMs]);

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
  error: string | null;
  refresh: () => void;
}

export interface UseHubNodeOptions {
  enabled?: boolean;
  /** 覆盖列表请求（测试注入）。 */
  probe?: (nodeId: string) => Promise<HubNodeRow[]>;
  /** `/api/auth/mode` 下发的 hub nodeId；mesh 列表还没到时用它。 */
  hubNodeId?: string | null;
  pollIntervalMs?: number;
}

/**
 * 定位 hub 机的 node（`isHub` / `mode.hubNodeId`）并拉取 `GET /n/<hub>/api/hub/nodes`。
 * 定位不到就直接判定 hub 不可达，**不再**逐个探测其它 node。
 */
export function useHubNode(nodes: MeshNode[], options: UseHubNodeOptions = {}): HubNodeState {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const [hubNodes, setHubNodes] = useState<HubNodeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolved = useMemo(
    () => findHubNodeId(nodes, options.hubNodeId),
    [nodes, options.hubNodeId]
  );
  const probe = options.probe;

  const loadHub = useCallback(
    async (isCancelled: () => boolean) => {
      if (!enabled || !resolved) {
        setHubNodes(null);
        return;
      }
      setLoading(true);
      try {
        const rows = probe ? await probe(resolved) : await new HubApi(resolved).listNodes();
        if (isCancelled()) return;
        setHubNodes(rows);
        setError(null);
      } catch (err) {
        if (isCancelled()) return;
        setHubNodes(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [enabled, probe, resolved]
  );

  useEffect(() => {
    let cancelled = false;
    void loadHub(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadHub]);

  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) return;
    let cancelled = false;
    const timer = setInterval(() => void loadHub(() => cancelled), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, loadHub]);

  const refresh = useCallback(() => void loadHub(() => false), [loadHub]);
  const hubApi = useMemo(() => (resolved ? new HubApi(resolved) : null), [resolved]);

  return {
    hubNodeId: resolved,
    hubApi,
    hubNodes,
    online: hubNodes !== null,
    loading,
    error,
    refresh,
  };
}
