// 消息域动作：历史加载、直发消息、队列消息的入队/编辑/撤回。

import {
  editQueuedAgentMessage,
  enqueueAgentMessage,
  sendAgentMessage,
  withdrawQueuedAgentMessage,
} from '@tmex/api-client';
import type { AgentMessageDto } from '@tmex/shared';
import { mergeMessages } from './agent-history-sync';
import { type AgentSessionActionsDeps, reportActionError } from './agent-session-deps';
import { withSessionOrder } from './agent-session-map';
import type { AgentActions, AgentState } from './agent-state';

export type AgentSessionMessageActions = Pick<
  AgentActions,
  'loadHistory' | 'sendMessage' | 'enqueueMessage' | 'editQueuedMessage' | 'withdrawQueuedMessage'
>;

function applySentMessage(
  prev: AgentState,
  sessionId: string,
  message: AgentMessageDto
): Partial<AgentState> {
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
}

export function createAgentSessionMessageActions(
  deps: AgentSessionActionsDeps
): AgentSessionMessageActions {
  const { apiClient, notifications, set, history } = deps;

  function reportError(error: unknown): void {
    reportActionError(notifications, error);
  }

  return {
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
          set((prev) => applySentMessage(prev, sessionId, message));
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
  };
}
