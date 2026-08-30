import type { AgentEventPayloadMap, EventType } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { type AgentSessionRecord, appendAgentMessage, createAgentConfirmation } from '../db/agent';
import { t } from '../i18n';
import type { AgentStopReason } from './outcome-resolver';
import { NODE_OFFLINE_ERROR } from './outcome-resolver';
import type { PendingApproval } from './run-stream-handlers';

export type AgentRunOutcome = 'idle' | 'waiting_confirmation' | 'stopped' | 'interrupted' | 'error';

export interface RunFinishSink {
  sessionId: string;
  terminalFatal: boolean;
  terminalFatalMessage: string;
  stopReason: AgentStopReason | null;
  clearTimer(): void;
  consumeInProgressText(): string;
  lastMessageSeq(): number;
  setStatus(status: AgentSessionRecord['status'], lastError?: string | null): void;
  broadcast<K extends keyof AgentEventPayloadMap>(
    eventType: K,
    payload: AgentEventPayloadMap[K]
  ): void;
  notify(eventType: EventType, session: AgentSessionRecord, payload: Record<string, unknown>): void;
}

export function persistTruncatedAssistantText(sink: RunFinishSink): void {
  const text = sink.consumeInProgressText();
  if (!text) {
    return;
  }
  try {
    const record = appendAgentMessage(sink.sessionId, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text }],
      truncated: true,
    });
    sink.broadcast(wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED, {
      messageId: record.id,
      seq: record.seq,
      role: record.role,
    });
  } catch (error) {
    console.error(`[agent-run] failed to persist truncated text for ${sink.sessionId}:`, error);
  }
}

export function finishIdleRun(
  sink: RunFinishSink,
  session: AgentSessionRecord,
  notifyTurnFinished: boolean
): AgentRunOutcome {
  sink.setStatus('idle');
  sink.broadcast(wsBorsh.AGENT_EVENT_TURN_FINISHED, {
    sessionStatus: 'idle',
    lastMessageSeq: sink.lastMessageSeq(),
  });
  if (notifyTurnFinished) {
    sink.notify('agent_turn_finished', session, {
      message: t('notification.agent.turnFinished', { title: session.title }),
    });
  }
  return 'idle';
}

export function finishWaitingConfirmationRun(
  sink: RunFinishSink,
  session: AgentSessionRecord,
  approvals: PendingApproval[]
): AgentRunOutcome {
  for (const approval of approvals) {
    const confirmation = createAgentConfirmation({
      id: approval.approvalId,
      sessionId: sink.sessionId,
      toolName: approval.toolName,
      toolCallId: approval.toolCallId,
      inputJson: approval.input,
    });
    sink.broadcast(wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST, {
      confirmationId: confirmation.id,
      toolCallId: confirmation.toolCallId,
      toolName: confirmation.toolName,
      input: confirmation.inputJson,
    });
  }
  sink.setStatus('waiting_confirmation');
  for (const approval of approvals) {
    sink.notify('agent_confirmation_pending', session, {
      message: t('notification.agent.confirmationPending', {
        title: session.title,
        toolName: approval.toolName,
      }),
      toolName: approval.toolName,
      confirmationId: approval.approvalId,
    });
  }
  return 'waiting_confirmation';
}

export function finishErrorRun(
  sink: RunFinishSink,
  session: AgentSessionRecord,
  message: string
): AgentRunOutcome {
  sink.clearTimer();
  persistTruncatedAssistantText(sink);
  sink.setStatus('error', message);
  sink.broadcast(wsBorsh.AGENT_EVENT_ERROR, { message });
  sink.notify('agent_error', session, {
    message: t('notification.agent.error', { title: session.title, message }),
  });
  return 'error';
}

export function finishAbortedRun(
  sink: RunFinishSink,
  session: AgentSessionRecord
): AgentRunOutcome {
  sink.clearTimer();
  persistTruncatedAssistantText(sink);
  if (sink.terminalFatal) {
    return finishErrorRun(sink, session, sink.terminalFatalMessage);
  }
  if (sink.stopReason === 'shutdown') {
    return 'interrupted';
  }
  if (sink.stopReason === 'pane_lost') {
    return finishErrorRun(
      sink,
      session,
      sink.terminalFatalMessage || 'terminal connection lost: pane/device unavailable'
    );
  }
  if (sink.stopReason === 'node_offline') {
    return finishErrorRun(sink, session, NODE_OFFLINE_ERROR);
  }
  sink.setStatus('stopped');
  sink.broadcast(wsBorsh.AGENT_EVENT_TURN_FINISHED, {
    sessionStatus: 'stopped',
    lastMessageSeq: sink.lastMessageSeq(),
  });
  return 'stopped';
}
