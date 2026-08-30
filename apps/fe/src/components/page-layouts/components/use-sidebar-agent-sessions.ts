// 侧边栏 agent 会话装饰的控制器：bootstrap、排序/分组派生、重命名与删除对话框状态。

import { useNodeOffline } from '@/node/node-offline';
import { selfAgentStore } from '@/node/self-agent-store';
import type { AgentSessionDto, StateSnapshotPayload, TmuxWindow } from '@tmex/shared';
import {
  activeSessionIdOnNode,
  isNodePaused,
  isSessionOnNode,
  normalizeAgentNodeId,
} from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import {
  type Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';

/** updatedAt 倒序；同一时间戳按 id 升序兜底，保证比较函数反对称与排序稳定 */
export function compareSessions(a: AgentSessionDto, b: AgentSessionDto): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** store 的 sessionOrder 是排序真相源；不在其中的会话按同一规则排序后补在末尾 */
export function orderSessions(
  sessions: Record<string, AgentSessionDto | undefined>,
  sessionOrder: readonly string[]
): AgentSessionDto[] {
  const remaining = new Map<string, AgentSessionDto>();
  for (const [id, session] of Object.entries(sessions)) {
    if (session) remaining.set(id, session);
  }
  const ordered: AgentSessionDto[] = [];
  for (const id of sessionOrder) {
    const session = remaining.get(id);
    if (!session) continue;
    remaining.delete(id);
    ordered.push(session);
  }
  if (remaining.size > 0) {
    ordered.push(...[...remaining.values()].sort(compareSessions));
  }
  return ordered;
}

const PANE_KEY_SEPARATOR = '\u0000';
const NO_SESSIONS: AgentSessionDto[] = [];

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}${PANE_KEY_SEPARATOR}${paneId}`;
}

/** 一份 sessions + sessionOrder 的排序结果：分组与孤立会话区共用，排一次就够 */
const orderedCache = new WeakMap<
  object,
  { order: readonly string[]; ordered: readonly AgentSessionDto[] }
>();

function orderedSessions(
  sessions: Record<string, AgentSessionDto | undefined>,
  sessionOrder: readonly string[]
): readonly AgentSessionDto[] {
  const cached = orderedCache.get(sessions);
  if (cached && cached.order === sessionOrder) return cached.ordered;
  const ordered = orderSessions(sessions, sessionOrder);
  orderedCache.set(sessions, { order: sessionOrder, ordered });
  return ordered;
}

/** 本 node 的有序会话列表，按 node 各缓存一份：孤立会话区常驻挂载，每次 store 变更都要它 */
const nodeSessionsCache = new WeakMap<
  object,
  Map<string, { order: readonly string[]; list: AgentSessionDto[] }>
>();

/** 本 node 上的全部会话，顺序与整表一致 */
export function sessionsOnNode(
  sessions: Record<string, AgentSessionDto | undefined>,
  sessionOrder: readonly string[],
  nodeId: string | null
): AgentSessionDto[] {
  let byNode = nodeSessionsCache.get(sessions);
  if (!byNode) {
    byNode = new Map();
    nodeSessionsCache.set(sessions, byNode);
  }
  const cacheKey = nodeId ?? '';
  const cached = byNode.get(cacheKey);
  if (cached && cached.order === sessionOrder) return cached.list;
  const list = orderedSessions(sessions, sessionOrder).filter((session) =>
    isSessionOnNode(session, nodeId)
  );
  byNode.set(cacheKey, { order: sessionOrder, list });
  return list;
}

/**
 * 一份 sessions + sessionOrder 下按 pane 的分组，按 node 各缓存一份：
 * 每个 pane 的选择器都要这份结果，重算一次就够，之后各自 O(1) 取自己那格。
 */
const paneGroupCache = new WeakMap<
  object,
  Map<string, { order: readonly string[]; grouped: Map<string, AgentSessionDto[]> }>
>();

function groupSessionsByPane(
  sessions: Record<string, AgentSessionDto | undefined>,
  sessionOrder: readonly string[],
  nodeId: string | null
): Map<string, AgentSessionDto[]> {
  let byNode = paneGroupCache.get(sessions);
  if (!byNode) {
    byNode = new Map();
    paneGroupCache.set(sessions, byNode);
  }
  const cacheKey = nodeId ?? '';
  const cached = byNode.get(cacheKey);
  if (cached && cached.order === sessionOrder) return cached.grouped;

  const grouped = new Map<string, AgentSessionDto[]>();
  for (const session of sessionsOnNode(sessions, sessionOrder, nodeId)) {
    if (!session.deviceId || !session.paneId) continue;
    const key = paneKey(session.deviceId, session.paneId);
    const list = grouped.get(key);
    if (list) list.push(session);
    else grouped.set(key, [session]);
  }
  byNode.set(cacheKey, { order: sessionOrder, grouped });
  return grouped;
}

/** 本 node 上挂在该 pane 的会话，顺序与整表一致 */
export function sessionsForPane(
  sessions: Record<string, AgentSessionDto | undefined>,
  sessionOrder: readonly string[],
  nodeId: string | null,
  deviceId: string,
  paneId: string
): AgentSessionDto[] {
  return (
    groupSessionsByPane(sessions, sessionOrder, nodeId).get(paneKey(deviceId, paneId)) ??
    NO_SESSIONS
  );
}

/** 单个设备的 pane 集合，按该设备 windows 数组的引用缓存，同一份 windows 不重扫 */
const devicePaneIdsCache = new WeakMap<object, ReadonlySet<string>>();

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function scanPaneIds(windows: readonly TmuxWindow[]): ReadonlySet<string> {
  const cached = devicePaneIdsCache.get(windows);
  if (cached) return cached;
  const paneIds = new Set<string>();
  for (const window of windows) {
    for (const pane of window.panes) paneIds.add(pane.id);
  }
  devicePaneIdsCache.set(windows, paneIds);
  return paneIds;
}

export type KnownPaneIdsCollector = (
  snapshots: Record<string, StateSnapshotPayload | undefined>
) => ReadonlyMap<string, ReadonlySet<string>>;

/**
 * 建一个「各设备当前存活的 pane id」的选择器（快照未到达的设备不入表，见 `isSessionAttached`）。
 *
 * 孤立会话区常驻挂载且订阅整张 snapshots 表，而改标题/改 cwd 这类 metadata-patch 极其频繁——
 * 它们只换快照对象，pane 结构原封不动。所以这里逐层复用引用：windows 数组没换就不重扫；
 * 扫出来的 pane 集合与上次内容相同就交还上次那个 Set；每个设备都复用则整张表也交还上次那个
 * Map。于是无关的 metadata 事件在选择器处就被 Object.is 拦掉，不再触发重算与重渲染。
 *
 * 「上一次结果」必须随挂载点走，不能做成模块级单例：聚合侧边栏每个 node 分节各挂一份 tmux
 * store，共用一份缓存会被彼此的快照来回冲掉（设备集合不同则 `sameAsLast` 永远为假），
 * 于是两个分节交替执行时谁都拿不到稳定引用，复用直接失效。
 */
export function createKnownPaneIdsCollector(): KnownPaneIdsCollector {
  /** 一份 snapshots 映射对应的合并结果：同一引用重复调用（多次渲染）直接命中 */
  const bySnapshots = new WeakMap<object, ReadonlyMap<string, ReadonlySet<string>>>();
  const lastPaneIdsByDevice = new Map<string, ReadonlySet<string>>();
  let lastKnownPaneIds: ReadonlyMap<string, ReadonlySet<string>> = new Map();

  const sameAsLast = (byDevice: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
    if (byDevice.size !== lastKnownPaneIds.size) return false;
    for (const [deviceId, panes] of byDevice) {
      if (lastKnownPaneIds.get(deviceId) !== panes) return false;
    }
    return true;
  };

  return (snapshots) => {
    const cached = bySnapshots.get(snapshots);
    if (cached) return cached;

    const byDevice = new Map<string, ReadonlySet<string>>();
    for (const [deviceId, snapshot] of Object.entries(snapshots)) {
      const windows = snapshot?.session?.windows;
      if (!windows) continue;
      const paneIds = scanPaneIds(windows);
      const previous = lastPaneIdsByDevice.get(deviceId);
      byDevice.set(deviceId, previous && sameIds(previous, paneIds) ? previous : paneIds);
    }

    const result = sameAsLast(byDevice) ? lastKnownPaneIds : byDevice;
    // 设备下线后其条目一并淘汰，缓存不随时间膨胀
    lastPaneIdsByDevice.clear();
    for (const [deviceId, panes] of result) lastPaneIdsByDevice.set(deviceId, panes);
    lastKnownPaneIds = result;
    bySnapshots.set(snapshots, result);
    return result;
  };
}

/**
 * 本分节所属 node 的 pane 索引。缓存挂在本次挂载上（`useRef`），因此同一 node 的连续更新
 * 能复用引用，而别的 node 分节各有各的一份，互不冲刷。
 */
export function useKnownPaneIds(): ReadonlyMap<string, ReadonlySet<string>> {
  const collectorRef = useRef<KnownPaneIdsCollector | null>(null);
  collectorRef.current ??= createKnownPaneIdsCollector();
  const collect = collectorRef.current;
  return useTmuxStore((state) => collect(state.snapshots));
}

/**
 * 会话是否仍挂在某个存活 pane 上；否则归入孤立会话区，避免 pane 被关掉后会话从侧边栏消失。
 * 设备快照尚未加载（设备离线/未订阅）时按「仍挂载」处理，防止快照到达前后在孤立区闪现。
 * devicesReady 为 false（设备列表 pending/失败）时 knownDeviceIds 为空，此时不做设备存在性判定，
 * 否则加载中所有绑定会话都会被误判为孤立，请求失败时更会永久误判。
 *
 * 传入的会话已按 node 过滤（见控制器），因此这里比对的快照/设备一定属于该会话所在的 node，
 * 不会拿当前路由 node 的快照去判定别的 node 上的会话。
 */
export function isSessionAttached(
  session: AgentSessionDto,
  knownDeviceIds: ReadonlySet<string>,
  panesByDevice: ReadonlyMap<string, ReadonlySet<string>>,
  devicesReady: boolean
): boolean {
  if (!session.deviceId || !session.paneId) return false;
  if (!devicesReady) return true;
  if (!knownDeviceIds.has(session.deviceId)) return false;
  const panes = panesByDevice.get(session.deviceId);
  if (!panes) return true;
  return panes.has(session.paneId);
}

/**
 * 会话是否因所在 node 离线而暂停（灰显、不可点入）。与 agent 面板同一套三态语义：
 * mesh 在线态是权威信号，node 回来后残留的 NODE_OFFLINE 不再永久禁用该会话。
 */
export function isSessionPaused(
  session: AgentSessionDto,
  nodeOffline: boolean | undefined
): boolean {
  return isNodePaused(nodeOffline, session.lastError);
}

/** 分节级的稳定值：会话变动不改它的引用，行菜单据此免于跟着列表重渲染 */
export interface SidebarAgentCommands {
  /** 本分节所属 node 是否离线（`undefined` 即 mesh 状态未知）：行灰显且不可点入 */
  nodeOffline: boolean | undefined;
  requestRenameSession: (session: AgentSessionDto) => void;
  requestDeleteSession: (session: AgentSessionDto) => void;
}

/** 对话框状态只有 AgentSessionDialogs 消费，单独成 context，开关对话框不惊动会话行 */
export interface SidebarAgentDialogsState {
  sessionRenameCandidate: AgentSessionDto | null;
  sessionRenameValue: string;
  setSessionRenameValue: (value: string) => void;
  closeRenameDialog: () => void;
  confirmRenameSession: () => void;
  sessionDeleteCandidate: AgentSessionDto | null;
  closeDeleteDialog: () => void;
  confirmDeleteSession: () => void;
}

export const SidebarAgentCommandsContext = createContext<SidebarAgentCommands | null>(null);
export const SidebarAgentDialogsContext = createContext<SidebarAgentDialogsState | null>(null);

function useProvided<T>(context: Context<T | null>): T {
  const value = useContext(context);
  if (!value) {
    throw new Error('sidebarAgentAdapter must be used within SidebarAgentSessionsProvider');
  }
  return value;
}

export function useSidebarAgentCommands(): SidebarAgentCommands {
  return useProvided(SidebarAgentCommandsContext);
}

export function useSidebarAgentDialogs(): SidebarAgentDialogsState {
  return useProvided(SidebarAgentDialogsContext);
}

// 会话状态一律来自 entry（self）网关，与本分节挂的是哪个 node 的运行时无关
function useSessionNodeId(): string | null {
  return normalizeAgentNodeId(useRuntime().nodeId);
}

/** 单个 pane 的会话列表：内容不变就保持数组引用，本 pane 之外的更新不会重渲染这一支 */
export function useSessionsForPane(deviceId: string, paneId: string): AgentSessionDto[] {
  const nodeId = useSessionNodeId();
  return selfAgentStore()(
    useShallow((state) =>
      sessionsForPane(state.sessions, state.sessionOrder, nodeId, deviceId, paneId)
    )
  );
}

/** 本 node 上的全部会话（孤立会话区用；只有那一个组件订阅整表） */
export function useNodeSessions(): AgentSessionDto[] {
  const nodeId = useSessionNodeId();
  return selfAgentStore()(
    useShallow((state) => sessionsOnNode(state.sessions, state.sessionOrder, nodeId))
  );
}

export function useActiveSessionId(): string | null {
  const nodeId = useSessionNodeId();
  return selfAgentStore()((state) => activeSessionIdOnNode(state, nodeId));
}

export function useSidebarAgentSessionsController(): {
  commands: SidebarAgentCommands;
  dialogs: SidebarAgentDialogsState;
} {
  const runtime = useRuntime();
  const agentStore = selfAgentStore();
  const nodeOffline = useNodeOffline(runtime.nodeId);

  // AgentTab 挂载时也会拉列表，这里只在列表尚未加载过时兜底，避免切换侧边栏 tab 反复全量拉取
  useEffect(() => {
    const store = agentStore.getState();
    store.ensureInitialized();
    if (!store.sessionsLoaded) void store.loadSessions();
  }, [agentStore]);

  const [sessionRenameCandidate, setSessionRenameCandidate] = useState<AgentSessionDto | null>(
    null
  );
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [sessionDeleteCandidate, setSessionDeleteCandidate] = useState<AgentSessionDto | null>(
    null
  );

  const requestRenameSession = useCallback((session: AgentSessionDto) => {
    setSessionRenameValue(session.title);
    setSessionRenameCandidate(session);
  }, []);

  const confirmRenameSession = useCallback(() => {
    if (!sessionRenameCandidate) return;
    const trimmed = sessionRenameValue.trim();
    if (!trimmed) return;
    void agentStore.getState().renameSession(sessionRenameCandidate.id, trimmed);
    setSessionRenameCandidate(null);
  }, [agentStore, sessionRenameCandidate, sessionRenameValue]);

  const requestDeleteSession = useCallback((session: AgentSessionDto) => {
    setSessionDeleteCandidate(session);
  }, []);

  const confirmDeleteSession = useCallback(() => {
    if (!sessionDeleteCandidate) return;
    void agentStore.getState().deleteSession(sessionDeleteCandidate.id);
    setSessionDeleteCandidate(null);
  }, [agentStore, sessionDeleteCandidate]);

  const closeRenameDialog = useCallback(() => setSessionRenameCandidate(null), []);
  const closeDeleteDialog = useCallback(() => setSessionDeleteCandidate(null), []);

  const commands = useMemo(
    () => ({ nodeOffline, requestRenameSession, requestDeleteSession }),
    [nodeOffline, requestRenameSession, requestDeleteSession]
  );

  const dialogs = useMemo(
    () => ({
      sessionRenameCandidate,
      sessionRenameValue,
      setSessionRenameValue,
      closeRenameDialog,
      confirmRenameSession,
      sessionDeleteCandidate,
      closeDeleteDialog,
      confirmDeleteSession,
    }),
    [
      sessionRenameCandidate,
      sessionRenameValue,
      closeRenameDialog,
      confirmRenameSession,
      sessionDeleteCandidate,
      closeDeleteDialog,
      confirmDeleteSession,
    ]
  );

  return { commands, dialogs };
}
