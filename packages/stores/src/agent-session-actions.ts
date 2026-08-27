// 会话维度的 REST 动作：列表/元数据、消息发送与队列、确认决策、草稿生命周期。

import {
  type ApiClient,
  createAgentSession,
  decideAgentConfirmation,
  deleteAgentSession,
  editQueuedAgentMessage,
  enqueueAgentMessage,
  fetchAgentConfirmations,
  fetchAgentSession,
  fetchAgentSessions,
  sendAgentMessage,
  stopAgentSession,
  updateAgentSession,
  withdrawQueuedAgentMessage,
} from '@tmex/api-client';
import type { NotificationSink } from '@tmex/notifications';
import type { AgentSessionDto } from '@tmex/shared';
import type { AgentHistorySync } from './agent-history-sync';
import { mergeMessages } from './agent-history-sync';
import type {
  AgentActions,
  AgentGetState,
  AgentSetState,
  CreateSessionOptions,
  DraftSession,
} from './agent-state';

/** 按 updatedAt 倒序；同一时间戳用 id 升序兜底，保证比较函数反对称与排序稳定 */
export function sortSessionOrder(sessions: Record<string, AgentSessionDto | undefined>): string[] {
  return Object.values(sessions)
    .filter((session): session is AgentSessionDto => Boolean(session))
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })
    .map((session) => session.id);
}

/** 任何替换 sessions 的路径都必须经此重算 sessionOrder，否则新的 updatedAt 不会反映到列表顺序 */
function withSessionOrder(sessions: Record<string, AgentSessionDto | undefined>): {
  sessions: Record<string, AgentSessionDto | undefined>;
  sessionOrder: string[];
} {
  return { sessions, sessionOrder: sortSessionOrder(sessions) };
}

export interface AgentSessionActionsDeps {
  apiClient: ApiClient;
  notifications: NotificationSink;
  set: AgentSetState;
  get: AgentGetState;
  history: AgentHistorySync;
  /** 订阅该 session 的流式事件 */
  subscribe: (sessionId: string) => void;
  /** 取消订阅（未订阅时无副作用） */
  unsubscribe: (sessionId: string) => void;
  /** 清理该 session 的运行时缓冲（delta 缓冲、去抖定时器等） */
  clearSessionRuntime: (sessionId: string) => void;
}

export type AgentSessionActions = Omit<AgentActions, 'ensureInitialized'>;

