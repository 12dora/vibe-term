// AGENT_EVENT 分发：按 eventType 查表调用处理函数，每个处理函数只做一件事的状态迁移。

import type { NotificationSink, TranslateFn } from '@tmex/notifications';
import type { AgentEventPayloadMap, AgentEventType } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { BorshMessage } from '@tmex/ws-client';
import type { AgentDeltaBuffer } from './agent-delta-buffer';
import type { AgentHistorySync } from './agent-history-sync';
import type { AgentDataGetState, AgentDataSetState } from './agent-state';
import { emptyInProgress, maxMessageSeq, unwrapToolOutput } from './agent-thread';

export interface AgentEventContext {
  set: AgentDataSetState;
  get: AgentDataGetState;
  notifications: NotificationSink;
  t: TranslateFn;
  deltas: AgentDeltaBuffer;
  history: AgentHistorySync;
  /** 本地未知 session 时的全量列表兜底 */
  loadSessions: () => void;
  /** session 元数据（标题等）变化后的单条刷新 */
  refreshSession: (sessionId: string) => void;
}

export type AgentEventHandler<K extends AgentEventType> = (
  ctx: AgentEventContext,
  sessionId: string,
  payload: AgentEventPayloadMap[K]
) => void;

export type AgentEventHandlerMap = {
  [K in AgentEventType]: AgentEventHandler<K>;
};

const handleSync: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_SYNC> = (
  ctx,
  sessionId,
  payload
) => {
  // SYNC 重置 inProgress 后，缓冲里的旧 delta 不应再回流重复显示
  ctx.deltas.clearSession(sessionId);
  ctx.set((prev) => {
    const session = prev.sessions[sessionId];
    const inProgress = emptyInProgress();
    if (payload.inProgressText) {
      inProgress.texts.push({
        messageId: '__sync__',
        text: payload.inProgressText,
        stale: false,
      });
    }
    if (payload.inProgressReasoning) {
      inProgress.reasonings.push({
        messageId: '__sync_reasoning__',
        text: payload.inProgressReasoning,
        stale: false,
      });
    }
    return {
      sessions: session
        ? {
            ...prev.sessions,
            [sessionId]: { ...session, status: payload.status, lastError: payload.lastError },
          }
        : prev.sessions,
      inProgress: { ...prev.inProgress, [sessionId]: inProgress },
      pendingConfirmations: {
        ...prev.pendingConfirmations,
        [sessionId]: payload.pendingConfirmations.map((confirmation) => ({
          id: confirmation.confirmationId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          input: confirmation.input,
          createdAt: confirmation.createdAt,
        })),
      },
      queued: {
        ...prev.queued,
        [sessionId]: payload.queuedMessages.map((item) => ({
          id: item.id,
          sessionId,
          seq: item.seq,
          text: item.text,
          createdAt: item.createdAt,
        })),
      },
    };
  });

  const state = ctx.get();
  if (
    payload.lastMessageSeq > maxMessageSeq(state.messages[sessionId]) ||
    !state.historyLoaded[sessionId]
  ) {
    void ctx.history.loadHistory(sessionId);
  }
};

const handleStatus: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_STATUS> = (
  ctx,
  sessionId,
  payload
) => {
  const known = Boolean(ctx.get().sessions[sessionId]);
  ctx.set((prev) => {
    const session = prev.sessions[sessionId];
    if (!session) return prev;
    return {
      sessions: {
        ...prev.sessions,
        [sessionId]: {
          ...session,
          status: payload.status,
          lastError: payload.lastError !== undefined ? payload.lastError : session.lastError,
        },
      },
    };
  });
  if (!known) {
    // 本地未知 session（如别端新建），全量拉列表兜底
    ctx.loadSessions();
    return;
  }
  // 标题自动生成等 session 元数据变化也通过 STATUS 通知，单拉该 session 保持同步
  ctx.refreshSession(sessionId);
};

const handleTextDelta: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_TEXT_DELTA> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.deltas.append(sessionId, 'texts', payload.messageId, payload.delta);
  ctx.deltas.schedule();
};

