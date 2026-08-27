// 侧边栏 agent 会话装饰的控制器：bootstrap、排序/分组派生、重命名与删除对话框状态。

import type { AgentSessionDto, StateSnapshotPayload } from '@tmex/shared';
import { useAgentStore } from '@tmex/stores';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

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

export interface SidebarAgentSessionsContextValue {
  orderedSessions: AgentSessionDto[];
  sessionsByPane: ReadonlyMap<string, AgentSessionDto[]>;
  activeSessionId: string | null;
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
  // AgentTab 挂载时也会拉列表，这里只在列表尚未加载过时兜底，避免切换侧边栏 tab 反复全量拉取
  useEffect(() => {
    const store = useAgentStore.getState();
    store.ensureInitialized();
    if (!store.sessionsLoaded) void store.loadSessions();
  }, []);

  const sessions = useAgentStore((state) => state.sessions);
  const sessionOrder = useAgentStore((state) => state.sessionOrder);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);

  const orderedSessions = useMemo(
    () => orderSessions(sessions, sessionOrder),
    [sessions, sessionOrder]
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
    void useAgentStore.getState().renameSession(sessionRenameCandidate.id, trimmed);
    setSessionRenameCandidate(null);
  }, [sessionRenameCandidate, sessionRenameValue]);

  const requestDeleteSession = useCallback((session: AgentSessionDto) => {
    setSessionDeleteCandidate(session);
  }, []);

  const confirmDeleteSession = useCallback(() => {
    if (!sessionDeleteCandidate) return;
    void useAgentStore.getState().deleteSession(sessionDeleteCandidate.id);
    setSessionDeleteCandidate(null);
  }, [sessionDeleteCandidate]);

  const closeRenameDialog = useCallback(() => setSessionRenameCandidate(null), []);
  const closeDeleteDialog = useCallback(() => setSessionDeleteCandidate(null), []);

  return useMemo(
    () => ({
      orderedSessions,
      sessionsByPane,
      activeSessionId,
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
