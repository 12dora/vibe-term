import type { AgentEventPayloadMap } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { toErrorMessage } from './retry-policy';
import type { StreamPartHandlers } from './stream-part-router';

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface RunStreamDeltaSink {
  queueTextDelta(messageId: string, delta: string): void;
  queueReasoningDelta(messageId: string, delta: string): void;
  flush(): void;
}

export function createRunStreamHandlers(params: {
  deltas: RunStreamDeltaSink;
  broadcast: <K extends keyof AgentEventPayloadMap>(
    eventType: K,
    payload: AgentEventPayloadMap[K]
  ) => void;
  approvals: PendingApproval[];
  onError: (error: unknown) => void;
  onAbort: () => void;
}): StreamPartHandlers {
  return {
    'text-delta': (part) => {
      params.deltas.queueTextDelta(part.id, part.text);
    },
    'reasoning-delta': (part) => {
      params.deltas.queueReasoningDelta(part.id, part.text);
    },
    'tool-call': (part) => {
      params.deltas.flush();
      params.broadcast(wsBorsh.AGENT_EVENT_TOOL_CALL, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
    },
    'tool-result': (part) => {
      params.deltas.flush();
      params.broadcast(wsBorsh.AGENT_EVENT_TOOL_RESULT, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
      });
    },
    'tool-error': (part) => {
      params.deltas.flush();
      params.broadcast(wsBorsh.AGENT_EVENT_TOOL_RESULT, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: toErrorMessage(part.error),
        isError: true,
      });
    },
    'tool-output-denied': (part) => {
      params.deltas.flush();
      params.broadcast(wsBorsh.AGENT_EVENT_TOOL_RESULT, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: 'execution denied by user',
        isError: true,
      });
    },
    'tool-approval-request': (part) => {
      params.approvals.push({
        approvalId: part.approvalId,
        toolCallId: part.toolCall.toolCallId,
        toolName: part.toolCall.toolName,
        input: part.toolCall.input,
      });
    },
    error: (part) => {
      params.onError(part.error);
    },
    abort: () => {
      params.onAbort();
    },
  };
}