const handleReasoningDelta: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_REASONING_DELTA> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.deltas.append(sessionId, 'reasonings', payload.messageId, payload.delta);
  ctx.deltas.schedule();
};

const handleToolCall: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_TOOL_CALL> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.deltas.flush();
  ctx.set((prev) => {
    const current = prev.inProgress[sessionId] ?? emptyInProgress();
    const toolCalls = [...current.toolCalls];
    const index = toolCalls.findIndex((call) => call.toolCallId === payload.toolCallId);
    const next = {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      input: payload.input,
      isError: false,
      denied: false,
      resolved: false,
      stale: false,
    };
    if (index >= 0) {
      toolCalls[index] = { ...toolCalls[index], ...next };
    } else {
      toolCalls.push(next);
    }
    return {
      inProgress: { ...prev.inProgress, [sessionId]: { ...current, toolCalls } },
    };
  });
};

const handleToolResult: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_TOOL_RESULT> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.deltas.flush();
  const { value, isError, denied } = unwrapToolOutput(payload.output);
  ctx.set((prev) => {
    const current = prev.inProgress[sessionId] ?? emptyInProgress();
    const toolCalls = [...current.toolCalls];
    const index = toolCalls.findIndex((call) => call.toolCallId === payload.toolCallId);
    if (index >= 0) {
      toolCalls[index] = {
        ...toolCalls[index],
        output: value,
        isError: Boolean(payload.isError) || isError,
        denied,
        resolved: true,
      };
    } else {
      toolCalls.push({
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        input: undefined,
        output: value,
        isError: Boolean(payload.isError) || isError,
        denied,
        resolved: true,
        stale: current.staleBarrier,
      });
    }
    return {
      inProgress: { ...prev.inProgress, [sessionId]: { ...current, toolCalls } },
    };
  });
};

const handleConfirmationRequest: AgentEventHandler<
  typeof wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST
