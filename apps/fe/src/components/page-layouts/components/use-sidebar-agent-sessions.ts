// 侧边栏 agent 会话装饰的控制器：bootstrap、排序/分组派生、重命名与删除对话框状态。

import { useNodeOffline } from '@/node/node-offline';
import { selfAgentStore } from '@/node/self-agent-store';
import type { AgentSessionDto, StateSnapshotPayload } from '@tmex/shared';
import {
  activeSessionIdOnNode,
  isNodePaused,
  isSessionOnNode,
  normalizeAgentNodeId,
} from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import {
  type Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  for (const session of orderSessions(sessions, sessionOrder)) {
    if (!session.deviceId || !session.paneId) continue;
    if (!isSessionOnNode(session, nodeId)) continue;
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

export function collectKnownPaneIds(
  snapshots: Record<string, StateSnapshotPayload | undefined>
): Map<string, Set<string>> {
  const byDevice = new Map<string, Set<string>>();
  for (const [deviceId, snapshot] of Object.entries(snapshots)) {
    const windows = snapshot?.session?.windows;
    if (!windows) continue;
    const paneIds = new Set<string>();
    for (const window of windows) {
      for (const pane of window.panes) paneIds.add(pane.id);
    }
    byDevice.set(deviceId, paneIds);
  }
  return byDevice;
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
    useShallow((state) =>
      orderSessions(state.sessions, state.sessionOrder).filter((session) =>
        isSessionOnNode(session, nodeId)
      )
    )
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
