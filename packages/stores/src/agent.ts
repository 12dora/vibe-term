// Agent 会话 store 组合根：装配订阅、事件路由、历史同步、REST 动作，产出 zustand store。
// 模式仿 tmux.ts：模块级 initialized 防重入、client.onMessage 独立 handler、READY 重连补发订阅。

import type { AgentSessionDto, AgentSessionStatus } from '@tmex/shared';
import { buildAgentSubscribe, buildAgentUnsubscribe } from '@tmex/ws-client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createAgentDeltaBuffer } from './agent-delta-buffer';
import { type AgentEventContext, handleAgentEventMessage } from './agent-event-router';
import { createAgentHistorySync } from './agent-history-sync';
import { activeSessionIds } from './agent-node-state';
import { AGENT_PERSIST_VERSION, migrateAgentPersistedState } from './agent-persist';
import { createAgentSessionActions } from './agent-session-actions';
import { type AgentState, createInitialAgentStateData } from './agent-state';
import type { RuntimeCore } from './runtime';

export type {
  AgentActions,
  AgentState,
  AgentStateData,
  CreateSessionOptions,
  DraftSession,
  PendingConfirmationUi,
  StartDraftInput,
} from './agent-state';

export function createAgentStore(core: RuntimeCore, disposers: Array<() => void> = []) {
  let initialized = false;

  // 已订阅 session 集合：READY 重连后重发订阅
  const subscribedSessions = new Set<string>();

  function sendSubscribe(sessionId: string): void {
    const msg = buildAgentSubscribe(sessionId);
    core.client.send(msg.kind, msg.payload);
  }

  function sendUnsubscribe(sessionId: string): void {
    const msg = buildAgentUnsubscribe(sessionId);
    core.client.send(msg.kind, msg.payload);
  }

  return create<AgentState>()(
    persist(
      (set, get) => {
        const history = createAgentHistorySync({ apiClient: core.apiClient, set, get });
        const deltas = createAgentDeltaBuffer(set);

        function subscribeSession(sessionId: string): void {
          subscribedSessions.add(sessionId);
          sendSubscribe(sessionId);
        }

        function unsubscribeSession(sessionId: string): void {
          if (!subscribedSessions.delete(sessionId)) return;
          sendUnsubscribe(sessionId);
        }

        function clearSessionRuntime(sessionId: string): void {
          history.clearSession(sessionId);
          deltas.clearSession(sessionId);
        }

        const eventContext: AgentEventContext = {
          set,
          get,
          notifications: core.notifications,
          t: core.t,
          deltas,
          history,
          loadSessions: () => {
            void get().loadSessions();
          },
          refreshSession: (sessionId) => {
            void get().refreshSession(sessionId);
          },
        };

        function setupClientHandlers(): void {
          if (initialized) return;
          initialized = true;

          const client = core.client;

          disposers.push(client.onMessage((msg) => handleAgentEventMessage(eventContext, msg)));

          // 重连后 send 队列不可靠（上限 100 且断线期间事件已丢），READY 时重发订阅 + 增量补史
          disposers.push(
            client.onStateChange((state) => {
              if (state !== 'READY') return;
              for (const sessionId of subscribedSessions) {
                sendSubscribe(sessionId);
              }
              // 每个 node 的当前会话各自补史：断线期间的增量都要补上
              for (const sessionId of activeSessionIds(get())) {
                void get().loadHistory(sessionId);
              }
            })
          );
        }

        return {
          ...createInitialAgentStateData(),
          ...createAgentSessionActions({
            apiClient: core.apiClient,
            notifications: core.notifications,
            set,
            get,
            history,
            subscribe: subscribeSession,
            unsubscribe: unsubscribeSession,
            clearSessionRuntime,
          }),

          ensureInitialized() {
            setupClientHandlers();
            core.client.connect();
            for (const sessionId of activeSessionIds(get())) {
              if (!subscribedSessions.has(sessionId)) subscribeSession(sessionId);
            }
          },
        };
      },
      {
        name: `${core.storagePrefix}tmex-agent`,
        version: AGENT_PERSIST_VERSION,
        migrate: migrateAgentPersistedState,
        partialize: (state) => ({
          activeSessionIdByNode: state.activeSessionIdByNode,
          defaultWriteMode: state.defaultWriteMode,
        }),
      }
    )
  );
}

export type AgentStore = ReturnType<typeof createAgentStore>;

export type { AgentSessionDto, AgentSessionStatus };