> = (ctx, sessionId, payload) => {
  ctx.set((prev) => {
    const list = prev.pendingConfirmations[sessionId] ?? [];
    if (list.some((confirmation) => confirmation.id === payload.confirmationId)) {
      return prev;
    }
    return {
      pendingConfirmations: {
        ...prev.pendingConfirmations,
        [sessionId]: [
          ...list,
          {
            id: payload.confirmationId,
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            input: payload.input,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    };
  });
};

const handleConfirmationResolved: AgentEventHandler<
  typeof wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED
> = (ctx, sessionId, payload) => {
  ctx.set((prev) => {
    const list = prev.pendingConfirmations[sessionId];
    if (!list || !list.some((confirmation) => confirmation.id === payload.confirmationId)) {
      return prev;
    }
    return {
      pendingConfirmations: {
        ...prev.pendingConfirmations,
        [sessionId]: list.filter((confirmation) => confirmation.id !== payload.confirmationId),
      },
    };
  });
};

const handleMessagePersisted: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.deltas.flush();
  if (payload.role === 'assistant' || payload.role === 'tool') {
    // 已落库内容对应的流式段标记 stale，等增量拉取落地后清除
    ctx.set((prev) => {
      const current = prev.inProgress[sessionId];
      if (!current) return prev;
      return {
        inProgress: {
          ...prev.inProgress,
          [sessionId]: {
            texts: current.texts.map((segment) => ({ ...segment, stale: true })),
            reasonings: current.reasonings.map((segment) => ({ ...segment, stale: true })),
            toolCalls: current.toolCalls.map((call) =>
              call.resolved ? { ...call, stale: true } : call
            ),
            staleBarrier: true,
          },
        },
      };
    });
  }
  ctx.history.scheduleFetch(sessionId);
};

const handleTurnFinished: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_TURN_FINISHED> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.deltas.flush();
  ctx.set((prev) => {
    const session = prev.sessions[sessionId];
    return {
      sessions: session
        ? { ...prev.sessions, [sessionId]: { ...session, status: payload.sessionStatus } }
        : prev.sessions,
      inProgress: { ...prev.inProgress, [sessionId]: emptyInProgress() },
    };
  });
  if (payload.lastMessageSeq > maxMessageSeq(ctx.get().messages[sessionId])) {
    ctx.history.scheduleFetch(sessionId);
  }
};

const handleErrorEvent: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_ERROR> = (
  ctx,
  sessionId,
  payload
) => {
  const session = ctx.get().sessions[sessionId];
  ctx.notifications.error(ctx.t('agent.toast.errorTitle', { title: session?.title ?? 'Agent' }), {
    description: payload.message,
  });
};

const handleCredentialWarning: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_CREDENTIAL_WARNING> = (
  ctx,
  _sessionId,
  payload
) => {
  ctx.notifications.warning(ctx.t('agent.toast.credentialWarningTitle'), {
    description: ctx.t('agent.toast.credentialWarningDescription', {
      types: payload.types.join(', '),
    }),
    duration: 10000,
  });
};

const handleQueueUpdated: AgentEventHandler<typeof wsBorsh.AGENT_EVENT_QUEUE_UPDATED> = (
  ctx,
  sessionId,
  payload
) => {
  ctx.set((prev) => ({
    queued: {
      ...prev.queued,
      [sessionId]: payload.queued.map((item) => ({
        id: item.id,
        sessionId,
        seq: item.seq,
        text: item.text,
        createdAt: item.createdAt,
      })),
    },
  }));
};

export const agentEventHandlers: AgentEventHandlerMap = {
  [wsBorsh.AGENT_EVENT_SYNC]: handleSync,
  [wsBorsh.AGENT_EVENT_STATUS]: handleStatus,
  [wsBorsh.AGENT_EVENT_TEXT_DELTA]: handleTextDelta,
  [wsBorsh.AGENT_EVENT_REASONING_DELTA]: handleReasoningDelta,
  [wsBorsh.AGENT_EVENT_TOOL_CALL]: handleToolCall,
  [wsBorsh.AGENT_EVENT_TOOL_RESULT]: handleToolResult,
  [wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST]: handleConfirmationRequest,
  [wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED]: handleConfirmationResolved,
  [wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED]: handleMessagePersisted,
  [wsBorsh.AGENT_EVENT_ERROR]: handleErrorEvent,
  [wsBorsh.AGENT_EVENT_TURN_FINISHED]: handleTurnFinished,
  [wsBorsh.AGENT_EVENT_CREDENTIAL_WARNING]: handleCredentialWarning,
  [wsBorsh.AGENT_EVENT_QUEUE_UPDATED]: handleQueueUpdated,
};

type UntypedAgentEventHandler = (
  ctx: AgentEventContext,
  sessionId: string,
  payload: unknown
) => void;

const handlerTable = agentEventHandlers as unknown as Record<
  number,
  UntypedAgentEventHandler | undefined
>;

/** 返回是否命中处理函数；未知 eventType 静默忽略（前后端可独立升级） */
export function dispatchAgentEvent(
  ctx: AgentEventContext,
  eventType: number,
  sessionId: string,
  payload: unknown
): boolean {
  const handler = handlerTable[eventType];
  if (!handler) return false;
  handler(ctx, sessionId, payload);
  return true;
}

/** 解码 AGENT_EVENT 帧并分发；非 AGENT_EVENT 或解码失败时不产生状态变化 */
export function handleAgentEventMessage(ctx: AgentEventContext, msg: BorshMessage): void {
  if (msg.kind !== wsBorsh.KIND_AGENT_EVENT) {
    return;
  }

  let decoded: { sessionId: string; eventType: number; payload: Uint8Array };
  try {
    decoded = wsBorsh.decodePayload(wsBorsh.schema.AgentEventSchema, msg.payload);
  } catch (error) {
    console.error('[agent] failed to decode AGENT_EVENT:', error);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded.payload));
  } catch (error) {
    console.error('[agent] failed to parse AGENT_EVENT payload:', error);
    return;
  }

  dispatchAgentEvent(ctx, decoded.eventType, decoded.sessionId, payload);
}
