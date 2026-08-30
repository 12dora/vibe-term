// 会话生命周期动作：列表拉取、单会话刷新、激活切换、增删改元数据、停止运行。

import {
  type UpdateAgentSessionPatch,
  createAgentSession,
  deleteAgentSession,
  fetchAgentSession,
  fetchAgentSessions,
  stopAgentSession,
  updateAgentSession,
} from '@tmex/api-client';
import type { AgentSessionDto } from '@tmex/shared';
import { selectEvictableHistories } from './agent-history-budget';
import { agentNodeKey } from './agent-node-state';
import { type AgentSessionActionsDeps, reportActionError } from './agent-session-deps';
import { mergeFetchedSessions, withSessionOrder } from './agent-session-map';
import type { AgentActions, AgentState, CreateSessionOptions } from './agent-state';

export type AgentSessionCrudActions = Pick<
  AgentActions,
  | 'loadSessions'
  | 'refreshSession'
  | 'setActiveSession'
  | 'createSession'
  | 'renameSession'
  | 'deleteSession'
  | 'setWriteMode'
  | 'setAllowControlChars'
  | 'setDefaultWriteMode'
  | 'setSessionModel'
  | 'rebindPane'
  | 'stopSession'
> & {
  /** 按预算淘汰非活跃历史；除切换会话外，历史写回后也要跑一遍 */
  evictHistories: () => void;
};

/** 建会话并写入 store，但不改变当前激活会话（激活由调用方按新鲜度决定） */
export async function createSessionRequest(
  deps: AgentSessionActionsDeps,
  deviceId: string,
  paneId: string,
  options?: CreateSessionOptions
): Promise<AgentSessionDto | null> {
  const { apiClient, notifications, set, get } = deps;
  try {
    const session = await createAgentSession(
      {
        deviceId,
        paneId,
        ...(options?.nodeId ? { nodeId: options.nodeId } : {}),
        ...(options?.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options?.modelId !== undefined && options.modelId !== null
          ? { modelId: options.modelId }
          : {}),
        ...(options?.providerHostedTools !== undefined
          ? { providerHostedTools: options.providerHostedTools }
          : {}),
        ...(options?.originPaneTitle !== undefined
          ? { originPaneTitle: options.originPaneTitle }
          : {}),
        writeMode: options?.writeMode ?? get().defaultWriteMode,
      },
      apiClient
    );
    set((prev) => ({
      ...withSessionOrder({ ...prev.sessions, [session.id]: session }),
      messages: { ...prev.messages, [session.id]: [] },
      historyLoaded: { ...prev.historyLoaded, [session.id]: true },
    }));
    return session;
  } catch (error) {
    reportActionError(notifications, error);
    return null;
  }
}

