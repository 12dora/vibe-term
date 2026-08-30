import type {
  AgentConfirmationDto,
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
} from '@tmex/shared';
import {
  AgentAwaitingConfirmationError,
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  AgentQueuedMessageNotFoundError,
  AgentSessionBusyError,
  AgentSessionNotFoundError,
  AgentSessionOrphanedError,
} from '../agent/supervisor';
import type {
  AgentConfirmationRecord,
  AgentMessageRecord,
  AgentQueuedMessageRecord,
  AgentSessionRecord,
} from '../db/agent';
import { t } from '../i18n';
import { json } from './http';

export function toSessionDto(record: AgentSessionRecord): AgentSessionDto {
  return {
    id: record.id,
    title: record.title,
    nodeId: record.nodeId,
    deviceId: record.deviceId,
    paneId: record.paneId,
    providerId: record.providerId,
    modelId: record.modelId,
    systemPrompt: record.systemPrompt,
    writeMode: record.writeMode,
    useProviderWebSearch: record.useProviderWebSearch,
    providerHostedTools: record.providerHostedTools ?? [],
    allowControlChars: record.allowControlChars,
    originPaneTitle: record.originPaneTitle,
    originProcessName: record.originProcessName,
    status: record.status,
    lastError: record.lastError,
    maxStepsPerTurn: record.maxStepsPerTurn,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toMessageDto(record: AgentMessageRecord): AgentMessageDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
  };
}

export function toQueuedDto(record: AgentQueuedMessageRecord): AgentQueuedMessageDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    text: record.text,
    createdAt: record.createdAt,
  };
}

export function toConfirmationDto(record: AgentConfirmationRecord): AgentConfirmationDto {
  return {
    id: record.id,
    sessionId: record.sessionId,
    toolName: record.toolName,
    toolCallId: record.toolCallId,
    input: record.inputJson,
    status: record.status,
    reason: record.reason,
    decidedAt: record.decidedAt,
    createdAt: record.createdAt,
  };
}

export function mapSupervisorError(error: unknown): Response {
  if (error instanceof AgentSessionNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentConfirmationNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentSessionBusyError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentAwaitingConfirmationError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentConfirmationAlreadyDecidedError) {
    return json({ error: error.message }, 409);
  }
  if (error instanceof AgentQueuedMessageNotFoundError) {
    return json({ error: error.message }, 404);
  }
  if (error instanceof AgentSessionOrphanedError) {
    return json({ error: error.message }, 409);
  }
  console.error('[api/agent] unexpected error:', error);
  return json(
    { error: error instanceof Error ? error.message : t('apiError.invalidRequest') },
    500
  );
}
