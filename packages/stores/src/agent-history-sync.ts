// 历史消息增量同步：REST 增量拉取、去抖调度、in-flight 去重与补跑、stale 流式段清理。

import { type ApiClient, fetchAgentMessages } from '@tmex/api-client';
import type { AgentMessageDto } from '@tmex/shared';
import type { AgentDataGetState, AgentDataSetState } from './agent-state';
import { maxMessageSeq } from './agent-thread';

// MESSAGE_PERSISTED 触发的增量拉取去抖
export const HISTORY_FETCH_DEBOUNCE_MS = 120;

export function mergeMessages(
  existing: AgentMessageDto[] | undefined,
  incoming: AgentMessageDto[]
): AgentMessageDto[] {
  if (!existing || existing.length === 0) {
    return [...incoming].sort((a, b) => a.seq - b.seq);
  }
  const bySeq = new Map<number, AgentMessageDto>();
  for (const message of existing) {
    bySeq.set(message.seq, message);
  }
  for (const message of incoming) {
    bySeq.set(message.seq, message);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface AgentHistorySyncDeps {
  apiClient: ApiClient;
  set: AgentDataSetState;
  get: AgentDataGetState;
  debounceMs?: number;
}

export interface AgentHistorySync {
  loadHistory(sessionId: string): Promise<void>;
  /** 去抖调度一次增量拉取；同一 session 的待触发定时器只保留一个 */
  scheduleFetch(sessionId: string): void;
  clearSession(sessionId: string): void;
}

export function createAgentHistorySync(deps: AgentHistorySyncDeps): AgentHistorySync {
  const { apiClient, set, get } = deps;
  const debounceMs = deps.debounceMs ?? HISTORY_FETCH_DEBOUNCE_MS;

  const fetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const loadingSessions = new Set<string>();
  // in-flight 期间又有新的 loadHistory 请求：标记完成后重跑，避免丢增量
  const reloadPending = new Set<string>();

  async function loadHistory(sessionId: string): Promise<void> {
    if (loadingSessions.has(sessionId)) {
      // in-flight 期间的新请求不能直接丢弃：响应可能不含本次触发对应的增量
      reloadPending.add(sessionId);
      return;
    }
    loadingSessions.add(sessionId);
    try {
      const state = get();
      const afterSeq = state.historyLoaded[sessionId]
        ? maxMessageSeq(state.messages[sessionId])
        : -1;
      const messageList = await fetchAgentMessages(sessionId, afterSeq, apiClient);
      set((prev) => {
        const merged = mergeMessages(
          afterSeq >= 0 ? prev.messages[sessionId] : undefined,
          messageList
        );
        const current = prev.inProgress[sessionId];
        // 已落库内容对应的 stale 流式段在此处清除
        const inProgress = current
          ? {
              texts: current.texts.filter((segment) => !segment.stale),
              reasonings: current.reasonings.filter((segment) => !segment.stale),
              toolCalls: current.toolCalls.filter((call) => !call.stale),
              staleBarrier: false,
            }
          : current;
        return {
          messages: { ...prev.messages, [sessionId]: merged },
          historyLoaded: { ...prev.historyLoaded, [sessionId]: true },
          inProgress: inProgress
            ? { ...prev.inProgress, [sessionId]: inProgress }
            : prev.inProgress,
        };
      });
    } catch (error) {
      console.error('[agent] loadHistory failed:', error);
    } finally {
      loadingSessions.delete(sessionId);
      if (reloadPending.delete(sessionId)) {
        void loadHistory(sessionId);
      }
    }
  }

  return {
    loadHistory,
    scheduleFetch(sessionId) {
      const existing = fetchTimers.get(sessionId);
      if (existing) return;
      fetchTimers.set(
        sessionId,
        setTimeout(() => {
          fetchTimers.delete(sessionId);
          void loadHistory(sessionId);
        }, debounceMs)
      );
    },
    clearSession(sessionId) {
      const timer = fetchTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        fetchTimers.delete(sessionId);
      }
      reloadPending.delete(sessionId);
    },
  };
}
