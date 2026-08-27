// mesh 节点视图：`GET /api/mesh/nodes` 的宿主级单例 store + `/mesh/ws` NODE_EVENT 实时投影
// + hub 机 node 的发现与 `GET /n/<hub>/api/hub/nodes` 合并。
//
// 为什么不用 react-query：这份列表是**入口级**的（永远打 entry 自身，不带 `/n/:id` 前缀），
// 而侧边栏/设备页可能挂在任意 node 的 QueryClient 下——放进某个 node 的缓存会在切 node 时
// 重复拉取，也拿不到跨边界的实时事件。用一个模块级 store + useSyncExternalStore 更直接。

import { SELF_NODE_ID } from '@tmex/api-client';
import type { AuthApi, AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { bytesToHex, decodeBase64url, sha256 } from '@tmex/shared/auth';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
      inventory: event.inventory ?? node.inventory,
      version: versionOf(event.inventory) ?? node.version,
    } satisfies MeshNode;
  });
  return changed ? next : nodes;
}

function versionOf(inventory: unknown): string | null {
  if (!inventory || typeof inventory !== 'object') return null;
  const value = (inventory as { version?: unknown }).version;
  return typeof value === 'string' ? value : null;
}

/** entry 自身排第一，其余按名称排序（在线优先）。 */
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
  reach: 'lan' | 'relay' | null;
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

function reachOf(reach: string | null): 'lan' | 'relay' | null {
  return reach === 'lan' || reach === 'relay' ? reach : null;
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
      version: node.version ?? hub?.version ?? null,
      directCapable: node.direct_capable || (hub?.direct_capable ?? false),
      loggedIn: node.loggedIn,
      inventory: node.inventory ?? null,
      isSelf: context.entryNodeId != null && node.id === context.entryNodeId,
      isHub: context.hubNodeId != null && node.id === context.hubNodeId,
      lastSeenAt: hub?.last_seen_at ?? null,
      status: hub?.status ?? null,
      certificate: hub?.certificate ?? null,
      certSig: hub?.cert_sig ?? null,
    };
  });
}

/**
 * hub 机 node 的候选顺序（契约里没有 hub 标志位时的启发式，见任务书）：
 * 1. inventory 显式标了 hub 角色的 node；
 * 2. entry 自身（hub,node 同机是默认部署形态，一次本地请求就能确定）；
 * 3. 其余 `reach !== null` 的在线 node。
 */
export function hubCandidates(nodes: MeshNode[], entryNodeId: string | null): string[] {
  const flagged: string[] = [];
  const rest: string[] = [];
  for (const node of nodes) {
    if (inventoryMarksHub(node.inventory)) flagged.push(node.id);
  }
  const selfNode = entryNodeId ? nodes.find((node) => node.id === entryNodeId) : undefined;
  if (selfNode && !flagged.includes(selfNode.id)) rest.push(selfNode.id);
  for (const node of nodes) {
    if (flagged.includes(node.id) || rest.includes(node.id)) continue;
    if (node.online && reachOf(node.reach) !== null) rest.push(node.id);
  }
  return [...flagged, ...rest];
}

function inventoryMarksHub(inventory: unknown): boolean {
  if (!inventory || typeof inventory !== 'object') return false;
  const record = inventory as { hub?: unknown; roles?: unknown };
  if (record.hub === true) return true;
  if (typeof record.roles === 'string') {
    return record.roles.split(',').some((role) => role.trim() === 'hub');
  }
  if (Array.isArray(record.roles)) {
    return record.roles.some((role) => role === 'hub');
  }
  return false;
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
  /** 覆盖候选探测（测试注入）。 */
  probe?: (nodeId: string) => Promise<HubNodeRow[]>;
  /** 已知 hub nodeId 时跳过探测。 */
  hubNodeId?: string | null;
  pollIntervalMs?: number;
}

/**
 * 发现 hub 机的 node 并拉取 `GET /n/<hub>/api/hub/nodes`。
 * 契约里没有 hub 标志位，按 `hubCandidates()` 的顺序逐个探测，第一个 200 的即为 hub。
 */
export function useHubNode(
  nodes: MeshNode[],
  entryNodeId: string | null,
  options: UseHubNodeOptions = {}
): HubNodeState {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const [resolved, setResolved] = useState<string | null>(options.hubNodeId ?? null);
  const [hubNodes, setHubNodes] = useState<HubNodeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () => (options.hubNodeId ? [options.hubNodeId] : hubCandidates(nodes, entryNodeId)),
    [nodes, entryNodeId, options.hubNodeId]
  );
  const probe = options.probe;
  // 已确定过的 hub 只影响探测顺序，不该成为「重新探测」的触发条件，因此走 ref 而不是依赖。
  const resolvedRef = useRef<string | null>(resolved);
  resolvedRef.current = resolved;

  const probeHub = useCallback(
    async (isCancelled: () => boolean) => {
      if (!enabled || candidates.length === 0) {
        setHubNodes(null);
        return;
      }
      setLoading(true);
      const previous = resolvedRef.current;
      const ordered = previous
        ? [previous, ...candidates.filter((id) => id !== previous)]
        : candidates;
      let lastError: string | null = null;
      for (const nodeId of ordered) {
        try {
          const rows = probe ? await probe(nodeId) : await new HubApi(nodeId).listNodes();
          if (isCancelled()) return;
          setResolved(nodeId);
          setHubNodes(rows);
          setError(null);
          setLoading(false);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (isCancelled()) return;
      setHubNodes(null);
      setError(lastError);
      setLoading(false);
    },
    [candidates, enabled, probe]
  );

  useEffect(() => {
    let cancelled = false;
    void probeHub(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [probeHub]);

  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) return;
    let cancelled = false;
    const timer = setInterval(() => void probeHub(() => cancelled), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, probeHub]);

  const refresh = useCallback(() => void probeHub(() => false), [probeHub]);
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