function dropKeys<T>(
  record: Record<string, T | undefined>,
  keys: readonly string[]
): Record<string, T | undefined> {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

/** 元数据 PATCH 的公共外壳：写回单个会话并重排列表 */
type PatchSession = (
  sessionId: string,
  patch: UpdateAgentSessionPatch,
  errorFallback: string
) => Promise<AgentSessionDto | null>;

type AgentSessionPatchActions = Pick<
  AgentActions,
  'renameSession' | 'setWriteMode' | 'setAllowControlChars' | 'setSessionModel' | 'rebindPane'
>;

function createPatchActions(patchSession: PatchSession): AgentSessionPatchActions {
  return {
    async renameSession(sessionId, title) {
      const session = await patchSession(sessionId, { title }, 'Failed to rename agent session');
      return session !== null;
    },

    async setWriteMode(sessionId, writeMode) {
      await patchSession(sessionId, { writeMode }, 'Failed to update write mode');
    },

    async setAllowControlChars(sessionId, allow) {
      await patchSession(
        sessionId,
        { allowControlChars: allow },
        'Failed to update control chars setting'
      );
    },

    async setSessionModel(sessionId, providerId, modelId) {
      await patchSession(sessionId, { providerId, modelId }, 'Failed to update model');
    },

    async rebindPane(sessionId, paneId) {
      await patchSession(sessionId, { paneId }, 'Failed to rebind pane');
    },
  };
}

/** 把所有指向该会话的选中态清空并退订：会话被本端删除或被别端移除时调用。 */
function clearActiveSession(deps: AgentSessionActionsDeps, sessionId: string): void {
  const { set, get, unsubscribe } = deps;
  const current = get().activeSessionIdByNode;
  const next: Record<string, string | null> = {};
  let changed = false;
  for (const [key, id] of Object.entries(current)) {
    if (id === sessionId) {
      next[key] = null;
      changed = true;
    } else {
      next[key] = id;
    }
  }
  if (!changed) return;
  unsubscribe(sessionId);
  set({ activeSessionIdByNode: next });
}

/** 列表拉取后，清掉那些指向已不存在会话的选中态（被别端删除）。 */
function pruneMissingActiveSessions(deps: AgentSessionActionsDeps): void {
  const { set, get, unsubscribe } = deps;
  const state = get();
  const next: Record<string, string | null> = {};
  const stale: string[] = [];
  for (const [key, id] of Object.entries(state.activeSessionIdByNode)) {
    if (id && !state.sessions[id]) {
      next[key] = null;
      stale.push(id);
    } else {
      next[key] = id;
    }
  }
  if (stale.length === 0) return;
  for (const id of stale) unsubscribe(id);
  set({ activeSessionIdByNode: next });
}

function pruneSessionState(prev: AgentState, sessionIds: readonly string[]): Partial<AgentState> {
  return {
    ...withSessionOrder(dropKeys(prev.sessions, sessionIds)),
    messages: dropKeys(prev.messages, sessionIds),
    historyLoaded: dropKeys(prev.historyLoaded, sessionIds),
    inProgress: dropKeys(prev.inProgress, sessionIds),
    pendingConfirmations: dropKeys(prev.pendingConfirmations, sessionIds),
    queued: dropKeys(prev.queued, sessionIds),
  };
}

export function createAgentSessionCrudActions(
  deps: AgentSessionActionsDeps
): AgentSessionCrudActions {
  const {
    apiClient,
    notifications,
    set,
    get,
    history,
    subscribe,
    unsubscribe,
    clearSessionRuntime,
  } = deps;

  // 列表拉取的 in-flight 去重：StrictMode 双 effect 与快速切 tab 会并发触发
  let loadingSessions: Promise<void> | null = null;
  // 最近激活在前：非活跃会话的历史按此顺序淘汰
  const recentSessions: string[] = [];

  function reportError(error: unknown): void {
    reportActionError(notifications, error);
  }

  function forgetRecent(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const index = recentSessions.indexOf(sessionId);
      if (index >= 0) recentSessions.splice(index, 1);
    }
  }

  /** 会话已不存在（本端删除或别端删除）时的统一清理；订阅只存在于选中会话，由选中态清理负责退订 */
  function forgetSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    for (const sessionId of sessionIds) clearSessionRuntime(sessionId);
    forgetRecent(sessionIds);
    set((prev) => pruneSessionState(prev, sessionIds));
  }

  /** 清空超出预算的非活跃历史；historyLoaded 一并复位，重新打开时全量重拉 */
  function evictHistories(): void {
    const evicted = selectEvictableHistories(get(), recentSessions);
    if (evicted.length === 0) return;
    // 在途的历史请求令牌一并作废，否则其响应会把半截历史写回来
    for (const sessionId of evicted) history.clearSession(sessionId);
    forgetRecent(evicted);
    set((prev) => ({
      messages: dropKeys(prev.messages, evicted),
      historyLoaded: dropKeys(prev.historyLoaded, evicted),
    }));
  }

  const patchSession: PatchSession = async (sessionId, patch, errorFallback) => {
    try {
      const session = await updateAgentSession(sessionId, patch, errorFallback, apiClient);
      set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: session }));
      return session;
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  async function loadSessionsRequest(): Promise<void> {
    // 请求发起时的快照：与响应落盘时的 sessions 逐条比对，判定在途期间的本地写入
    const before = get().sessions;
    try {
      const sessionList = await fetchAgentSessions(apiClient);
      const previous = get().sessions;
      set((prev) => ({
        ...withSessionOrder(mergeFetchedSessions(before, prev.sessions, sessionList)),
        sessionsLoaded: true,
      }));
      // 持久化的选中会话可能已被别端删除
      pruneMissingActiveSessions(deps);
      // 别端删除的会话走与本端删除相同的清理，否则历史/队列态会一直留在内存里
      const current = get().sessions;
      forgetSessions(Object.keys(previous).filter((id) => previous[id] && !current[id]));
    } catch (error) {
      console.error('[agent] loadSessions failed:', error);
    }
  }

  return {
    ...createPatchActions(patchSession),
    evictHistories,

    loadSessions() {
      if (loadingSessions) return loadingSessions;
      const pending = loadSessionsRequest().finally(() => {
        if (loadingSessions === pending) loadingSessions = null;
      });
      loadingSessions = pending;
      return pending;
    },

    async refreshSession(sessionId) {
      try {
        const refreshed = await fetchAgentSession(sessionId, apiClient);
        if (refreshed === null) {
          // session 已被别端删除，回退全量刷新走统一清理逻辑
          await get().loadSessions();
          return;
        }
        set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: refreshed }));
      } catch (error) {
        console.error('[agent] refreshSession failed:', error);
      }
    },

    setActiveSession(sessionId, nodeId) {
      const state = get();
      const session = sessionId ? state.sessions[sessionId] : undefined;
      const key = agentNodeKey(session ? session.nodeId : nodeId);
      const previous = state.activeSessionIdByNode[key] ?? null;
      if (previous === sessionId) return;

      if (previous) {
        unsubscribe(previous);
      }

      // 选中真实会话即退出该 node 的草稿态；别的 node 的选择与草稿原样保留
      set((prev) => ({
        activeSessionIdByNode: { ...prev.activeSessionIdByNode, [key]: sessionId },
        draftByNode: { ...prev.draftByNode, [key]: null },
        materializingDraftByNode: { ...prev.materializingDraftByNode, [key]: false },
      }));

      if (sessionId) {
        subscribe(sessionId);
        const index = recentSessions.indexOf(sessionId);
        if (index >= 0) recentSessions.splice(index, 1);
        recentSessions.unshift(sessionId);
        if (!get().historyLoaded[sessionId]) {
          void get().loadHistory(sessionId);
        }
      }
      evictHistories();
    },

    async createSession(deviceId, paneId, options) {
      const session = await createSessionRequest(deps, deviceId, paneId, options);
      if (session) {
        get().setActiveSession(session.id);
      }
      return session;
    },

    async deleteSession(sessionId) {
      try {
        await deleteAgentSession(sessionId, apiClient);
        clearActiveSession(deps, sessionId);
        forgetSessions([sessionId]);
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },

    setDefaultWriteMode(writeMode) {
      set({ defaultWriteMode: writeMode });
    },

    async stopSession(sessionId) {
      try {
        const stopped = await stopAgentSession(sessionId, apiClient);
        if (stopped) {
          set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: stopped }));
        }
      } catch (error) {
        reportError(error);
      }
    },
  };
}