export function createAgentSessionActions(deps: AgentSessionActionsDeps): AgentSessionActions {
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

  let draftSequence = 0;
  // 草稿物化的 in-flight 去重：同一草稿的并发调用共享同一个请求，避免重复建会话
  const materializing = new Map<string, Promise<AgentSessionDto | null>>();
  // 列表拉取的 in-flight 去重：StrictMode 双 effect 与快速切 tab 会并发触发，
  // 两个响应先后落盘时后到的旧响应会盖掉本地更新的会话状态
  let loadingSessions: Promise<void> | null = null;

  function reportError(error: unknown): void {
    notifications.error(error instanceof Error ? error.message : String(error));
  }

  /** 建会话并写入 store，但不改变当前激活会话（激活由调用方按新鲜度决定） */
  async function createSessionRequest(
    deviceId: string,
    paneId: string,
    options?: CreateSessionOptions
  ): Promise<AgentSessionDto | null> {
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
      reportError(error);
      return null;
    }
  }

  function syncMaterializingFlag(): void {
    const draftKey = get().draft?.key ?? null;
    const pending = draftKey !== null && materializing.has(draftKey);
    if (get().materializingDraft !== pending) {
      set({ materializingDraft: pending });
    }
  }

  async function materializeDraftRequest(draft: DraftSession): Promise<AgentSessionDto | null> {
    const session = await createSessionRequest(draft.deviceId, draft.paneId, {
      providerId: draft.providerId,
      modelId: draft.modelId,
      originPaneTitle: draft.paneTitle,
    });
    // 请求期间用户可能已切到新草稿或别的会话：过期结果只入库，不抢占当前选择
    if (session && get().draft?.key === draft.key) {
      // setActiveSession 内部清空草稿
      get().setActiveSession(session.id);
    }
    return session;
  }

  async function loadSessionsRequest(): Promise<void> {
    try {
      const sessionList = await fetchAgentSessions(apiClient);
      set(() => {
        const sessions: Record<string, AgentSessionDto> = {};
        for (const session of sessionList) {
          sessions[session.id] = session;
        }
        return { ...withSessionOrder(sessions), sessionsLoaded: true };
      });
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
      const session = await createSessionRequest(deviceId, paneId, options);
      if (session) {
        get().setActiveSession(session.id);
      }
      return session;
    },

    async renameSession(sessionId, title) {
      try {
        const session = await updateAgentSession(
          sessionId,
          { title },
          'Failed to rename agent session',
          apiClient
        );
        set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: session }));
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },

    async deleteSession(sessionId) {
      try {
        await deleteAgentSession(sessionId, apiClient);
        if (get().activeSessionId === sessionId) {
          get().setActiveSession(null);
        }
        clearSessionRuntime(sessionId);
        set((prev) => {
          const sessions = { ...prev.sessions };
          delete sessions[sessionId];
          const messages = { ...prev.messages };
          delete messages[sessionId];
          const historyLoaded = { ...prev.historyLoaded };
          delete historyLoaded[sessionId];
          const inProgress = { ...prev.inProgress };
          delete inProgress[sessionId];
          const pendingConfirmations = { ...prev.pendingConfirmations };
          delete pendingConfirmations[sessionId];
          const queued = { ...prev.queued };
          delete queued[sessionId];
          return {
            ...withSessionOrder(sessions),
            messages,
            historyLoaded,
            inProgress,
            pendingConfirmations,
            queued,
          };
        });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },

    async setWriteMode(sessionId, writeMode) {
      try {
        const session = await updateAgentSession(
          sessionId,
          { writeMode },
          'Failed to update write mode',
          apiClient
        );
        set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: session }));
      } catch (error) {
        reportError(error);
      }
    },

    async setAllowControlChars(sessionId, allow) {
      try {
        const session = await updateAgentSession(
          sessionId,
          { allowControlChars: allow },
          'Failed to update control chars setting',
          apiClient
        );
        set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: session }));
      } catch (error) {
        reportError(error);
      }
    },

    setDefaultWriteMode(writeMode) {
      set({ defaultWriteMode: writeMode });
    },

    async setSessionModel(sessionId, providerId, modelId) {
      try {
        const session = await updateAgentSession(
          sessionId,
          { providerId, modelId },
          'Failed to update model',
          apiClient
        );
        set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: session }));
      } catch (error) {
        reportError(error);
      }
    },

    async rebindPane(sessionId, paneId) {
      try {
        const session = await updateAgentSession(
          sessionId,
          { paneId },
          'Failed to rebind pane',
          apiClient
        );
        set((prev) => withSessionOrder({ ...prev.sessions, [sessionId]: session }));
      } catch (error) {
        reportError(error);
      }
    },

    loadHistory(sessionId) {
      return history.loadHistory(sessionId);
    },

    async sendMessage(sessionId, text) {
      set((prev) => ({ sending: { ...prev.sending, [sessionId]: true } }));
      try {
        const payload = await sendAgentMessage(sessionId, text, apiClient);
        // 运行中后端会入队（QUEUE_UPDATED 事件负责更新队列态），此处仅处理直接落库的消息
        if (payload.message) {
          const message = payload.message;
          set((prev) => {
            const session = prev.sessions[sessionId];
            return {
              messages: {
                ...prev.messages,
                [sessionId]: mergeMessages(prev.messages[sessionId], [message]),
              },
              ...(session
                ? withSessionOrder({
                    ...prev.sessions,
                    [sessionId]: { ...session, status: 'running', lastError: null },
                  })
                : {}),
            };
          });
        }
        return true;
      } catch (error) {
        reportError(error);
        return false;
      } finally {
        set((prev) => ({ sending: { ...prev.sending, [sessionId]: false } }));
      }
    },

    async enqueueMessage(sessionId, text, steer = false) {
      try {
        await enqueueAgentMessage(sessionId, text, steer, apiClient);
        // 队列态由 AGENT_EVENT_QUEUE_UPDATED 驱动；message（已落库）的情况由 WS 增量补史
      } catch (error) {
        reportError(error);
      }
    },

    async editQueuedMessage(_sessionId, itemId, text) {
      try {
        await editQueuedAgentMessage(itemId, text, apiClient);
      } catch (error) {
        reportError(error);
      }
    },

    async withdrawQueuedMessage(_sessionId, itemId) {
      try {
        await withdrawQueuedAgentMessage(itemId, apiClient);
      } catch (error) {
        reportError(error);
      }
    },

    startDraft(deviceId, paneId, paneTitle, prompt) {
      const previous = get().activeSessionId;
      if (previous) {
        unsubscribe(previous);
      }
      // 默认模型继承全局默认（modelId=null → 后端回退默认）；provider 同理
      draftSequence += 1;
      set({
        activeSessionId: null,
        materializingDraft: false,
        draft: {
          key: `draft-${draftSequence}`,
          deviceId,
          paneId,
          providerId: null,
          modelId: null,
          paneTitle,
          prompt: prompt ?? null,
        },
      });
    },

    updateDraft(patch) {
      set((prev) => (prev.draft ? { draft: { ...prev.draft, ...patch } } : prev));
    },

    clearDraft() {
      set({ draft: null, materializingDraft: false });
    },

    materializeDraft() {
      const draft = get().draft;
      if (!draft) return Promise.resolve(null);
      const inFlight = materializing.get(draft.key);
      if (inFlight) return inFlight;
      const pending = materializeDraftRequest(draft).finally(() => {
        materializing.delete(draft.key);
        syncMaterializingFlag();
      });
      materializing.set(draft.key, pending);
      syncMaterializingFlag();
      return pending;
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

    async decideConfirmation(sessionId, confirmationId, approved, reason) {
      const removeLocally = (): void => {
        set((prev) => {
          const list = prev.pendingConfirmations[sessionId];
          if (!list) return prev;
          return {
            pendingConfirmations: {
              ...prev.pendingConfirmations,
              [sessionId]: list.filter((confirmation) => confirmation.id !== confirmationId),
            },
          };
        });
      };

      try {
        const decided = await decideAgentConfirmation(confirmationId, approved, reason, apiClient);
        if (decided === 'conflict') {
          // 已被别端决定：静默刷新 pending 列表
          removeLocally();
          try {
            const confirmations = await fetchAgentConfirmations(sessionId, apiClient);
            set((prev) => ({
              pendingConfirmations: {
                ...prev.pendingConfirmations,
                [sessionId]: confirmations.map((confirmation) => ({
                  id: confirmation.id,
                  toolCallId: confirmation.toolCallId,
                  toolName: confirmation.toolName,
                  input: confirmation.input,
                  createdAt: confirmation.createdAt,
                })),
              },
            }));
          } catch {
            // 刷新失败不致命，CONFIRMATION_RESOLVED 事件会兜底
          }
          return;
        }
        removeLocally();
      } catch (error) {
        reportError(error);
      }
    },
  };
}
