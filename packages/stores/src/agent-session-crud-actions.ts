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
>;

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

function withoutKey<T>(
  record: Record<string, T | undefined>,
  key: string
): Record<string, T | undefined> {
  const next = { ...record };
  delete next[key];
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

function pruneSessionState(prev: AgentState, sessionId: string): Partial<AgentState> {
  return {
    ...withSessionOrder(withoutKey(prev.sessions, sessionId)),
    messages: withoutKey(prev.messages, sessionId),
    historyLoaded: withoutKey(prev.historyLoaded, sessionId),
    inProgress: withoutKey(prev.inProgress, sessionId),
    pendingConfirmations: withoutKey(prev.pendingConfirmations, sessionId),
    queued: withoutKey(prev.queued, sessionId),
  };
}

export function createAgentSessionCrudActions(
  deps: AgentSessionActionsDeps
): AgentSessionCrudActions {
  const { apiClient, notifications, set, get, subscribe, unsubscribe, clearSessionRuntime } = deps;

  // 列表拉取的 in-flight 去重：StrictMode 双 effect 与快速切 tab 会并发触发
  let loadingSessions: Promise<void> | null = null;

  function reportError(error: unknown): void {
    reportActionError(notifications, error);
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
      set((prev) => ({
        ...withSessionOrder(mergeFetchedSessions(before, prev.sessions, sessionList)),
        sessionsLoaded: true,
      }));
      // 持久化的 activeSessionId 可能已被别端删除
      const state = get();
      if (state.activeSessionId && !state.sessions[state.activeSessionId]) {
        state.setActiveSession(null);
      }
    } catch (error) {
      console.error('[agent] loadSessions failed:', error);
    }
  }

  return {
    ...createPatchActions(patchSession),

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

    setActiveSession(sessionId) {
      const previous = get().activeSessionId;
      if (previous === sessionId) return;

      if (previous) {
        unsubscribe(previous);
      }

      // 选中真实会话即退出草稿态
      set({ activeSessionId: sessionId, draft: null, materializingDraft: false });

      if (sessionId) {
        subscribe(sessionId);
        if (!get().historyLoaded[sessionId]) {
          void get().loadHistory(sessionId);
        }
      }
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
        if (get().activeSessionId === sessionId) {
          get().setActiveSession(null);
        }
        clearSessionRuntime(sessionId);
        set((prev) => pruneSessionState(prev, sessionId));
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
