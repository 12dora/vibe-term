// 侧边栏 agent 会话装饰的控制器：bootstrap、排序/分组派生、重命名与删除对话框状态。

import { toRuntimeNodeId, useMeshNodes } from '@/node/mesh-nodes';
import { selfAgentStore } from '@/node/self-agent-store';
import type { MeshNode } from '@tmex/api-client/auth/index';
import type { AgentSessionDto, StateSnapshotPayload } from '@tmex/shared';
import { isSessionOnNode, normalizeAgentNodeId } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/** 后端在 node 离线传播时写入会话的 lastError */
export const NODE_OFFLINE_ERROR = 'NODE_OFFLINE';

const PANE_KEY_SEPARATOR = '\u0000';

export function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}${PANE_KEY_SEPARATOR}${paneId}`;
}

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

export function groupSessionsByPane(
  ordered: readonly AgentSessionDto[]
): Map<string, AgentSessionDto[]> {
  const grouped = new Map<string, AgentSessionDto[]>();
  for (const session of ordered) {
    if (!session.deviceId || !session.paneId) continue;
    const key = paneKey(session.deviceId, session.paneId);
    const list = grouped.get(key);
    if (list) {
      list.push(session);
    } else {
      grouped.set(key, [session]);
    }
  }
  return grouped;
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
 * 该 node 是否离线。mesh 列表里没有这一行（standalone、列表尚未加载）一律按在线处理：
 * 宁可让用户点进去看到请求错误，也不要把本机会话灰掉。
 */
export function isNodeOffline(
  nodes: readonly MeshNode[],
  entryNodeId: string | null,
  runtimeNodeId: string
): boolean {
  const row = nodes.find((node) => toRuntimeNodeId(node.id, entryNodeId) === runtimeNodeId);
  return row ? !row.online : false;
}

/** 会话是否因所在 node 离线而暂停（灰显、不可点入） */
export function isSessionPaused(session: AgentSessionDto, nodeOffline: boolean): boolean {
  return nodeOffline || session.lastError === NODE_OFFLINE_ERROR;
}

/**
 * `enabled: false` 只读宿主级 mesh 快照：不发 `/api/mesh/*`、不订阅事件流
 * ——拉取与订阅是设备区自己的活。
 */
function useNodeOffline(runtimeNodeId: string): boolean {
  const { nodes, entryNodeId } = useMeshNodes({ enabled: false });
  return isNodeOffline(nodes, entryNodeId, runtimeNodeId);
}

export interface SidebarAgentSessionsContextValue {
  orderedSessions: AgentSessionDto[];
  sessionsByPane: ReadonlyMap<string, AgentSessionDto[]>;
  activeSessionId: string | null;
  /** 本分节所属 node（null 即 entry 自身）；新建会话与过滤都用它 */
  nodeId: string | null;
  /** 本分节所属 node 是否离线：行灰显且不可点入 */
  nodeOffline: boolean;
  sessionRenameCandidate: AgentSessionDto | null;
  sessionRenameValue: string;
  setSessionRenameValue: (value: string) => void;
  closeRenameDialog: () => void;
  confirmRenameSession: () => void;
  sessionDeleteCandidate: AgentSessionDto | null;
  closeDeleteDialog: () => void;
  confirmDeleteSession: () => void;
  requestRenameSession: (session: AgentSessionDto) => void;
  requestDeleteSession: (session: AgentSessionDto) => void;
}

export const SidebarAgentSessionsContext = createContext<SidebarAgentSessionsContextValue | null>(
  null
);

export function useSidebarAgentSessions(): SidebarAgentSessionsContextValue {
  const ctx = useContext(SidebarAgentSessionsContext);
  if (!ctx) {
    throw new Error('sidebarAgentAdapter must be used within SidebarAgentSessionsProvider');
  }
  return ctx;
}

export function useSidebarAgentSessionsController(): SidebarAgentSessionsContextValue {
  const runtime = useRuntime();
  // 会话状态一律来自 entry（self）网关，与本分节挂的是哪个 node 的运行时无关
  const agentStore = selfAgentStore();
  const nodeId = normalizeAgentNodeId(runtime.nodeId);
  const nodeOffline = useNodeOffline(runtime.nodeId);

  // AgentTab 挂载时也会拉列表，这里只在列表尚未加载过时兜底，避免切换侧边栏 tab 反复全量拉取
  useEffect(() => {
    const store = agentStore.getState();
    store.ensureInitialized();
    if (!store.sessionsLoaded) void store.loadSessions();
  }, [agentStore]);

  const sessions = agentStore((state) => state.sessions);
  const sessionOrder = agentStore((state) => state.sessionOrder);
  const activeSessionId = agentStore((state) => state.activeSessionId);

  // 单一列表按 node 过滤：本分节只展示绑在自己这个 node 上的会话，
  // 于是 isSessionAttached 比对的快照也一定是该会话所在 node 的快照。
  const orderedSessions = useMemo(
    () =>
      orderSessions(sessions, sessionOrder).filter((session) => isSessionOnNode(session, nodeId)),
    [sessions, sessionOrder, nodeId]
  );
  const sessionsByPane = useMemo(() => groupSessionsByPane(orderedSessions), [orderedSessions]);

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

  return useMemo(
    () => ({
      orderedSessions,
      sessionsByPane,
      activeSessionId,
      nodeId,
      nodeOffline,
      sessionRenameCandidate,
      sessionRenameValue,
      setSessionRenameValue,
      closeRenameDialog,
      confirmRenameSession,
      sessionDeleteCandidate,
      closeDeleteDialog,
      confirmDeleteSession,
      requestRenameSession,
      requestDeleteSession,
    }),
    [
      orderedSessions,
      sessionsByPane,
      activeSessionId,
      nodeId,
      nodeOffline,
      sessionRenameCandidate,
      sessionRenameValue,
      closeRenameDialog,
      confirmRenameSession,
      sessionDeleteCandidate,
      closeDeleteDialog,
      confirmDeleteSession,
      requestRenameSession,
      requestDeleteSession,
    ]
  );
}
