// 工具确认域动作：本地乐观移除 + 冲突时静默重拉 pending 列表。

import { decideAgentConfirmation, fetchAgentConfirmations } from '@tmex/api-client';
import { type AgentSessionActionsDeps, reportActionError } from './agent-session-deps';
import type { AgentActions } from './agent-state';

export type AgentSessionConfirmationActions = Pick<AgentActions, 'decideConfirmation'>;

export function createAgentSessionConfirmationActions(
  deps: AgentSessionActionsDeps
): AgentSessionConfirmationActions {
  const { apiClient, notifications, set } = deps;

  function removeLocally(sessionId: string, confirmationId: string): void {
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
  }

  async function refreshPending(sessionId: string): Promise<void> {
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
  }

  return {
    async decideConfirmation(sessionId, confirmationId, approved, reason) {
      try {
        const decided = await decideAgentConfirmation(confirmationId, approved, reason, apiClient);
        removeLocally(sessionId, confirmationId);
        if (decided === 'conflict') {
          // 已被别端决定：静默刷新 pending 列表
          await refreshPending(sessionId);
        }
      } catch (error) {
        reportActionError(notifications, error);
      }
    },
  };
}
